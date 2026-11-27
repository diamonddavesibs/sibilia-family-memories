# Family upload page

A separate, private page where approved family members upload photos. It never
touches the public sibilia.us server: uploads wait in a private Cloudflare R2
bucket until David approves them, and then `import_uploads.py` on David's
computer virus-scans and cleans each photo before `build.py` adds the album as
a new card.

## How it stays safe

- **Sign-in:** Cloudflare Access sits in front of every page. People sign in
  with a one-time code emailed to them, so there are no passwords to steal.
  The code in `functions/_middleware.js` checks Access's signed token again
  on every request and refuses anything without one, so the page fails closed.
- **Approval:** a new person can only ask for access. Nothing else works until
  David approves them on `/admin.html`. Only emails in `ADMIN_EMAILS` can
  open that page.
- **Uploads:** each file is checked by its first bytes (not its name): only
  JPEG, PNG and HEIC photos, up to 30 MB, 300 per album, 5 open albums per
  person. Files are stored as plain downloads, never served as web pages.
- **Review:** albums wait as "pending" until David approves them.
- **Cleaning (on David's PC):** `import_uploads.py` downloads approved albums
  to a quarantine folder, runs ClamAV, opens each with Pillow, and re-saves it
  as a fresh JPEG (no hidden content, no GPS). Only the clean copies are kept.

## Layout

- `public/` the two pages (`index.html` for family, `admin.html` for David)
- `functions/` Cloudflare Pages Functions: sign-in check and `/api/*`
- `lib/` the API (`api.js`) and token check (`auth.js`)
- `test/` run with `npm test` (Node 20+)

## Cloudflare settings

Pages project: root directory `upload-portal`, build command empty, build
output directory `public`.

| Setting | Value |
| --- | --- |
| R2 binding `UPLOADS` | the `sibilia-uploads` bucket |
| `TEAM_DOMAIN` | e.g. `sibilia.cloudflareaccess.com` |
| `POLICY_AUD` | the Access application's audience tag |
| `ADMIN_EMAILS` | David's email (comma-separated if more than one) |

Access application: self-hosted, domain `sibilia-uploads.pages.dev`, one
policy that allows "Everyone" with the one-time PIN login. The portal keeps its
own approved list, so Access only proves who someone is.
