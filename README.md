# SP VPN Hub — supplier-leak fix + customer link registry

> **Business source of truth**
>
> Live business repository: `Kaixx23/sp-vpn-hub`
> Live business branch: **`arena/e009e699-sp-vpn-hub`** — confirmed by the owner on 2026-11-10, and this is the branch Netlify builds.
> Live site: `https://sp-vpn.netlify.app/`
>
> Future AI/coding sessions should read [`BUSINESS_SOURCE_OF_TRUTH.md`](./BUSINESS_SOURCE_OF_TRUTH.md) before making changes. The live business code is NOT on `main`, and `arena/01a0e3a9-sp-vpn-hub` (which that file used to name) is now behind: its content is fully merged into the live branch, while its own tip still carries the pre-PR-#11 Clash profile.

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

### ⟳ Refresh data — the whole book, in pages

`⟳ Refresh data` runs the **same** check for every active customer, because a
renewal usually covers several of them at once. It used to be one request that
walked the entire book — and that is a bug the platform, not the supplier,
guarantees as the customer list grows:

> A Netlify function gets **10 seconds**. That ceiling is a *plan* setting (you
> ask Netlify support to raise it, up to ~26 s on Pro); `netlify.toml` has no
> `timeout` key for sync functions, so it cannot be fixed in the repo.

Measured against this repo's own harness (`114` customers, `CONC = 6`):

| supplier latency | one unbounded sweep | verdict at 10 s |
|---|---|---|
| 200 ms | 3.8 s | fine |
| 500 ms | 9.6 s | coin flip |
| 800 ms | 15.3 s | **killed** |

A killed request returns nothing the dashboard can interpret, so the toast said
`Refresh failed: …` and the health pill could sit on **`● supplier issue —
serving cached`** while the panel was answering every request in 112 ms. That is
the "dashboard says a supplier issue when I check my customers' data and renewal
date" report from 2026-11-10: a book-size problem wearing a supplier's face.

The sweep therefore budgets itself and pages:

```
GET /admin/refresh?after=<offset>&budget=<ms>   →  { checked, total, offset,
        remaining, next, partial, updated, failed, renewed, marked_paid, results }
```

* it stops when **1.5 s** of the request would not fit another batch, so the
  response always arrives — `next`/`remaining`/`partial` say where it got to;
* each row's own supplier fetch is bounded by what is left (`AbortSignal`), so
  **one unresponsive panel can no longer eat the whole sweep**; those rows are
  reported as failures and stay written with their previous values;
* the dashboard follows `next` in a loop, relabelling the button
  `Checking 48 of 114…`, and its toast distinguishes *cut off* from
  *the supplier refused*, naming the first customer that failed and why;
* after the sweep it forces one health re-read (`?force=1`), because the report
  is cached for 2 minutes and a pill left saying "supplier issue" after a
  successful sweep is its own false alarm.

Tuning, if you ever need it: `?budget=<ms>` (default 8000, clamped to 25000) and
`?batch=<n>` to cap batches per request. Both are for the platform's clock, not
the supplier's politeness — batches stay limited to 6 concurrent fetches either
way.

### What "58 of 96 failed" actually was

Running the first paged sweep against production on 2026-11-10 (`/admin/refresh`,
114 customers) came back `updated: 38, failed: 58` in 8 s. Reading `results[].error`
rather than the headline, those 58 were **three different problems wearing one
label**, and only one of them is the supplier's:

| the error said | what it really was |
|---|---|
| `HTTP 403 … Just a moment...` | **Cloudflare's bot wall.** 114 fetches at 6-way concurrency from one IP is a burst, and the panel's CDN answers a burst with a challenge — for everyone, right or wrong |
| `HTTP 200 with no nodes - content starts: # SP VPN — generated for your account` | **a loop-back link**: somebody saved one of OUR `/all/…` customer links into the "supplier link" field. It answers 200, with our own quota comment and no nodes, because it is asking us about ourselves |
| `HTTP 502 … (provider returned HTTP 403 …)` | a supplier panel passing its own upstream 403 through, i.e. the wall again, one layer deeper |

Three changes followed from that, all pinned by `test/renewal.test.mjs` [17]:

* **One fetch per distinct subscription.** Six customers on one 512 GB pack used to
  mean six simultaneous identical requests. `/admin/refresh` now memoises by
  `supplierKey()` for the life of the request, so a shared package costs one fetch
  and still writes each row's own usage delta. This alone cut the sweep's request
  count roughly in half on the live book.
* **A wall stops the sweep instead of drowning in it** — but only a *real* wall.
  `isThrottleResponse()` classifies 403/429/`Just a moment…`, and the sweep backs off
  once one HOST has challenged `REFRESH_THROTTLE_STOP` (2) rows. It started as
  "stop at the first challenge", and the first live run showed that was wrong: 18
  rows came back `updated: 17, throttled: 1`, and stopping there would have
  abandoned 96 customers who were answering perfectly well. A single challenged row
  is that row's problem; it keeps its old values and the sweep carries on. Every row
  still in `remaining` is *queued*, not lost, and `throttle_hosts` names which panel
  pushed back.
  The pill now reads **`● supplier throttling us — retry in a minute`** rather than
  `supplier issue`, because "wait" and "escalate" are different actions.
* **A loop-back link is refused by name, without fetching.** `422` +
  `self_referential`, with the fix in the sentence ("paste the link the SUPPLIER
  gave you"). It requires the host to be OURS: `https://panel.example/sub/…` is an
  ordinary supplier URL, and a first version that matched only the path name
  silently disabled the whole reminder pass — `customer-accounts.test.mjs` caught
  it, which is why that case is now in the suite too. Identification needs real
  proof, and there are two independent kinds — either is enough:
  * the URL is shaped like our link (48-hex token at `/sub/<t>` or `/all/<brand>?t=<t>`)
    **and** sits on the host serving the request (or any `*.netlify.app`);
  * **or** the token in it belongs to a row of the customer book — then it is a
    customer's own link whatever domain it was pasted from, and the message names
    that customer (`points_at`).

  The second proof exists because of what the live health report showed on
  2026-11-10: `checks.supplier.hosts` listed `xn--9kqs1lo79d.cc` (the branded
  domain, which proxies the panel *and* serves customer links), `sp-connect.netlify.app`
  and `sp-vpn.netlify.app`. On a domain that legitimately does both, the host tells
  you nothing — only the token does.

So the sentence the dashboard can finally tell you is which of the four it is:
*cut off by the platform clock* → click again; *throttled* → wait a minute;
*your own link saved upstream* → fix the row in Edit; *supplier refused* → only then
is it the supplier.

### Is the converted link doing anything the supplier's doesn't?

Asked directly on 2026-11-10, and the answer needed three separate proofs, because
"works" and "identical" are different claims. Layer by layer:

**The nodes: identical, and machine-proved.** `/admin/compare?a=<our link>&b=<a link
whose `t=` is the base64url of the panel URL>` fetches the original file twice plus
both converted files, normalises every node URI, and diffs all three sets. The run
behind this section: 24 links in, 24 out, **22 unique node URIs `identical: 22/22`
in both directions**, `missing_from_it: []`, `extra_in_it: []`, same order, and
**0 uri diffs between the two supplier fetches** — so nothing rotates underneath us.
Servers, ports, UUIDs, REALITY public-keys, short-ids, transport, SNI and
fingerprints pass through untouched; only display names are rebranded. And a VPN
subscription is a download-once file: traffic never flows through the converter, so
it cannot add latency or cause a timeout. That is the `note` the endpoint returns.

**The per-node config: the same fields the panel writes.** Checked by feeding the
panel's own node parameters (the `b06658de-…` uuid, `pbk=70V0gDLKL3niFsNn__…`,
`sid=3191b53b`, `sni=updates.cdn-apple.com`, `fp=safari`, `flow=xtls-rprx-vision`,
port 443) through `buildYaml` and comparing dicts. Everything matches, including two
places where **we used to look more correct than the panel** and were told the
omission was a bug: the panel omits `reality: true` (mihomo infers REALITY from
`reality-opts` + `tls: true`) and writes `flow: ''` on ws nodes. Do not "fix" either.

**The config around the nodes: one deliberate difference per line.** The panel's
header and `dns:` block were re-read line by line, and the first pass found four keys
we simply did not ship — that gap was real, and is now closed:

| key | panel | us | |
| --- | --- | --- | --- |
| `ipv6`, `dns.ipv6` | `true` | **were `false`** → now `true` | fixed. `false` came in with the geo-free profile with the reason "no v6 lookups against v4-only nodes", which was wrong: proxied destinations are resolved by the *node*, so the flag never governed node connectivity — it decides AAAA records and local/DIRECT traffic, which is what these same handsets already do on the panel's file. |
| `dns.respect-rules` | `true` | absent → now `true` | fixed, and it is not cosmetic: with `fake-ip` on, a domain matched by a DIRECT rule needs this to return its real address instead of a 198.18.x fake-ip — the classic "fake-ip broke my LAN/CN app", and live on the `?cn=1` profile where `GEOIP,CN,DIRECT` exists. |
| `dns.use-hosts` | `true` | absent → now `true` | fixed, local /etc/hosts entries win. |
| `bind-address` | `'*'` | absent (mihomo's default) → now written out | cosmetic parity. |
| `mixed-port`/`allow-lan`/`mode`/`log-level`/`unified-delay`/`tcp-concurrent`/`enhanced-mode`/`fake-ip-range` | — | identical | ✓ |
| `external-controller` | `127.0.0.1:9090` | **absent on purpose** | we never open a control API on a customer's machine from a file we push. Deliberate security deviation — do not treat it as a parity gap. |
| resolvers (global profile) | CN trio `223.5.5.5/119.29.29.29/114.114.114.114` | `1.1.1.1/8.8.8.8/9.9.9.9` | deliberate: a phone outside China resolves nothing on the CN trio. `?cn=1` opts into the CN trio + DoH fallback. |
| `dns.fallback-filter` | `{geoip: true, geosite: [gfw], …}` | `geoip: CN` on `?cn=1` only, none globally | deliberate: both need geodata the app would have to download at import — see the geo-free section in *No latency numbers*. |
| `fake-ip-filter` | absent | present | superset, harmless. |
| the two quota lines | two extra vless nodes aimed at the same server | a comment, kept out of test groups | deliberate: they are duplicate nodes, and an info row inside a test group reads as a dead node. |
| groups / names | `吹雪云` select, `自动选择` url-test 86400, `故障转移` fallback 7200 | `🚀 SP VPN` + `⚡ Auto Speed` + `🔁 Failover` + carrier lines + `🇨🇳 Direct` | the product. Probe policy is the panel's own numbers (gstatic 204, 86400/7200, no `lazy`, no `tolerance`, no `expected-status`), pinned by 92 checks in `test/profile-guard.test.mjs`. |

So: **no difference that changes which server a customer reaches or how that
connection is negotiated**, and the wrapper now differs only where we have written
down why. `X-SPVPN-Profile` ends in `;v6-parity` so `curl -i` on the link settles
it per response without opening the file; `test/profile-guard.test.mjs` pins all
five lines.

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

### Revenue / month — what the number means

The **Revenue / month** card is a *monthly run-rate*, computed per currency:

```
mrr = Σ (price ÷ months covered by that price)      separately for RMB, USD, …
```

Previously it was `Σ price` over active customers, labelled "/ month". That
number was wrong in two independent ways, and both made the business look better
than it is:

* **Face price, not monthly.** A 120 charged once a year and a 10 charged every
  month were added together. A customer you gave a 12-month discount counted as
  **12× the monthly revenue** of the customer paying you every month — so the
  more loyal your book looked, the more inflated the card was.
* **Currencies were summed.** The catalogue prices in RMB; anything typed by hand
  may be USD, VND, or nothing at all. `RMB 10 + USD 8 = 18` is not money.

The period comes from `billing_cycle`, and failing that from the plan label —
`200GB / 3mo`, `512GB 一年`, `包月`, `quarterly`, `30天` all parse
(`cycleMonths()` in `dashboard.js`). Two escape costs are shown rather than
hidden:

| You see | It means |
|---|---|
| `RMB 10 · monthly-normalised, before costs` | one currency, safe to read as a number |
| `2 currencies` + `RMB 10 · USD 8 · not summed` | the book is mixed; fix it by setting a currency on every row, there is deliberately no total |
| `1 row priced with no billing cycle (assumed monthly)` | that price was **not** monthly-checked; open the row and set the cycle |

A row whose period is unknown is **assumed monthly** — that is what this catalogue
sells, so the card stays useful while the data is thin — but it is counted in the
caption and tagged in the table (`no billing cycle → assumed monthly`) so the
assumption is yours to correct, not ours to hide.

`atRisk30` (shown as *X at risk ≤30d*) is the monthly revenue of customers whose
supplier expiry is inside 30 days or already overdue: what actually disappears if
nobody chases anyone. Revoked and system-generated rows are excluded from all of
it, as they are from customer counts.

Profit is untouched by this, and for a reason worth knowing: `profitOf()` in
`plans.js` returns `null` unless the row's currency **and** billing cycle match the
catalogue, so it was never able to make the mistake the revenue card made.

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
| `/admin/refresh` | GET | Pull live quota + expiry — one page of the book per call, `?after=`/`?budget=`/`?batch=` (see *Refresh data*) |
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

| `/sub/<token>` | GET | The Clash **auto-update** URL — always YAML, honours `&include=` / `&exclude=` / `&cn=1` / `&remember=1` like `/all`, and accepts a `.yaml` suffix on the token |
| `/admin/health` | GET | End-to-end pipeline check the dashboard pill reads: store → supplier → converter **→ is this deployment's profile policy current** (`checks.profile`, `?force=1` to bypass its 2-min cache) |
| `/diag?t=<t>` | GET | Self-service diagnosis — what format *this* client gets, supplier latency, YAML sanity, **and whether this deployment is current** |
| `/healthz` | GET | Liveness **plus profile policy**. `?full=1` for the whole fingerprint. HTTP 503 when the profile policy has regressed |

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

### ⚠️ "My link works in Shadowrocket but times out in Clash" → check the *deployed* build first

Real incident, 2026-11-10. A customer's converted link
(`https://sp-vpn.netlify.app/all/SP%20VPN?t=<48-hex>`) failed to connect in Clash
Meta / Clash Verge, while the same student's raw supplier link
(`https://xn--9kqs1lo79d.cc/api/v1/chuixue?token=…`) worked fine. **The repo was
correct and `npm test` passed.** The deployed build predated this section's fix,
so it was still emitting:

```yaml
  default-nameserver: [223.5.5.5, 119.29.29.29]   # ← China-only: every node
  nameserver: [223.5.5.5, 119.29.29.29]           #    hostname lookup times out
  fallback-filter:                                #    abroad
    geoip: true                                   # ← needs geoip.metadb, which
rules:                                            #    a fresh install cannot fetch
  - GEOIP,PRIVATE,DIRECT
  - GEOIP,CN,DIRECT
# no proxy-server-nameserver, no profile.store-selected:false
# quota pseudo-nodes ("剩余流量" → "Remaining 511.99 GB") listed inside ⚡ Auto Speed
```

Both payloads were otherwise **byte-identical after translation** — same 24 links,
same Reality `pbk`/`sid`/`sni`/`fp`, same ws `Host`+`path` — which is how you can
tell a profile bug from a node bug. The supplier URL never appears in the response.

**The lesson: a liveness probe cannot catch this.** `GET /healthz` returned `ok`
for a build that was breaking every Clash customer. So the profile is now
self-reporting and externally auditable:

| Signal | What it answers |
|---|---|
| `GET /healthz` | `{"ok":true,"profile":"geo-free;global-dns;auto-speed;re-armed;probe-advertised"}` — and **HTTP 503** when the policy regresses, so uptime checks fail on their own. `probe-advertised` is the latency fix: `probe-hidden` means the build is probing mihomo's default URL and the app will show no ping numbers |
| `GET /healthz?full=1` | the whole fingerprint, incl. `problems[]`. Computed by running `buildYaml` on a fixture, so it cannot drift out of sync with a forgotten version bump |
| `X-SPVPN-Profile` header | on every `/all`, `/sub`, `/sr` response, base64 *and* YAML — the same string, so a customer's screenshot of a response header says which build served them. `STALE:needs-geoip+cn-dns` is the string that means "redeploy me" |
| `GET /diag?t=<t>` | now carries `deployment` (is this build current?) and `yaml.guard` (is *this student's* profile safe?) |
| `npm run verify` | runs the repo's own `checkProfile` against a live host and exits non-zero on any mismatch |

```bash
npm run verify -- https://sp-vpn.netlify.app --token=<a-customer-token>
```

It distinguishes the three failures you can hit, because they need different fixes:

```
❌ deployment reports its profile policy   GET /healthz returned 200 ok — this
   build predates the profile guard … Redeploy from this repo.     ← build too old
❌ live profile passes the guard   needs-geoip, cn-dns              ← regression
❌ could not reach https://… — every request failed at the network  ← your shell,
   layer …                                                          not the deploy
```

The third one is a trap: a sandboxed runner, a CI job without egress, or any host
that cannot complete the TLS handshake produces `fetch failed` for every request,
and a script that reports "not serving the profile this repo builds" in that case
sends you redeploying a build that was already correct. Exit code is still 1 — the
answer is "I could not look", which is not the same as "it is wrong". From a
machine that *does* have egress, read the two headers by eye (the agent working on
this repo hit exactly this while confirming the 2026-11-10 probe fix, and had to
fetch the live profile through a proxy instead — note that a proxied page fetch
also answers it, but a plain `curl` from inside a no-egress sandbox does not):

```bash
curl -s https://sp-vpn.netlify.app/healthz | head -c 160
curl -sL "https://sp-vpn.netlify.app/all/SP%20VPN?t=<token>&fmt=yaml" | head -5
```

That second command is also the customer-facing answer to "did my app get the
fix?": the `# latency probe:` line only exists in new profiles, so if a customer's
app shows it missing while the server emits it, their client cached the old
subscription — update the subscription, don't redeploy.

`checkProfile()` in `sp-vpn-worker.js` is the single definition those all share:
geodata-free by default, non-CN resolvers plus `proxy-server-nameserver`,
`store-selected: false`, no duplicate proxy names (mihomo rejects the whole
import), no dangling group members, `udp: true` on every proxy, and quota
placeholders kept out of the speed-test groups. `?cn=1` deliberately flips the
first two, and the guard checks that mode too — so a profile claiming CN mode but
missing its rules fails instead of being excused.

### Per-client behaviour, pinned by `test/client-matrix.test.mjs`

*(110 checks — including 5 that hold `/sub/<token>`, the Clash **auto-update** URL, to
the same filtering, suffix and error behaviour as `/all`. A merge once restored
the `/all` fixes and left `/sub` behind: same link, same app, silently different
profile.)*

Each app is sent the format it can actually read, chosen from its `User-Agent`.
106 checks run every client below against a supplier fixture built to be as
nasty as a real panel (CRLF + BOM, uppercase scheme, quota placeholders, names
that collide in English, quotes and commas in names, a CDN-fronted ws family,
grpc, trojan-ws with `allowInsecure`, `aid=64` vmess, an IPv6 target, an empty
name, and two node types mihomo cannot use).

| Client | Gets | Notes |
|---|---|---|
| Clash Meta / mihomo | mihomo YAML | geo-free by default |
| Clash Verge / Verge Rev | mihomo YAML | quota + expiry via `subscription-userinfo` |
| **Karing** | mihomo YAML | was getting a bare base64 list and had to rebuild a config itself, losing Auto Speed, the carrier groups and the quota header |
| Clash Mi | mihomo YAML | |
| FlClash / Stash | mihomo YAML | |
| Shadowrocket / v2rayNG / NekoBox | base64 share list | all supplier links passed through, rebranded |
| Hiddify | base64 share list | sing-box reads URI lists; it is not a mihomo client |
| `curl`, or no UA at all | base64 share list | the safe answer when we cannot tell |

Parity is asserted, not assumed: every `vless`/`vmess`/`trojan` node the supplier
sent must survive with its Reality `pbk`/`sid`, `flow`, `fp`, SNI, ws `Host`+`path`
and grpc service name intact, and quota must still reach the app through the
headers.

**Nodes Clash cannot use are announced, never hidden.** `hysteria2://` and
`tuic://` links are kept in the base64 list but cannot appear in a mihomo
profile, and they are deliberately *not* converted: checked against mihomo's own
`HysteriaOption`, `type: hysteria` requires `up`/`down` speeds the URI never
carries (its `Speed()` errors without them) and has no `password` or
salamander-obfs field — so converting would risk the whole import to gain one
node. Instead the profile says what is missing:

```
# NOTE: 2 node(s) here are not Clash-compatible and are left out:
#       🇸🇬新加坡•Hysteria2, 🇯🇵日本•TUIC
#       those work fine in Shadowrocket / v2rayNG / NekoBox / Hiddify — use the plain link for them
```

so "my Clash list is shorter than my friend's" is answered by the file itself
rather than by a support conversation. `/diag` reports the same as
`nodes.unsupported`.

**The brand name is sanitised** (`safeBrand`) because it is not just a label: it
becomes the default group name *and* the target of the final `MATCH` rule, and
both parsers are strict — mihomo splits rules on commas (`SP,VPN` → a three-field
rule), YAML reads `: ` as a key/value separator (`吹雪 VPN: 学生` stops being a
string) and ` #` as a comment. Any of those made mihomo reject the profile, which
looks identical to "your VPN is broken" for every Clash customer at once. The
brand is also HTML-escaped on the quota and seller pages, since it arrives from a
URL any student can forward to another student.

### No latency numbers in Clash Meta / "most of my countries don't work"

Reported 2026-11-10, and worth reading as a lesson in *how* to diagnose this one:
the converter's node parameters were never the problem, and **the first fix for
this symptom was wrong** (it "upgraded" the probe to `https://www.gstatic.com/generate_204`
and dropped `expected-status`; that changed nothing for the customer, and the
reason it changed nothing is the actual bug).

The panel has its own Clash config, and it is fetchable — that is the reference:

```bash
curl -sL "https://xn--9kqs1lo79d.cc/api/v1/chuixue?token=<t>&type=clash&flag=meta" | sed -n '/proxy-groups/,/^rules:/p'
#   - { name: 吹雪云,  type: select,   proxies: [自动选择, 故障转移, …all nodes…] }
#   - { name: 自动选择, type: url-test, proxies: […], url: 'http://www.gstatic.com/generate_204', interval: 86400 }
#   - { name: 故障转移, type: fallback, proxies: […], url: 'http://www.gstatic.com/generate_204', interval: 7200 }
```

(`&clash=1` returns base64 like the plain link does; `type=clash&flag=meta` is the
switch that yields YAML. Their `自动选择` also contains the two quota nodes
`剩余流量`/`套餐到期` — we still exclude those from the test groups, which is the
one part of their policy that is worth *not* copying.)

So the panel probes over **plain `http://`** and pings fine — the probe runs from
the *node's* exit, where gstatic is reachable, not from the customer's phone. The
http-vs-https theory was wrong. What the panel has and the converter did not:

1. **A `url:` on the group the customer actually opens.** The core will not
   measure a `select` group on its own — `adapter/outboundgroup/parser.go`:
   *"select don't need auto health check"*, so `interval` is left at 0, and
   `HealthCheck.auto()` (interval ≠ 0) never starts `process()`
   (`adapter/provider/provider.go` `Initial()`). Any `⚡ Auto Speed` numbers are
   therefore *not* the numbers the top group has to show.
2. **A probe URL the app is allowed to see.** `constant/adapters.go` defines
   `DefaultTestURL = "https://www.gstatic.com/generate_204"`, and
   `Selector.MarshalJSON` deliberately omits a group's `testUrl` when it equals
   it — *"do not append a value to ensure that the web dashboard follows the
   settings of the dashboard"*. Emitting the https-gstatic URL (my "fix") is
   therefore **equivalent to emitting nothing**: the app falls back to whatever
   the user's own latency-test setting says, and on a fresh install that is often
   unset → no ping for any country, traffic fine. `HEALTH_URL` in
   `sp-vpn-worker.js` is the panel's URL for exactly this reason, and
   `checkProfile` now returns **`probe-hidden-from-ui`** if anyone re-"improves"
   it back to the core default.
3. **No `lazy`.** `HealthCheck.process()` skips a whole round on
   `lazy && time.Since(lastTouch) >= interval`, so delay history stays empty for
   every group the customer has not tapped. Guard code: **`lazy-probe`**.
4. A status that can be *failed*. `Proxy.URLTest` (`adapter/adapter.go`) records
   `Delay: 0` + `alive=false` when the probe errors **or** the status does not
   match `expected-status`; the core's own default is `"*"`, i.e. any reply
   proves the node alive. We emit no `expected-status` (like the panel);
   `&expect=204` opts back in per link.

**Current policy, matching the panel:** every group that contains a real node
carries `url: http://www.gstatic.com/generate_204`; `⚡ Auto Speed` `interval:
86400`, `🔁 Failover` `interval: 7200`; no `lazy`, no `tolerance`, no
`max-failed-times`, no `expected-status`. Two deliberate deviations, both cheap
and both aimed at the same symptom:

* the top `🚀 SP VPN` select gets `interval: 86400` as well, so the core fills
  each node's delay history once a day even if the app never asks;
* `📱 移动专线` / `📡 电信专线` get the `url` but **no** interval — delay history
  lives on the proxy (`adapter/adapter.go` `p.history`), shared by every group
  that lists it, so they display the same numbers without dialling anything.

`checkProfile` refuses to emit a node-bearing group with no `url:` at all
(**`group-has-no-probe-url`**), and `/diag?t=<t>` lists every probed group with
`{group, type, url, interval, lazy, advertised}` — `advertised: false` is the
one that explains "config looks right, app shows nothing".

The header of each profile states the policy, so a screenshot answers it:

```
# latency probe: http://www.gstatic.com/generate_204 · every 86400s · any reply counts as alive
```

And the per-link knobs, if a reseller's exits need different treatment:

| Parameter | Effect |
|---|---|
| `&health=<url>` | any `http(s)` URL — **avoid `https://www.gstatic.com/generate_204`**, the core hides it from the UI |
| `&interval=<s>` | probe cadence for every probed group, 60…604800; `&interval=300` is what the converter shipped before this change |
| `&expect=<codes>` | opt into strict liveness: `204`, `2xx`, `200-204,301`; unparseable → ignored |

Customers must still **update the subscription inside the app** once: an imported
profile is cached, and the profile header line above is how you tell a stale
client cache from a stale deployment. If a customer reports blanks after that, the
two things to try in order are `&interval=300` (forces the core to keep measuring)
and their app's own latency-test URL setting — the app is the component that
decides whether a number is drawn, which is the uncomfortable limit of what a
config converter can control.

### "Auto Speed doesn't pick anything"

Traffic enters the top `select` group (`🚀 <brand>`), and mihomo points a
`select` group at its **first member** on a fresh load. `⚡ Auto Speed` is
emitted first in every selector, so a freshly imported profile auto-selects it
for every customer — no tapping required.

The one thing that used to defeat that was `profile.store-selected: true`,
which restores whatever node the user last tapped, forever. It is now **off by
default**: every import *and* every auto-update re-arms Auto Speed. Append
**`&remember=1`** if you'd rather a manual pick survived updates.

Auto Speed itself is `url-test` with `interval: 300`, `tolerance: 80` (it only
switches for a >80 ms improvement, which stops it flapping) and `lazy: true`
(it probes while it is the active selection).

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

`npm test` runs **14 suites**: 1036 counted checks across the nine that report a
number, 21 `node:test` subtests in three more, and two suites that report a
verdict rather than a count (`leak-proof`, `paid-status`). The counts below are
what each suite prints today — they were all stale in this file once already,
which is its own small argument for reading them from the run, not the README.)

- `test/full-proof.mjs` — **305 checks**: the original client-matrix suite, run
  against the patched worker. Proves no client broke.
- `test/opaque-token.test.mjs` — **40 checks**: leak closed, opaque links serve
  every client type, legacy links still work, revocation is immediate, rotation,
  admin redaction, DB-outage fallback.
- `test/dashboard.test.mjs` — **143 checks**: the renewal *and revenue* maths in `summarise()`,
  live quota refresh, the dashboard routes, customer editing, panel account
  fields, profit, health, and that no route ever leaks a supplier URL.
- `test/migration.test.mjs` — **34 checks**: the additive migration applied to a
  database built on the *previous* production schema, asserting every existing
  column and value survives byte-identically and that re-running is a no-op.
- `test/customer-accounts.test.mjs` — shared account/credential inheritance, payment isolation across checks and reminders, additive migrations and concurrent SQL updates.
- `test/dashboard-ui.test.mjs` — real client/worker interaction: original + shared customer creation, Pay/cancel/retry/Mark unpaid, safe account display and filtering.
- `test/shared-users.test.mjs` — the read-only shared-link finder: complete-URL matching (including rows mislabeled Individual), same-host/different-token separation, nested/copied/legacy Hub-link resolution, revoked/rotated/generated record handling, missing/cyclic/too-deep chains, leak and no-write/no-network guarantees, HTTP status semantics, and the real dashboard dialog (filter independence, escaping, hidden-on-load, retry, stale replies, Escape and focus restore).
- `test/renewal.test.mjs` — **223 checks**: per-customer Renew / Check (changed
  vs unchanged expiry), usage increase / unchanged / reset, no delta on the
  first check, failed checks overwriting nothing, the global refresh still
  working and persisting deltas, revoked + unknown + direct-node customers
  handled safely, the action being read-only against the supplier, and supplier
  URLs staying redacted from every admin API.
- `test/reminders.test.mjs` — **45 checks**: day maths, which reminders are due,
  cron idempotency (three passes in one day send once; tomorrow fires again),
  a dead channel not losing the reminder, and the worker routes.
- `test/profile-guard.test.mjs` — **92 checks**: the 2026-11-10 Clash incident,
  pinned. The served profile is safe outside China, quota placeholders stay out
  of the speed-test groups, translation collisions are de-duplicated, Reality and
  CDN-front params survive the rebuild, `?cn=1` still works, `checkProfile`
  catches each regression individually, and a stale deploy is detectable from
  `/healthz` + `X-SPVPN-Profile` without shipping a version string anyone has to
  remember to bump.
- `test/client-matrix.test.mjs` — **106 checks**: every client above against an
  adversarial supplier fixture — right format per `User-Agent`, no node or
  parameter lost versus the raw link, quota headers present, unusable nodes
  announced rather than dropped, brand/YAML injection attempts, every `&fmt=` /
  `&cn=1` / `&remember=1` / `&exclude=` / `&include=` escape hatch, and a clean
  5xx when the supplier returns nothing.
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

**Then prove it actually shipped** — a merged PR is not a deployed PR, and the
site will happily serve a stale profile to every Clash customer until you check:

```bash
curl -s https://<your-host>/healthz          # {"ok":true,"profile":"geo-free;…"}
npm run verify -- https://<your-host> --token=<a-customer-token>
```

`verify` exits non-zero if the live build is older than this repo or has
regressed. It is worth wiring into CI after any deploy.

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
