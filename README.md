# Mid-Ama Promo temporary distribution portal

A small private client/admin portal intended for `portal.midamapromo.co.za`, using Cloudflare Workers + static assets, D1 for portal records, R2 for uploaded media, and Resend for OTP email. It starts with an empty D1 database. The configured administrator email is elevated to admin only after successfully verifying an email OTP; no fake clients are seeded.

## Important current state

This is a starter implementation, not a deployed/production-certified service. It does not connect to or modify the existing Supabase project. Existing catalogue data is not imported. Release metadata and ticket APIs are implemented. The R2 upload API is implemented, but the release form does not yet attach uploaded artwork/audio keys to releases or expose download/playback. Ticket notifications are email-based when Resend is configured; replies are stored in the portal, but reply email notifications are not yet implemented. Review and complete the checklist below before inviting clients.

## Stack

- Cloudflare Workers: API and static frontend (free tier may be sufficient; verify current limits)
- Cloudflare D1: users, OTPs, sessions, releases, track metadata, support tickets/messages
- Cloudflare R2: audio and artwork objects
- Resend: OTP delivery and new-ticket email notification
- Custom domain: `portal.midamapromo.co.za`

## Setup

1. Install Node.js LTS and then in this directory run `npm install`.
2. Log in with `npx wrangler login`.
3. Create D1: `npx wrangler d1 create midama-portal`. Copy the returned database ID into `wrangler.toml` instead of `REPLACE_WITH_D1_DATABASE_ID`.
4. Create the R2 bucket: `npx wrangler r2 bucket create midama-portal-assets`.
5. Apply the database migration: `npx wrangler d1 migrations apply midama-portal --remote`.
6. Set secrets (never commit these):
   - `npx wrangler secret put RESEND_API_KEY`
7. Configure a verified sender domain/address in Resend. Set `RESEND_FROM` in `wrangler.toml` to that verified sender. For production, use a dedicated verified sending subdomain.
8. Set the intended domain in `APP_ORIGIN` and configure `portal.midamapromo.co.za` in Cloudflare DNS. Attach the custom domain to this Worker in the Cloudflare dashboard or via Wrangler according to your account's domain setup.
9. Test locally with `npm run dev`, then deploy with `npm run deploy`.

## Security / release checklist before inviting clients

- Set Cloudflare account rate limits/WAF rules for `/api/auth/request-otp` and add server-side per-IP limits. The current implementation has per-email resend cooldown and OTP attempt caps but not comprehensive IP-based abuse protection.
- Confirm sender domain and SPF/DKIM in Resend.
- Add a secure admin recovery process and audit log for status/royalty changes.
- Finish upload-to-release attachment UI, and enforce quotas/allowed audio formats based on your actual distribution requirements.
- Add email notifications for replies and admin status changes if required.
- Review privacy notice, retention, terms, and POPIA obligations before storing real client data.
- Configure D1 backups/export and test restore before launch.
- Do not store streaming-service passwords or payment-card details here.

## Notes

- Client records are created only after OTP verification. The first successful OTP login with `remoabetswemolefi@gmail.com` creates the admin account; no other account is pre-seeded.
- A client cannot choose their role in the UI/API. The admin email is determined by the server-side `ADMIN_EMAIL` setting.
- The portal is separate from your existing Supabase-backed website. It does not migrate existing releases or affect Supabase data.
