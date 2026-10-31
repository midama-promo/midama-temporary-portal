# Mid-Ama Promo™ temporary distribution portal

This project retains the existing portal frontend and API logic while adding a Node.js server for Render. Cloudflare D1 remains the database, Cloudflare R2 remains private file storage, and Resend remains the OTP email provider.

> **Production warning:** This is an upgrade of the supplied starter project, not a claim that every item in the supplied 23-point test checklist has been production-verified. No live Cloudflare, Render, or Resend credentials were supplied, so live email, D1, R2, deployment, cross-account isolation, and browser acceptance tests cannot be run from this package. Complete the deployment checklist and test with non-production accounts before inviting clients.

## Architecture

- Frontend: existing static files in `public/`
- API/runtime: Node.js 20+ (`server.mjs`), suitable for Render Web Services
- Database: existing Cloudflare D1 database through the Cloudflare D1 REST API
- File storage: existing private Cloudflare R2 bucket through its S3-compatible API
- Email OTP: Resend

The original `src/worker.js`, `wrangler.toml`, and original migration are retained. The Node server adapts the existing Worker-style API to Render and does not require replacing the existing D1 database or R2 bucket.

## Render deployment

1. Push this project to a private GitHub repository.
2. In Render, create a **Web Service** from that repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Add the environment variables listed below in Render. Do not commit credentials to GitHub.
5. Deploy and check `https://YOUR-SERVICE.onrender.com/api/health` returns `{ "ok": true, ... }`.
6. Configure the custom domain `portal.midamapromo.co.za` in Render and update DNS as Render instructs.
7. Set `APP_ORIGIN` to the final HTTPS custom domain.

The included `render.yaml` describes the service and its required environment variables. Render may prompt for secret values because they are marked `sync: false`.

## Required environment variables

| Variable | Purpose |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID containing D1 and R2 |
| `CLOUDFLARE_D1_DATABASE_ID` | Existing D1 database ID; use the existing database, not a newly created one |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with permission to query the selected D1 database |
| `R2_ACCOUNT_ID` | Cloudflare account ID for the R2 S3 endpoint |
| `R2_ACCESS_KEY_ID` | R2 S3 access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret access key |
| `R2_BUCKET` | Existing R2 bucket name; supplied configuration uses `mid-ama-promo-files` |
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM` | Verified Resend sender, e.g. `Mid-Ama Promo <portal@midamapromo.co.za>` |
| `ADMIN_EMAIL` | Admin email address, currently `remoabetswemolefi@gmail.com` |
| `APP_ORIGIN` | Public HTTPS origin of the deployed portal |
| `PORT` | Optional; Render supplies this automatically |

Create an R2 S3 API token scoped to the existing bucket with object read/write permissions. The Cloudflare API token used for D1 should be scoped as narrowly as possible. Never put either token in frontend code or `wrangler.toml`.

## Database migration — preserve existing data

**Do not run `db:create`, do not drop tables, and do not reapply `0001_init.sql` to an existing production database.**

The supplied `wrangler.toml` identifies the existing database as `0c6ab22f-5a0c-45a5-9b0d-3ae461cd6642`. Confirm that this is the correct live D1 database in your Cloudflare dashboard before applying anything.

Before migration:

1. Export/backup the existing D1 database using Cloudflare's current backup/export procedure.
2. Confirm the existing schema contains the original portal tables (`users`, `otp_codes`, `sessions`, `releases`, `tracks`, `tickets`, `ticket_messages`).
3. Apply **only** `migrations/0002_profile_artists_and_metadata.sql` to that existing database. It is additive: it adds profile/metadata columns and creates artist, draft, and admin-access-audit tables. It does not drop or replace existing tables or records.
4. Verify the migration completed and existing user/release counts remain unchanged.

You can apply it with Wrangler from this directory after logging in and confirming `wrangler.toml` points at the intended existing database:

```bash
npx wrangler d1 migrations apply midama-portal --remote
```

If Wrangler reports that the original migration is not recorded in the database's migration history, stop and inspect the remote migration table first. Do not force a baseline or execute the original `0001_init.sql` over production data. Reconcile migration history with a database administrator before continuing.

## R2 configuration

- Keep the existing bucket `mid-ama-promo-files`.
- Do not delete, recreate, rename, or empty the bucket.
- Configure Render's `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` values.
- Uploads use owner-prefixed object keys (`user-id/audio/...` and `user-id/artwork/...`).
- File access should be provided through short-lived signed URLs after the API confirms the file belongs to a release visible to the requesting user.
- Verify a sample upload and download using a test account before production use.

## Resend configuration

1. Verify `midamapromo.co.za` (or the sending subdomain you choose) in Resend.
2. Publish the SPF/DKIM records Resend provides.
3. Set `RESEND_API_KEY` and `RESEND_FROM` in Render.
4. Test OTP delivery to an address you control, including expiry and incorrect-code attempts.

## Implemented in this package

- Render-compatible Node.js HTTP server and health endpoint.
- Cloudflare D1 REST API adapter and Cloudflare R2 S3 adapter.
- Existing Worker API logic retained for backward compatibility.
- Additive migration for client profile names, artist library, release pre-save/rights metadata, composer metadata, drafts, and admin access audit records.
- New-client registration collects first name, surname, primary artist name, and email before OTP verification.
- Private artist-library API and basic artist-library interface, including Spotify/Apple profile URLs and profile-creation request flags.
- Server-side MP3 signature validation; audio formats other than MP3 are rejected.
- Server-side square artwork dimension checks for PNG/JPEG and VP8X WebP; artwork must be 3000–3500 px.
- Server-side seven-day release-date validation and mandatory rights confirmation.
- Track composer full-name validation, one-or-more track enforcement, and MP3 upload requirement.
- Admin pre-save URL field and client-facing pre-save display.
- Takedown instruction modal shown only for Approved/Delivered releases.
- Audit record when an admin opens a client's release view.
- Short-lived signed download URL API for release artwork/audio.

## Known gaps / acceptance tests still required

The uploaded starter did not contain several systems in the specification. This package does **not** claim these are complete: a true full-screen three-step wizard with persistent autosave/restore and exit flow; complete saved-artist selection for release-level and track-level primary/featured credits; full admin original-file download controls and complete track-level admin metadata presentation; a complete admin account-impersonation flow with return controls; and full end-to-end UI coverage of drafts and every requested validation state. The current browser UI also needs additional accessibility, mobile, and workflow acceptance testing.

The current admin access route is a read-only client release preview with an audit record, not full account impersonation. No release deletion is provided. Do not interpret a successful syntax check as live integration or security certification.

## Local development

```bash
npm install
# Set all required environment variables in your shell or local environment file (never commit secrets).
npm run dev
```

Run `npm run check` for JavaScript syntax checks. The application requires Node.js 20 or newer.
