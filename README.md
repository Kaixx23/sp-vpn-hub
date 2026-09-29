# SP VPN Hub — supplier-leak fix + customer link registry

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

A link with **no recorded expiry is surfaced separately**, never counted as
healthy — an unknown must not hide a renewal.

`＋ Add customer` mints a link and stores name / plan / price / currency /
billing cycle / paid-until / notes in one step, returning the ready-to-send link.

### Data model

One table. The leak fix and the dashboard are the same database.

```
token            TEXT PRIMARY KEY     -- 24 random bytes, hex
supplier_url     TEXT NOT NULL        -- the secret; never leaves the server
label, customer, plan, price, currency, billing_cycle, paid_until, notes
supplier_expires, total_gb, used_gb, checked_at   -- written by /admin/refresh
revoked          INTEGER              -- 1 = link is dead
created_at       TEXT
```

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
| `/admin/refresh` | GET | Pull live quota + expiry from the supplier |
| `/admin/reminders` | GET | Reminder history (kind, date, message text) |
| `/admin/reminders` | POST | Run a reminder pass now |
| `/admin/reminders/run` | GET | Same, as a GET — for platform crons |
| `/admin/links` | GET | Registry. **Never returns `supplier_url`** — host only. |
| `/admin/link/<t>?action=revoke` | GET | Kill a link immediately |
| `/admin/link/<t>?action=rotate` | GET | Kill + reissue, carries the customer's details |
| `/admin/link/<t>?action=delete` | GET | Remove the row entirely |

| `/diag?t=<t>` | GET | Self-service diagnosis — what format *this* client gets, supplier latency, YAML sanity |

`/admin/*` has **no authentication yet** — see *Before you deploy*.

---

## Clash / Clash Mi troubleshooting

Symptom: the ONE link works in Shadowrocket, but a mihomo client (Clash Mi,
Clash Verge, FlClash, ClashX Meta…) shows a **timeout** on import or every node
times out after importing.

There are only three possible causes, and each has a switch:

1. **The client got the wrong format.** Clash cores can only read mihomo YAML; a
   base64 node list makes them fail with a parse/timeout style error. Format is
   picked from the `User-Agent`, so a client with an unusual UA needs an
   explicit hint:

   ```
   https://<host>/all/SP%20VPN?t=<token>&fmt=yaml     # always YAML
   https://<host>/all/SP%20VPN.yaml?t=<token>         # same, via extension
   https://<host>/all/SP%20VPN?t=<token>&fmt=sr       # always base64
   ```

2. **The profile needed a GeoIP download before it could connect.** The old
   generator always emitted `GEOIP,CN` / `GEOIP,PRIVATE` rules and
   `dns.fallback-filter.geoip: true`. On a fresh install the core must first
   download the GeoIP database *through the network the user cannot reach yet*,
   which surfaces as a timeout. The default profile is now **geo-free**
   (private ranges are literal `IP-CIDR` rules).

3. **The profile pinned China-only DNS.** `223.5.5.5` / `119.29.29.29` are only
   fast inside China; anywhere else they are slow or dropped, and since mihomo
   resolves the node hostnames with them, *every* connection and latency test
   times out even though the profile imported fine. The default profile now
   uses `1.1.1.1 / 8.8.8.8 / 9.9.9.9` and sets `proxy-server-nameserver`.

   Really on a Chinese ISP? Append **`&cn=1`** to get the old CN-optimized
   profile (CN resolvers, `GEOIP,CN,DIRECT`, background geodata updates).

### A whole family of nodes shows "connect error"

That is upstream, not the profile: those nodes share one hostname and it is
unreachable (supplier down, host blocked by the ISP, or a CDN front that got
banned). `/diag?t=<token>` lists nodes per server host, which makes a dead
family obvious at a glance.

Two mitigations ship in the profile:

* `lazy: true` + `expected-status: 204` + `max-failed-times: 3` on the auto /
  failover groups, so the core stops dialling dead nodes it isn't using.
* **`&exclude=<regex>` / `&include=<regex>`** (case-insensitive, matched on the
  English node name) build a profile from the nodes that still work:

  ```
  https://<host>/all/SP%20VPN?t=<token>&fmt=yaml&exclude=telecom
  https://<host>/all/SP%20VPN?t=<token>&fmt=yaml&include=japan|korea
  ```

  Filtering everything out returns a clear `400` instead of a broken profile,
  and an invalid regex is ignored rather than breaking the customer's link.

Not sure which one you're hitting? Open `/diag?t=<token>` **in the failing app's
own browser/WebView** (or curl it with that app's UA) — it reports the detected
client family, the format it would be served, supplier latency and whether the
generated YAML passes mihomo's import-time checks. It never echoes the supplier
URL.

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
- `test/dashboard.test.mjs` — **42 checks**: the renewal maths in `summarise()`,
  live quota refresh, the dashboard routes, customer editing, and that no route
  ever leaks a supplier URL.
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
