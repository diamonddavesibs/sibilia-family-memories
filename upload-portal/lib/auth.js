// Checks the sign-in token that Cloudflare Access adds to every request.
// Nobody reaches the upload page without signing in through Access first;
// this code double-checks the token so a missing or forged one is refused.

let cachedKeys = null;
let cachedAt = 0;

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function defaultGetKeys(teamDomain) {
  if (cachedKeys && Date.now() - cachedAt < 10 * 60 * 1000) return cachedKeys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("could not load Access keys");
  const body = await res.json();
  cachedKeys = body.keys || [];
  cachedAt = Date.now();
  return cachedKeys;
}

/**
 * Returns the signed-in person's email, or null if the token is not valid.
 * opts: { teamDomain, aud, getKeys?, now? }
 */
export async function verifyAccessJwt(token, opts) {
  if (!token || !opts.teamDomain || !opts.aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const keys = await (opts.getKeys || defaultGetKeys)(opts.teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud)) return null;
  if (payload.iss !== `https://${opts.teamDomain}`) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (typeof payload.email !== "string" || !payload.email.includes("@")) return null;
  return payload.email.trim().toLowerCase();
}
