# SP VPN Business Source of Truth

This file exists so future AI/coding sessions know exactly which repository, branch, and deployment are used for the live SP VPN business.

## Production repository and branch

- GitHub repository: `Kaixx23/sp-vpn-hub`
- Production/business branch: `arena/01a0e3a9-sp-vpn-hub`
- Live Netlify site: `https://sp-vpn.netlify.app/`
- Baseline production commit before this instruction file was added: `ca9d646`

**Important:** For this business site, use `arena/01a0e3a9-sp-vpn-hub` as the source branch. Do not assume `main` has the live business code.

## Netlify deployment

Netlify should be connected to:

```text
Repository: Kaixx23/sp-vpn-hub
Branch: arena/01a0e3a9-sp-vpn-hub
```

If the live site does not match the code in this branch, check Netlify's deploy settings first.

## What is included in the production branch

This branch includes the working business system:

- One-link VPN subscription converter
- Opaque token system so customers cannot decode supplier URLs
- Customer/admin dashboard
- Profit / month and per-customer profit tracking
- Plan catalogue for 512GB and 1024GB plans
- Quota and expiry refresh
- Per-customer Renew / Check action
- Usage delta tracking
- Telegram reminder support through Netlify environment variables
- QR Code Maker at `/qr`
- SVG QR endpoint at `/qr/svg`
- QR buttons on generated/customer links
- Anonymous `quota-page` links separated from real customer/profit stats
- Turso/libSQL token store support for persistent production data
- Netlify Functions entry point

## Required production environment variables

Production secrets live in Netlify environment variables. Do **not** commit tokens or credentials into Git.

Admin dashboard lock (**required** — without it every `/admin` route refuses to
open, because it would otherwise expose customer data and private `?t=` tokens
to anyone with the URL):

```env
ADMIN_PASSWORD=a-long-random-password
```

Sign in at `/admin/login`; the session cookie lasts 30 days. Sign out from the
button in the dashboard header or by visiting `/admin/logout`.

Minimum required storage variables:

```env
TOKEN_STORE_URL=libsql://...
TOKEN_STORE_AUTH_TOKEN=...
NODE_VERSION=20
```

Telegram reminder variables, if reminders are enabled:

```env
REMINDER_CHANNEL=telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
REMINDER_THRESHOLDS=30,14,7,3,1
RENEW_BASE_URL=https://sp-vpn.netlify.app
```

Never paste or commit `TELEGRAM_BOT_TOKEN`, Turso tokens, or other secrets.

## Editing instructions for future AI/coding sessions

1. Work only on branch:

   ```bash
   arena/01a0e3a9-sp-vpn-hub
   ```

2. Before editing, verify:

   ```bash
   git status
   git log -3 --oneline
   git ls-remote origin arena/01a0e3a9-sp-vpn-hub
   ```

3. After changes, run:

   ```bash
   npm test
   ```

4. Push only to:

   ```bash
   git push origin arena/01a0e3a9-sp-vpn-hub
   ```

5. Do not push to `main` from Arena sessions unless the owner explicitly creates a separate merge/release process outside this session.

## Current reminder workflow

The live business is using Telegram reminders configured through Netlify.

The manual reminder trigger is:

```text
https://sp-vpn.netlify.app/admin/reminders/run
```

A cron service can call that URL daily. If adding cron/security later, prefer adding a secret query key before public automated use.

## If making a new repository

If the owner wants to move this business to a brand-new repository, copy/export the contents of branch `arena/01a0e3a9-sp-vpn-hub`, not just `main`. Then point Netlify to the new repo/branch and copy all Netlify environment variables.

## Do not reintroduce removed experimental local work

At the time this file was added, the live pushed branch is based on `ca9d646`. Earlier local experimental commits for a public renewal page / WeCom / ServerChan were intentionally not part of the live pushed source. Do not reintroduce them unless the owner asks for those features again.
