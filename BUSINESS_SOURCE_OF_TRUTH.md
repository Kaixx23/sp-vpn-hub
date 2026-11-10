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

---

## 2026-11-10 — the profile regression, and why `npm test` was not enough

Two things happened at once, and the second one hid the first.

**1. This branch had silently lost the geo-free Clash profile.** Somewhere in the
"restore production dashboard code / merge production branch" sequence
(`52e5425`, `8ea9ebd`, `b31b0e9`) `buildYaml` came back from a snapshot that
pre-dates PR #11, i.e. it emitted, unconditionally:

```yaml
  default-nameserver: [223.5.5.5, 119.29.29.29]   # China-only resolvers
  nameserver: [223.5.5.5, 119.29.29.29]
  fallback-filter:
    geoip: true                                    # forces a geoip.metadb download
  - GEOIP,PRIVATE,DIRECT                           # …same
```

That is the exact profile behind "my link works in Shadowrocket but times out in
Clash" (Shadowrocket ignores `dns:`; mihomo resolves the node hostnames with it and
waits). `arena/e009e699-sp-vpn-hub` (commit `512f396`) carries the fix: geo-free
global default, `&cn=1` opt-in, literal `IP-CIDR` private ranges with
`no-resolve`, `profile.store-selected: false`, `safeBrand()` on the brand, quota
placeholders out of the speed-test groups, `&fmt=`/`.yaml` overrides, dropped-node
announcements, and `/diag`.

**Merging did not surface it.** Git reported a conflict only in the signature line
of `buildYaml` and took this branch's body for the rest of the function — green
tests either way, because a suite written against the *reverted* profile agrees
with the reverted profile. Any future session that merges a dashboard branch into
a profile branch (or the reverse) must diff `buildYaml`, `subHeaders` and the
`/all` handler by hand, and run `test/profile-guard.test.mjs`,
`test/client-matrix.test.mjs` and `test/full-proof.mjs` **from the branch that has
them**: they are the only thing that pins the profile. `package.json`'s `test`
script is the wire that keeps them running — check it lists them after any merge.

**2. Production was not serving this branch.** On 2026-11-10 06:06 UTC
`https://sp-vpn.netlify.app/healthz?full=1` and `/diag` both answered — routes that
exist *only* on `arena/e009e699-sp-vpn-hub`. So whatever Netlify's settings say, the
build serving customers at that moment was the one with the profile fix. Read this
file's "Production branch" line as *which branch is the business*, not *which build
is live*: confirm the latter by the two commands below.

### Confirm what is actually serving customers

```bash
npm run verify -- https://sp-vpn.netlify.app --token=<a-customer-token>
```

It runs this repo's own `checkProfile` against the live response and exits
non-zero on a mismatch, distinguishing "deployment is too old to report a policy"
from "the live profile regressed". Against a live host, `curl -s <host>/healthz`
must return JSON, not `ok`.

### ⚠️ One real credential is committed

`plans.js` carries `PANEL_PASSWORD_DEFAULT` — the shared password pre-filled into
every supplier-panel account the dashboard creates. It is in Git history and in
the Add-customer form. Move it to an environment variable (and rotate it) before
this repo is ever shared, mirrored, or read by an automation you did not choose.

### Revenue on the dashboard is now a monthly, per-currency figure

`summarise()` divides each price by its billing period and never adds currencies
together — see README → *Revenue / month*. An earlier version summed face prices
and labelled the result "/ month", which overstated annual plans roughly 12x; the
test that pinned it (`test/dashboard.test.mjs`) was corrected rather than
preserved, so do not "restore" the old number.


## Do not reintroduce removed experimental local work

At the time this file was added, the live pushed branch is based on `ca9d646`. Earlier local experimental commits for a public renewal page / WeCom / ServerChan were intentionally not part of the live pushed source. Do not reintroduce them unless the owner asks for those features again.
