import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "../lib/auth.js";

const TEAM = "sibilia.cloudflareaccess.com";
const AUD = "aud123";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const getKeys = async () => [jwk];

async function sign(payload, kid = "k1", key = pair.privateKey) {
  const h = enc({ alg: "RS256", kid });
  const p = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64u(new Uint8Array(sig));
}

const good = () => ({ aud: [AUD], iss: "https://" + TEAM, email: "Rose@Example.com", exp: Math.floor(Date.now() / 1000) + 600 });
const opts = { teamDomain: TEAM, aud: AUD, getKeys };

test("accepts a valid Access token", async () => {
  assert.equal(await verifyAccessJwt(await sign(good()), opts), "rose@example.com");
});

test("rejects bad tokens", async () => {
  assert.equal(await verifyAccessJwt(null, opts), null);
  assert.equal(await verifyAccessJwt("a.b.c", opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good(), aud: ["other"] }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good(), exp: 1 }), opts), null);
  assert.equal(await verifyAccessJwt(await sign(good(), "k2"), opts), null);
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  assert.equal(await verifyAccessJwt(await sign(good(), "k1", other.privateKey), opts), null, "forged signature");
  const t = await sign(good());
  const [h, , s] = t.split(".");
  assert.equal(await verifyAccessJwt(h + "." + enc({ ...good(), email: "owner@example.com" }) + "." + s, opts), null, "tampered email");
  assert.equal(await verifyAccessJwt(await sign(good()), { ...opts, aud: "" }), null, "fails closed when not configured");
});
