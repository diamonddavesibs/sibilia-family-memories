// The upload portal's API. Everything is stored in one private R2 bucket
// (env.UPLOADS); nothing here is ever served on the public sibilia.us site.
//
//   members/<email>.json    family members David approved
//   requests/<email>.json   people asking for access
//   blocked/<email>.json    requests David turned down
//   albums/<id>/album.json  one upload: label, year, who, status
//   albums/<id>/photos/...  the photos as uploaded (cleaned later on David's PC)
//
// Album status: uploading -> pending (waiting for David) -> approved
//               -> published (added to the site by import_uploads.py)
//               or rejected.

export const LIMITS = {
  photoBytes: 30 * 1024 * 1024,
  photosPerAlbum: 300,
  openAlbumsPerPerson: 5,
  label: 80,
  description: 500,
  name: 60,
  note: 300,
};

const ALBUM_ID = /^[0-9]{8}-[a-z0-9]{6}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status, message) {
  return json({ error: message }, status);
}

function clean(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanYear(y) {
  if (y === null || y === undefined || y === "") return null;
  const n = Number(y);
  const max = new Date().getUTCFullYear() + 1;
  if (!Number.isInteger(n) || n < 1900 || n > max) return undefined;
  return n;
}

function validEmail(e) {
  return typeof e === "string" && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) && e.length <= 200;
}

const key = {
  member: (e) => `members/${encodeURIComponent(e)}.json`,
  request: (e) => `requests/${encodeURIComponent(e)}.json`,
  blocked: (e) => `blocked/${encodeURIComponent(e)}.json`,
  album: (id) => `albums/${id}/album.json`,
  photos: (id) => `albums/${id}/photos/`,
};

async function getJson(env, k) {
  const obj = await env.UPLOADS.get(k);
  return obj ? obj.json() : null;
}

function putJson(env, k, data) {
  return env.UPLOADS.put(k, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function listAll(env, prefix, delimiter) {
  const keys = [];
  const prefixes = [];
  let cursor;
  do {
    const page = await env.UPLOADS.list({ prefix, delimiter, cursor });
    for (const o of page.objects) keys.push(o);
    for (const p of page.delimitedPrefixes || []) prefixes.push(p);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { keys, prefixes };
}

async function listJson(env, prefix) {
  const { keys } = await listAll(env, prefix);
  const out = [];
  for (const o of keys) {
    const v = await getJson(env, o.key);
    if (v) out.push(v);
  }
  return out;
}

async function listAlbums(env) {
  const { prefixes } = await listAll(env, "albums/", "/");
  const out = [];
  for (const p of prefixes) {
    const id = p.slice("albums/".length, -1);
    if (!ALBUM_ID.test(id)) continue;
    const a = await getJson(env, key.album(id));
    if (a) out.push(a);
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return out;
}

async function deletePrefix(env, prefix) {
  const { keys } = await listAll(env, prefix);
  for (let i = 0; i < keys.length; i += 500) {
    await env.UPLOADS.delete(keys.slice(i, i + 500).map((o) => o.key));
  }
}

/** What kind of photo the bytes really are, or null. Checks the file's
 *  first bytes, not its name, so a renamed program is refused. */
export function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return { ext: "png", type: "image/png" };
  if (b.length >= 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { ext: "heic", type: "image/heic" };
    }
  }
  return null;
}

function newAlbumId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36])
    .join("");
  return `${d}-${r}`;
}

function publicAlbum(a) {
  const { id, label, year, description, ownerName, owner, status, photoCount, createdAt, submittedAt, reviewedAt, note } = a;
  return { id, label, year, description, ownerName, owner, status, photoCount, createdAt, submittedAt, reviewedAt, note };
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.startsWith("application/json")) return null;
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 10000) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleApi(request, env, user) {
  if (!user || !user.email) return fail(403, "Not signed in.");
  const url = new URL(request.url);
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  // Changes must come from the portal's own pages, not another website.
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== url.origin) return fail(403, "Request refused.");
  }

  const email = user.email;
  const member = user.admin ? { email, name: "Site owner" } : await getJson(env, key.member(email));

  // ---- Everyone signed in ----
  if (parts[0] === "me" && method === "GET") {
    const requested = member ? null : await getJson(env, key.request(email));
    const blocked = member ? null : await getJson(env, key.blocked(email));
    return json({
      email,
      admin: !!user.admin,
      member: !!member,
      name: member?.name || requested?.name || "",
      requested: !!requested,
      blocked: !!blocked,
      limits: LIMITS,
    });
  }

  if (parts[0] === "request" && method === "POST") {
    if (member) return fail(400, "You already have access.");
    if (await getJson(env, key.blocked(email))) return fail(403, "This request was not approved.");
    const body = await readBody(request);
    if (!body) return fail(400, "Bad request.");
    const name = clean(body.name, LIMITS.name);
    if (!name) return fail(400, "Please enter your name.");
    await putJson(env, key.request(email), {
      email,
      name,
      relation: clean(body.relation, LIMITS.note),
      requestedAt: new Date().toISOString(),
    });
    return json({ ok: true });
  }

  // ---- Approved family members ----
  if (parts[0] === "albums") {
    if (!member) return fail(403, "Your access has not been approved yet.");
    const id = parts[1];

    if (!id && method === "GET") {
      const mine = (await listAlbums(env)).filter((a) => a.owner === email);
      return json({ albums: mine.map(publicAlbum) });
    }

    if (!id && method === "POST") {
      const body = await readBody(request);
      if (!body) return fail(400, "Bad request.");
      const label = clean(body.label, LIMITS.label);
      if (!label) return fail(400, "Please give your album a name.");
      const year = cleanYear(body.year);
      if (year === undefined) return fail(400, "Please enter a year like 2024, or leave it blank.");
      const open = (await listAlbums(env)).filter(
        (a) => a.owner === email && (a.status === "uploading" || a.status === "pending"),
      );
      if (open.length >= LIMITS.openAlbumsPerPerson) {
        return fail(429, "You have several albums waiting already. Please wait until they are reviewed.");
      }
      const album = {
        id: newAlbumId(),
        label,
        year,
        description: clean(body.description, LIMITS.description),
        owner: email,
        ownerName: member.name,
        status: "uploading",
        photoCount: 0,
        createdAt: new Date().toISOString(),
      };
      await putJson(env, key.album(album.id), album);
      return json({ album: publicAlbum(album) }, 201);
    }

    if (!id || !ALBUM_ID.test(id)) return fail(404, "Album not found.");
    const album = await getJson(env, key.album(id));
    if (!album || album.owner !== email) return fail(404, "Album not found.");

    // PUT /api/albums/<id>/photos/<n>  (body = the photo itself)
    if (parts[2] === "photos" && parts[3] && method === "PUT") {
      if (album.status !== "uploading") return fail(409, "This album has already been sent.");
      const n = Number(parts[3]);
      if (!Number.isInteger(n) || n < 1 || n > LIMITS.photosPerAlbum) {
        return fail(400, `An album can hold up to ${LIMITS.photosPerAlbum} photos.`);
      }
      const len = Number(request.headers.get("content-length") || 0);
      if (!len || len > LIMITS.photoBytes) return fail(413, "Each photo must be under 30 MB.");
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.length > LIMITS.photoBytes || buf.length === 0) return fail(413, "Each photo must be under 30 MB.");
      const kind = sniffImage(buf);
      if (!kind) return fail(415, "Only photos (JPEG, PNG or iPhone HEIC) can be uploaded.");
      const prefix = key.photos(id);
      const num = String(n).padStart(3, "0");
      // Replace any earlier try at this slot (e.g. a retry with another type).
      const existing = await listAll(env, `${prefix}${num}.`);
      if (existing.keys.length) await env.UPLOADS.delete(existing.keys.map((o) => o.key));
      await env.UPLOADS.put(`${prefix}${num}.${kind.ext}`, buf, {
        httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment" },
        customMetadata: { name: clean(url.searchParams.get("name"), 120), by: email },
      });
      return json({ ok: true, n, type: kind.ext });
    }

    if (parts[2] === "submit" && method === "POST") {
      if (album.status !== "uploading") return fail(409, "This album has already been sent.");
      const { keys } = await listAll(env, key.photos(id));
      if (!keys.length) return fail(400, "Please add at least one photo.");
      album.status = "pending";
      album.photoCount = keys.length;
      album.submittedAt = new Date().toISOString();
      await putJson(env, key.album(id), album);
      return json({ album: publicAlbum(album) });
    }

    if (!parts[2] && method === "DELETE") {
      if (album.status !== "uploading" && album.status !== "pending") {
        return fail(409, "This album can no longer be withdrawn. Ask David to remove it.");
      }
      await deletePrefix(env, `albums/${id}/`);
      return json({ ok: true });
    }
    return fail(404, "Not found.");
  }

  // ---- Site owner only ----
  if (parts[0] === "admin") {
    if (!user.admin) return fail(403, "Only the site owner can do that.");
    const what = parts[1];

    if (what === "overview" && method === "GET") {
      const [requests, members, albums] = await Promise.all([
        listJson(env, "requests/"),
        listJson(env, "members/"),
        listAlbums(env),
      ]);
      return json({ requests, members, albums: albums.map(publicAlbum) });
    }

    if (what === "requests" && method === "POST") {
      const body = await readBody(request);
      const who = String(body?.email || "").trim().toLowerCase();
      if (!validEmail(who)) return fail(400, "Bad email.");
      const req = await getJson(env, key.request(who));
      if (body.action === "approve") {
        await putJson(env, key.member(who), {
          email: who,
          name: clean(body.name || req?.name || who.split("@")[0], LIMITS.name),
          approvedAt: new Date().toISOString(),
        });
        await env.UPLOADS.delete([key.request(who), key.blocked(who)]);
      } else if (body.action === "deny") {
        await putJson(env, key.blocked(who), { email: who, at: new Date().toISOString() });
        await env.UPLOADS.delete(key.request(who));
      } else if (body.action === "remove") {
        await env.UPLOADS.delete(key.member(who));
      } else return fail(400, "Unknown action.");
      return json({ ok: true });
    }

    if (what === "albums" && parts[2] && ALBUM_ID.test(parts[2])) {
      const id = parts[2];
      const album = await getJson(env, key.album(id));
      if (!album) return fail(404, "Album not found.");

      if (parts[3] === "photos" && !parts[4] && method === "GET") {
        const { keys } = await listAll(env, key.photos(id));
        return json({
          photos: keys.map((o) => ({ file: o.key.split("/").pop(), size: o.size })),
        });
      }

      // A preview for David's review page. Sent back only as a picture,
      // never as something the browser could run.
      if (parts[3] === "photos" && parts[4] && method === "GET") {
        const file = parts[4];
        if (!/^\d{3}\.(jpg|png|heic)$/.test(file)) return fail(404, "Not found.");
        const obj = await env.UPLOADS.get(key.photos(id) + file);
        if (!obj) return fail(404, "Not found.");
        const buf = new Uint8Array(await obj.arrayBuffer());
        const kind = sniffImage(buf);
        if (!kind) return fail(415, "Not a photo.");
        return new Response(buf, {
          headers: {
            "content-type": kind.type,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "content-disposition": "inline",
            "cache-control": "private, max-age=600",
          },
        });
      }

      if (parts[3] === "review" && method === "POST") {
        const body = await readBody(request);
        if (!body) return fail(400, "Bad request.");
        if (body.action === "approve") {
          if (album.status !== "pending" && album.status !== "rejected") return fail(409, "Only waiting albums can be approved.");
          const label = clean(body.label ?? album.label, LIMITS.label);
          if (!label) return fail(400, "The album needs a name.");
          const year = cleanYear(body.year === undefined ? album.year : body.year);
          if (year === undefined) return fail(400, "Bad year.");
          Object.assign(album, { label, year, status: "approved", reviewedAt: new Date().toISOString(), note: "" });
        } else if (body.action === "reject") {
          if (album.status === "published") return fail(409, "This album is already on the site.");
          Object.assign(album, { status: "rejected", reviewedAt: new Date().toISOString(), note: clean(body.note, LIMITS.note) });
        } else if (body.action === "delete") {
          if (album.status === "approved") return fail(409, "Reject it first, then delete.");
          await deletePrefix(env, `albums/${id}/`);
          return json({ ok: true });
        } else return fail(400, "Unknown action.");
        await putJson(env, key.album(id), album);
        return json({ album: publicAlbum(album) });
      }
    }
    return fail(404, "Not found.");
  }

  return fail(404, "Not found.");
}
