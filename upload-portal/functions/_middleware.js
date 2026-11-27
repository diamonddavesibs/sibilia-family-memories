import { verifyAccessJwt } from "../lib/auth.js";

// Runs before every page and every API call. Anything without a valid
// Cloudflare Access sign-in is turned away, so the portal fails closed
// even if the Access settings were ever switched off by mistake.
export async function onRequest(context) {
  const { request, env } = context;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  let email = null;
  try {
    email = await verifyAccessJwt(token, { teamDomain: env.TEAM_DOMAIN, aud: env.POLICY_AUD });
  } catch {
    email = null;
  }
  if (!email) {
    return new Response("Please sign in to use the Sibilia family upload page.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const admins = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  context.data.user = { email, admin: admins.includes(email) };

  const path = new URL(request.url).pathname;
  if ((path === "/admin" || path.startsWith("/admin.")) && !context.data.user.admin) {
    return new Response("This page is only for the site owner.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const res = await context.next();
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}
