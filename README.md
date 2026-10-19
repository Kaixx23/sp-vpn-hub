# SP VPN Hub — supplier-leak fix + customer link registry

> **Business source of truth**
>
> Live business repository: `Kaixx23/sp-vpn-hub`
> Live business branch: `arena/01a0e3a9-sp-vpn-hub`
> Live site: `https://sp-vpn.netlify.app/`
>
> Future AI/coding sessions should read [`BUSINESS_SOURCE_OF_TRUTH.md`](./BUSINESS_SOURCE_OF_TRUTH.md) before making changes. The live business code is on `arena/01a0e3a9-sp-vpn-hub`, not necessarily `main`.

Drop-in replacement for `sp-global` that fixes the supplier-link leak and adds a
token registry (the database your dashboard will sit on).

**Your original `sp-global` repo is untouched.** This is a separate service.

---

## The problem it fixes

Today a student's one-link is `…/all/SP%20VPN?t=<base64url of YOUR SUPPLIER URL>`.
A student copies the `?t=` value, runs `atob()` in the browser console, and has
your supplier URL — your cost basis, and the only relationship creating your
margin. Verified end-to-end with `test/leak-proof.mjs`:

```
BEFORE — sp-global as it is today
  student runs atob() on the ?t= value:
  -> "https://airport-panel.example.com/api/v1/client/subscribe?token=SUPER-SECRET-a"…
  💥 YOUR SUPPLIER URL, EXACTLY

AFTER — this fix
  -> throws: URI malformed
  ✅ not even valid base64 of anything meaningful

  original leaks supplier URL : YES 💥
  patched  leaks supplier URL : NO ✅
  patched still serves VPN    : YES ✅ (HTTP 200, valid mihomo YAML)
```

The token is now 24 random bytes (48 hex chars) that encode nothing. The
supplier URL lives only in the token store.

---

## How it works

Three moving parts, all in `token-store.js`:

**1. Minting.** When you generate a link, a random token is created and the
supplier URL is written to the store:

```
supplier URL  ──►  token store  ──►  48-char random token  ──►  the link you send
                   (server-side)
```

**2. Resolution.** When a student's app fetches `/all/…?t=<token>`, the worker
looks the token up in the store to get the supplier URL, then fetches the
supplier exactly as it always did. The request your supplier receives is
**byte-identical to before** — same URL, same three User-Agents, same budget.

**3. Legacy fallback.** A token that isn't 48 hex chars is treated as an old
base64 token and decoded the old way. **Links already in students' hands keep
working forever** — there is no cutover and nobody's VPN drops.

### New capability you didn't have before

Because tokens are now looked up rather than self-describing, they can be
killed:

```bash
# student shares their link / stops paying:
curl "$HOST/admin/link/<token>?action=revoke"     # link dies immediately

# you want to reissue:
curl "$HOST/admin/link/<token>?action=rotate"     # old dies, new one returned
```

Revocation is **immediate** — the worker checks token state on every request and
only memoises the supplier fetch. (This was a real bug in the first
implementation: the 5-minute cache ignored revocation, so a revoked student kept
working for up to 5 minutes. `test/opaque-token.test.mjs` §5 pins it.)

---

## Effect on VPN speed

**Your actual VPN speed is unaffected — not slightly, but not at all.**

Your server only serves the *node list*. Once a student's app has it, the VPN
tunnel runs **directly from their device to `hk1.example.com:443`**. Your server
is never in the data path — it carries no VPN bytes. Verified: the worker has no
socket, tunnel, or WebSocket code, only `fetch` (to the supplier) and `Response`.

What the change *does* touch is how long the app takes to load/refresh the
profile — a few times a day, not continuous. Measured with `test/bench.mjs`:

```
token -> supplier URL resolution, per call (20,000 iterations):
  legacy base64 decode : 2.4µs
  opaque store lookup  : 0.9µs

with a REAL database backend (network round-trip, typical):
  Cloudflare D1, same region   : ~1–5ms
  Turso/libSQL, same region    : ~2–10ms
  Turso/libSQL, other region   : ~30–120ms

put against a real request (400ms supplier fetch):
  D1 same region       400ms -> 403ms  (+0.8%)
  Turso same region    400ms -> 406ms  (+1.5%)
  Turso far region     400ms -> 480ms  (+20.0%)
```

And that cost only lands on a **cache miss** — once per token per 5 minutes. The
supplier fetch is 94% of a request and is completely unchanged.

**Two things to actually watch:**

- **Pick a DB region near your function.** "Far region" is the only bad row
  above. Turso lets you place replicas; D1 is automatically near the Worker.
- **Cold starts.** `sp-global` deploys to Vercel's *Node* runtime (no `runtime`
  set in `vercel.json`, no `export const runtime`), ~50-200ms cold. Adding a DB
  client makes that worse. Either deploy to Cloudflare Workers (the file is
  already a Worker, zero cold start, D1 in-process) or add
  `export const runtime = "edge"`.

**New failure point, handled:** the DB is a dependency the original stateless
design didn't have. If the store is unreachable, the worker serves the cached
payload instead of failing — so a DB blip is invisible for up to 5 minutes
rather than killing every student's VPN. Covered by `test/opaque-token.test.mjs` §8.

**Side benefit:** links get *shorter* — 116 chars → 48. Fewer mangling problems
in Telegram/WhatsApp.

---

## Dashboard

`/admin` — the customer tracker. One self-contained HTML document: no framework,
no build step, **no CDN** (it has to load on a Chinese network, and a cold start
serves one document instead of an asset waterfall).

It leads with the number that decides whether a reseller survives — **renewals**:

```
active customers · expiring ≤7d · expiring ≤30d · expired/overdue
unpaid · expiry unknown · recurring revenue · legacy links
```

Then a table sorted by expiry soonest-first: customer, plan + price, expiry
pill, quota bar, paid-until, the one-link, and copy / edit / rotate / revoke.

`⟳ Refresh quota` fetches every active subscription from the supplier and writes
back real expiry + used/total GB. That's the supplier's own
`STATUS=↑:1.23GB,↓:45.67GB,TOT:200GB Expires:2027-01-01` line, parsed by the
worker's existing `quotaSummary()` — no new parsing, and you get quota tracking
for free. Refresh runs at concurrency 6 so your supplier never sees a burst.

### Check — one customer at a time

Renewing happens on the supplier's panel, by hand, one customer at a time. The
dashboard's job is to confirm it landed. Every active row has a **Check**
button that re-reads **only that customer's** saved subscription and persists
what the supplier now reports:

```
Renewed: expiry updated to 2026-10-29     ·  Usage reset by 44.5 GB
Checked: expiry remains 2026-10-17        ·  No new usage since last check
Checked: expiry remains 2026-10-08        ·  +25.0 GB used since last check
```

It is **read-only against the supplier** — a single GET, no body, nothing can be
purchased or renewed by pressing it. It only verifies a renewal you already
completed. The global `⟳ Refresh quota` still does the same for everyone at
once; this narrows it to one row so you are not hammering the panel with 80
fetches to check one person.

### Usage change since the previous check

Each successful check compares the new used-GB against the used-GB from the
**immediately previous successful check** and persists the difference:

| Situation | Shown |
|---|---|
| used more data | `+5.0 GB used since last check` |
| unchanged | `No new usage since last check` |
| supplier reset the counter after a renewal | `Usage reset by 190.0 GB` |
| first ever successful check | nothing — there is no previous value to compare |

The comparison is stored, not computed on the fly, so it stays on screen until
that customer is next checked successfully.

**A failed check writes nothing.** If the panel is down or answers without a
parsable `STATUS=` line, the row keeps its previous expiry, quota, used-GB *and*
its previous delta, and `checked_at` is not bumped — a flaky supplier can never
destroy your last known-good numbers. That is true for the per-customer button,
the global refresh and the reminder cron alike: all three share one code path
(`renewal.js → checkCustomerRow()`).

A link with **no recorded expiry is surfaced separately**, never counted as
healthy — an unknown must not hide a renewal.

`＋ Add customer` mints a link and stores name / plan / price / currency /
billing cycle / notes in one step, returning the ready-to-send link.

### Individual and shared customers

1. Add the **first customer** as **Individual customer**. Paste the original
   supplier link and enter the **Supplier account** name or email (not a password).
2. Add the **second customer** as **Shared link**. Paste the first customer's
   SP VPN one-link, or the same registered supplier URL. The form finds and shows
   the existing supplier account automatically; you do not have to enter it again.
   Existing **Panel account email / password** fields are inherited server-side
   from the original customer too. The lookup preview does not return the password.
3. Save. Both customer rows show the **same supplier account**, while retaining
   their own name, plan, price, notes and payment record. A third customer can
   also share the second customer's link.

The new customer gets a separate opaque link backed by the **same underlying
supplier URL**, not a chain of links fetching each other. Revoking or rotating
one customer's link does not revoke the others. Quota/expiry belong to the
supplier account; shared quota is **not per-person usage**.

Accounts are matched by the complete supplier URL, **not just its hostname**:
two subscriptions on the same supplier panel stay separate. Only the account
label, host, opaque account identifier and active customer count are displayed;
the supplier URL and its secret query parameters stay on the server. You can
search by account name and filter Individual or Shared customers. Editing an
individual customer's account name renames it for the customers sharing that
supplier link without changing their payments.

### Find shared links / Find shared users (discovery only)

Two read-only buttons answer one question: *which saved customers are backed by
the same supplier subscription?*

- **Find shared links** sits above the customer table and scans **every** saved
  record, ignoring the current search box and filters. It lists each supplier
  subscription used by **two or more active customer records**.
- **Find shared users** is on every real customer row, next to its supplier
  account. It shows that customer's group, highlights the selected customer and
  states how many **other active** records share the link
  ("No other active customer records found" when none do).

Matching uses the **complete underlying supplier subscription URL** — including
its account-identifying query parameters, with fragments ignored — never the
hostname, account email/label, plan, dates, customer-type label or the
customer's outward-facing opaque link. Historical duplicates still marked
*Individual* are still grouped correctly. Older records whose saved
`supplier_url` is another customer's Hub link (`/all/…?t=`, `/sr/…?t=`,
`/q/<token>`, `/sub/<token>` — including `.yaml`/`.txt`/`.conf`/`.json`
suffixes — and `/share/<token>`) are followed in memory, including nested and
legacy base64 Hub links, until the original supplier source is found. Missing
originals, invalid links, cycles and chains deeper than eight hops are flagged
**Needs review** rather than being treated as independent subscriptions.

The scan is strictly read-only: it makes no supplier/network requests, performs
no database writes, and never renews, revokes, rotates, deletes, relabels
records or infers a payment. Revoked/rotated records are shown separately
(collapsed) and never counted as additional active people; anonymous
quota-page/seller-tool records are excluded entirely. Reports contain only safe
account metadata (label, host), customer names, plan, payment status/date and
last-checked supplier expiry — supplier URLs, upstream tokens, panel passwords
and raw matching keys never leave the server, including in errors. The dialog
explains that it finds **registered customer records, not live devices**:
someone who received a copied link but was never added to the dashboard cannot
be identified. Separating access for a shared subscription is a separate, later
task — different private Hub links do not make renewals independent while they
point at the same supplier subscription.

### Check is not Pay

- **Check** on a customer reads the supplier's current expiry and quota only.
  **Refresh quota** and scheduled reminder refreshes do the same. A later
  supplier expiry **never records payment**, even for an individual customer.
- **Pay** opens a confirmation for that customer. Confirm their **Paid until**
  date and press **Pay — mark as paid**. It changes **only that customer's**
  payment record, not the other people sharing the supplier account. This is
  bookkeeping: it does not charge anyone or renew the supplier subscription.
- New customers are **Unpaid / No payment recorded** until Pay is confirmed.
  A recorded date through today or later shows **Paid**; once that date passes,
  the customer is **Unpaid** again, regardless of the supplier expiry.
- **Mark unpaid** explicitly clears only the selected customer’s recorded date,
  useful for correcting a payment that was previously marked automatically.
- Adding/editing customer details cannot mark a payment. Existing recorded
  `paid_until` dates are preserved during upgrade; new payments go through the
  Pay action. API clients must stop sending `paid_until` to `/admin/mint` or
  `/admin/customer` and use the POST Pay route instead.

`＋ Add customer` stores the customer type / supplier account / name / plan /
price / currency / billing cycle / notes and returns the ready-to-send link.
Existing customers default to Individual; their link and recorded payment dates stay
intact. You can change their type with **edit**. Database columns are added
on startup for SQLite/Turso and D1; no destructive reset is needed.

### Data model

One table. The leak fix and the dashboard are the same database.

```
token            TEXT PRIMARY KEY     -- 24 random bytes, hex
supplier_url     TEXT NOT NULL        -- the secret; never leaves the server
label, customer, customer_type, supplier_account
plan, price, currency, billing_cycle, paid_until, notes
account_email, account_password       -- the supplier-panel login you renew with
supplier_expires, total_gb, used_gb, checked_at   -- written by a check
prev_used_gb     REAL                 -- used_gb at the previous successful check
usage_delta_gb   REAL                 -- used_gb - prev_used_gb (NULL = first check)
revoked          INTEGER              -- 1 = link is dead
created_at       TEXT
```

**Migrations are additive only.** `token-store.js` holds an `ADDED_COLUMNS` list
and runs `ALTER TABLE links ADD COLUMN` for anything missing on every boot,
guarded by `PRAGMA table_info` and a duplicate-column catch. No table is ever
dropped or recreated and no existing row is rewritten, so deploying a schema
change to a live Turso database with paying customers in it is a non-event.

The same two columns are checked in as reviewable SQL at
`migrations/001-usage-delta.sql`, should you prefer to apply them ahead of the
deploy:

```bash
turso db shell your-db < migrations/001-usage-delta.sql
# or, against whatever TOKEN_STORE_URL points at:
npm run migrate
```

`test/migration.test.mjs` proves this: it builds a database on the *previous*
production schema, fills it with production-shaped rows, boots the new store
against it, and asserts every original column and every original value is
byte-identical afterwards.

## Reminders

The reason to run any of this. A reseller doesn't lose customers to a bad VPN —
they lose them to a subscription that quietly expired and a message that
arrived two weeks late.

`reminders.js` scans active links and tells *you* what needs attention:

```
⏳ Bao Nguyen — expires in 5 days (2026-09-01).
Plan: 200GB / 1 month · USD 8.00
Quota: 15.6 / 200 GB left
Paid until: 2026-09-07
```

Six kinds: `expiry_30/14/7/3/1`, `expired`, `unpaid`, `unknown` (no expiry on
record), `legacy` (still on a revocable-incapable base64 link).

**It is idempotent**, which is the whole design. State is persisted per
`(token, kind, day)`, so an hourly cron sends the same "7 days left" message
**once**, not 24 times. Tomorrow it fires again — renewals don't get forgotten.

A link that jumps from 20 days to 2 days between runs fires exactly **one**
reminder, for the tightest threshold crossed.

**Delivery failure never loses a reminder.** If Telegram returns 401, the pass
records the failure, does *not* mark it sent, and keeps going — so one dead
token can't hide your other customers' renewals, and the next run retries.

Channels: `telegram`, `webhook` (POST JSON — works with Discord/Slack/ntfy), or
`console`. Credentials are read from env, and a half-configured channel throws
at startup rather than failing silently at 3am.

### Scheduling

| Platform | How |
|---|---|
| Cloudflare Workers | `scheduled()` handler + `crons = ["0 * * * *"]` in `wrangler.toml` (already configured) |
| Vercel | `crons` in `vercel.json` → `GET /admin/reminders/run` (already configured) |
| Netlify / anything | Any scheduler hitting `GET /admin/reminders/run`, or `POST /admin/reminders` |

Configure:

```bash
REMINDER_CHANNEL=telegram      # or webhook | console
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
REMINDER_THRESHOLDS=30,14,7,3,1
```

Telegram setup: message [@BotFather](https://t.me/BotFather) → `/newbot`, then
send your bot any message and get your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

Run a pass by hand: `POST /admin/reminders`. See what's been sent:
`GET /admin/reminders`.

## Routes

Everything from `sp-global` works unchanged, plus:

| Route | Method | Purpose |
|---|---|---|
| `/admin` | GET | The dashboard |
| `/admin/dashboard.json` | GET | Stats + customers, for the client |
| `/admin/mint` | POST | `link=` + customer fields → `{ token, oneLink }` |
| `/admin/customer` | POST | Edit a customer's details |
| `/admin/refresh` | GET | Pull live quota + expiry for **every** active customer |
| `/admin/link/<t>?action=check` | GET | Check supplier expiry/quota only; `renew` remains an alias; never marks paid |
| `/admin/link/<t>?action=pay` | POST | `paid_until=YYYY-MM-DD` → record a payment for this customer only (today or later) |
| `/admin/link/<t>?action=unpaid` | POST | Explicitly clear only this customer's payment date |
| `/admin/shared-link` | POST | `link=` → find the original customer's supplier account without returning its secret URL/password |
| `/admin/shared-users` | GET | Read-only groups of customers sharing one supplier subscription (groups with ≥2 active records); `Cache-Control: no-store` |
| `/admin/shared-users?token=<customer-token>` | GET | One customer's group, including unique/revoked records and `Needs review` warnings. 404 unknown/non-customer token, 400 empty token, 405 + `Allow: GET` for other methods |
| `/admin/reminders` | GET | Reminder history (kind, date, message text) |
| `/admin/reminders` | POST | Run a reminder pass now |
| `/admin/reminders/run` | GET | Same, as a GET — for platform crons |
| `/admin/links` | GET | Registry. **Never returns `supplier_url`** — host only. |
| `/admin/link/<t>?action=revoke` | GET | Kill a link immediately |
| `/admin/link/<t>?action=rotate` | GET | Kill + reissue, carries the customer's details |
| `/admin/link/<t>?action=delete` | GET | Remove the row entirely |

`/admin/*` has **no authentication yet** — see *Before you deploy*.

---

## Local dev

```bash
npm install
npm run demo         # terminal 1: a fake supplier panel on :9911
npm run dev          # terminal 2: SQLite at ./tokens.db, http://localhost:8787
```

Then open `http://localhost:8787/admin` (dashboard) or `/tool` (the seller tool).

Mint a link from the command line:

```bash
curl -d "link=https://YOUR-SUPPLIER&customer=Ali&plan=200GB/3mo&price=15&currency=USD" \
     localhost:8787/admin/mint
```

## Tests

```bash
npm test
```

- `test/full-proof.mjs` — the original **291 checks**, unmodified, run against
  the patched worker. Proves no client broke.
- `test/opaque-token.test.mjs` — **40 checks**: leak closed, opaque links serve
  every client type, legacy links still work, revocation is immediate, rotation,
  admin redaction, DB-outage fallback.
- `test/dashboard.test.mjs` — **93 checks**: the renewal maths in `summarise()`,
  live quota refresh, the dashboard routes, customer editing, panel account
  fields, profit, health, and that no route ever leaks a supplier URL.
- `test/migration.test.mjs` — **34 checks**: the additive migration applied to a
  database built on the *previous* production schema, asserting every existing
  column and value survives byte-identically and that re-running is a no-op.
- `test/customer-accounts.test.mjs` — shared account/credential inheritance, payment isolation across checks and reminders, additive migrations and concurrent SQL updates.
- `test/dashboard-ui.test.mjs` — real client/worker interaction: original + shared customer creation, Pay/cancel/retry/Mark unpaid, safe account display and filtering.
- `test/shared-users.test.mjs` — the read-only shared-link finder: complete-URL matching (including rows mislabeled Individual), same-host/different-token separation, nested/copied/legacy Hub-link resolution, revoked/rotated/generated record handling, missing/cyclic/too-deep chains, leak and no-write/no-network guarantees, HTTP status semantics, and the real dashboard dialog (filter independence, escaping, hidden-on-load, retry, stale replies, Escape and focus restore).
- `test/renewal.test.mjs` — **151 checks**: per-customer Renew / Check (changed
  vs unchanged expiry), usage increase / unchanged / reset, no delta on the
  first check, failed checks overwriting nothing, the global refresh still
  working and persisting deltas, revoked + unknown + direct-node customers
  handled safely, the action being read-only against the supplier, and supplier
  URLs staying redacted from every admin API.
- `test/reminders.test.mjs` — **45 checks**: day maths, which reminders are due,
  cron idempotency (three passes in one day send once; tomorrow fires again),
  a dead channel not losing the reminder, and the worker routes.
- `test/leak-proof.mjs` — the before/after attack, side by side.
- `test/bench.mjs` — the latency numbers below.

## Rebuilding the patched worker

The patch is a script, not a hand edit, so you can pull in upstream fixes:

```bash
cp ../sp-global/sp-vpn-worker.js . && node bin/apply-patch.mjs
```

Every replacement is asserted — if upstream drifts, it fails loudly instead of
silently producing an un-patched worker.

---

## Deploy

**Cloudflare Workers (recommended)** — zero cold start, D1 in-process, and the
file is already a Worker:

```bash
wrangler d1 create sp-vpn-hub
# bind it as DB in wrangler.toml, then:
wrangler deploy
```

**Vercel / Netlify** — use Turso:

```bash
TOKEN_STORE_URL=libsql://your-db.turso.io
TOKEN_STORE_AUTH_TOKEN=...
```

If you stay on Vercel, add `export const runtime = "edge"` to `api/index.js` to
avoid Node cold starts.

---

## Redeploying from a brand-new repo

Nothing in this project is pinned to a particular repository, site name, domain
or account:

* every customer-facing URL is built at request time from the incoming `Host`
  header (`x-forwarded-proto` + `url.host`), so the one-links rebrand themselves
  to whatever domain serves them;
* all storage is chosen from environment variables (`TOKEN_STORE_URL`,
  `TOKEN_STORE_AUTH_TOKEN`) or a D1 binding — nothing is compiled in;
* there is no build step, no CDN and no external asset to re-point.

So a fresh repo is a copy-and-push, and the deploy is four environment
variables. See `.env.example`.

**1. Create the new repo**

```bash
# from a clean checkout of the branch you want to ship
git clone --depth 1 <this-repo> sp-vpn-hub-new && cd sp-vpn-hub-new
rm -rf .git && git init && git add -A && git commit -m "SP VPN Hub"
gh repo create <you>/<new-repo> --private --source=. --push
```

**2. Point a new Netlify site at it**

Netlify → *Add new site* → *Import an existing project* → pick the new repo.
`netlify.toml` already supplies everything: functions directory, `NODE_VERSION
20`, the esbuild bundler, `@libsql/client` kept external (it ships a native
binding esbuild cannot bundle), and the catch-all redirect to the function.
Leave the build command empty and the publish directory as-is.

**3. Choose the database**

| Goal | What to set |
|---|---|
| **Keep every existing customer** | Point `TOKEN_STORE_URL` / `TOKEN_STORE_AUTH_TOKEN` at the **same Turso database** the old site uses. The new site picks up all customers instantly — the database is the source of truth, not the repo. |
| **Start clean** | `turso db create <new-db>`, use its URL + token. The schema is created on first request. |
| **Copy the data to a new database** | `npm run backup > customers.json` against the old one, then `node bin/backup.mjs --restore customers.json` against the new one. |

Set them in Netlify → *Site configuration* → *Environment variables*, then
redeploy.

> Two sites pointed at one Turso database is fine — it is a normal shared
> SQLite server, and every write here is a single-row upsert. It is also the
> zero-downtime cutover: bring the new site up on the same database, check it,
> then move the domain.

**4. Verify before you cut over**

```bash
curl -s https://<new-site>.netlify.app/healthz                 # -> ok
curl -s https://<new-site>.netlify.app/admin/dashboard.json | head -c 200
```

The dashboard's health pill and the `store` field in `dashboard.json` name the
active backend. If it says `memory`, `TOKEN_STORE_URL` was not picked up and
customers will vanish on the next cold start — fix that before sending anyone
a link. It should read `turso`.

⚠ **`/admin/*` has no authentication.** A new public URL is a new unprotected
dashboard. See *Before you deploy*.

---

## Migration (no downtime)

1. Deploy this. **Nothing changes for existing students** — their base64 links
   keep resolving via the legacy fallback.
2. New students get opaque tokens automatically.
3. At each renewal — when you're messaging them anyway — reissue an opaque link.
4. Old links stay alive until you revoke them. No big bang.

Note: **legacy tokens cannot be revoked.** They carry their own URL, so there's
nothing to look up. That's the reason to migrate them rather than leave them.

---

## What this does NOT fix

Opaque tokens hide your **supplier URL**. They do not hide the **nodes**.

`/all/…` still returns the raw `vless://` list — server IPs, ports, UUIDs — and
Clash students get it as plaintext YAML with `server:` and `uuid:` sitting right
there. A technical student can copy a node into their own config and bypass your
URL entirely. **This cannot be fixed in your code.**

It needs per-customer node UUIDs from your supplier. Ask them:

> "Do you issue a separate subscription token per end customer, with unique node
> UUIDs per token?"

If yes, buy one subscription per student — then a student who extracts their
UUID only has their own node, and sharing it is useless. **This is the only real
margin protection in this business model**, and it's a purchasing decision, not
a build.

Also confirm whether your supplier counts quota **per token** or **pooled
across all tokens**. If pooled, one heavy student burns the group's bandwidth.

---

## Before you deploy

- **`/admin/*` is unauthenticated.** Add auth before this is public — a single
  shared secret header is enough to start.
- The token store holds your supplier URLs. Treat it as a secret: it is the one
  place the leak now lives. Restrict DB access, don't commit `tokens.db`.
