import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, sniffImage } from "../lib/api.js";
import { FakeR2 } from "./fake-r2.js";

const ORIGIN = "https://sibilia-uploads.pages.dev";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const HEIC = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

function req(method, path, body, headers = {}) {
  const init = { method, headers: { origin: ORIGIN, ...headers } };
  if (body instanceof Uint8Array) {
    init.body = body;
    init.headers["content-length"] = String(body.length);
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
    init.headers["content-length"] = String(init.body.length);
  }
  return new Request(ORIGIN + "/api/" + path, init);
}

const david = { email: "owner@example.com", admin: true };
const rose = { email: "rose@example.com", admin: false };
const stranger = { email: "x@example.com", admin: false };

async function call(env, user, ...a) {
  const res = await handleApi(req(...a), env, user);
  return { status: res.status, body: await res.json() };
}

test("sniffs photos by their bytes", () => {
  assert.equal(sniffImage(JPEG).ext, "jpg");
  assert.equal(sniffImage(HEIC).ext, "heic");
  assert.equal(sniffImage(EXE), null);
  assert.equal(sniffImage(new TextEncoder().encode("<html><script>")), null);
});

test("full flow: request, approve, upload, review", async () => {
  const env = { UPLOADS: new FakeR2() };

  let r = await call(env, rose, "GET", "me");
  assert.equal(r.body.member, false);
  r = await call(env, rose, "POST", "albums", { label: "x" });
  assert.equal(r.status, 403, "non-members cannot upload");

  r = await call(env, rose, "POST", "request", { name: "Rose <b>S</b>", relation: "cousin" });
  assert.equal(r.status, 200);
  r = await call(env, rose, "GET", "me");
  assert.equal(r.body.requested, true);

  r = await call(env, rose, "GET", "admin/overview");
  assert.equal(r.status, 403, "family cannot reach admin");
  r = await call(env, david, "GET", "admin/overview");
  assert.equal(r.body.requests.length, 1);
  assert.equal(r.body.requests[0].name, "Rose  b S /b".replace(/\s+/g, " "), "angle brackets stripped");
  r = await call(env, david, "POST", "admin/requests", { action: "approve", email: "rose@example.com", name: "Rose" });
  assert.equal(r.status, 200);

  r = await call(env, rose, "POST", "albums", { label: "Rose's 80th", year: "2025", description: "Fun day" });
  assert.equal(r.status, 201);
  const id = r.body.album.id;

  r = await call(env, rose, "PUT", `albums/${id}/photos/1?name=a.jpg`, JPEG);
  assert.equal(r.status, 200);
  r = await call(env, rose, "PUT", `albums/${id}/photos/2?name=evil.jpg`, EXE);
  assert.equal(r.status, 415, "a program renamed .jpg is refused");
  r = await call(env, rose, "PUT", `albums/${id}/photos/2?name=b.heic`, HEIC);
  assert.equal(r.status, 200);

  r = await call(env, stranger, "PUT", `albums/${id}/photos/3`, JPEG);
  assert.equal(r.status, 403, "strangers cannot add to albums");

  r = await call(env, rose, "POST", `albums/${id}/submit`, {});
  assert.equal(r.body.album.status, "pending");
  assert.equal(r.body.album.photoCount, 2);
  r = await call(env, rose, "PUT", `albums/${id}/photos/3`, JPEG);
  assert.equal(r.status, 409, "no changes after sending");

  const stored = env.UPLOADS.store.get(`albums/${id}/photos/001.jpg`);
  assert.equal(stored.opts.httpMetadata.contentType, "application/octet-stream");

  const prev = await handleApi(req("GET", `admin/albums/${id}/photos/001.jpg`), env, david);
  assert.equal(prev.headers.get("content-type"), "image/jpeg");
  assert.match(prev.headers.get("content-security-policy"), /sandbox/);

  r = await call(env, david, "POST", `admin/albums/${id}/review`, { action: "approve", label: "Rose's 80th Birthday", year: 2025 });
  assert.equal(r.body.album.status, "approved");
  assert.equal(r.body.album.label, "Rose's 80th Birthday");

  r = await call(env, rose, "GET", "albums");
  assert.equal(r.body.albums[0].status, "approved");
});

test("refuses requests from other websites", async () => {
  const env = { UPLOADS: new FakeR2() };
  const res = await handleApi(req("POST", "request", { name: "a" }, { origin: "https://evil.example" }), env, rose);
  assert.equal(res.status, 403);
});

test("denied people cannot ask again", async () => {
  const env = { UPLOADS: new FakeR2() };
  await call(env, stranger, "POST", "request", { name: "Spam" });
  await call(env, david, "POST", "admin/requests", { action: "deny", email: stranger.email });
  const r = await call(env, stranger, "POST", "request", { name: "Spam" });
  assert.equal(r.status, 403);
});

test("caps open albums per person", async () => {
  const env = { UPLOADS: new FakeR2() };
  await call(env, david, "POST", "admin/requests", { action: "approve", email: rose.email, name: "Rose" });
  for (let i = 0; i < 5; i++) assert.equal((await call(env, rose, "POST", "albums", { label: "A" + i })).status, 201);
  assert.equal((await call(env, rose, "POST", "albums", { label: "too many" })).status, 429);
});

test("adding photos to your own album", async () => {
  const env = { UPLOADS: new FakeR2() };
  await call(env, david, "POST", "admin/requests", { action: "approve", email: rose.email, name: "Rose" });
  await call(env, david, "POST", "admin/requests", { action: "approve", email: stranger.email, name: "X" });
  const { body: { album } } = await call(env, rose, "POST", "albums", { label: "Picnic", year: 2024 });
  let r = await call(env, rose, "POST", "albums", { addTo: album.id });
  assert.equal(r.status, 409, "not before the album is sent");
  await call(env, rose, "PUT", `albums/${album.id}/photos/1`, JPEG);
  await call(env, rose, "POST", `albums/${album.id}/submit`, {});
  r = await call(env, stranger, "POST", "albums", { addTo: album.id });
  assert.equal(r.status, 404, "only the owner can add");
  r = await call(env, rose, "POST", "albums", { addTo: album.id, label: "ignored" });
  assert.equal(r.status, 201);
  assert.equal(r.body.album.addTo, album.id);
  assert.equal(r.body.album.label, "Picnic");
  assert.equal(r.body.album.year, 2024);
  const extra = r.body.album.id;
  r = await call(env, rose, "POST", "albums", { addTo: extra });
  assert.equal(r.status, 404, "no add-ons of add-ons");
  await call(env, rose, "PUT", `albums/${extra}/photos/1`, JPEG);
  r = await call(env, rose, "POST", `albums/${extra}/submit`, {});
  assert.equal(r.body.album.status, "pending");
});
