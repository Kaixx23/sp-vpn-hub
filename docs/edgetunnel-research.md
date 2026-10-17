# edgetunnel: how it works, how to pick the best nodes, and whether it can carry a paid service

_Researched 2026-10-18 for sp-vpn-hub. Code references are to
[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) `_worker.js` at commit `a8ab111`
(`Version 2026-10-08 22:23:27`). Your UUID and subscription token are deliberately not
written anywhere in this repo._

---

## 0. Summary

1. **How it works.** edgetunnel turns **one Cloudflare Worker into a VLESS/Trojan proxy server**.
   Every "node" in your subscription is the same Worker. Nodes differ only in **which
   Cloudflare IP the phone dials first**. Finding "the best nodes" means finding the best
   entry IPs **for each Chinese ISP**.
2. **Your 6 current nodes.** All are labelled `US 联通优选`: US data centres that someone else
   measured on a **China Unicom** line. Nothing in the list is aimed at **China Mobile** or
   **China Telecom** users, who are the majority. One node advertises 3 Mbps. All six fall back
   to the **shared public ProxyIP pool** for Cloudflare-hosted sites such as ChatGPT, X and Discord.
3. **Best nodes have to be measured inside China**, separately for each ISP, at the evening peak.
   Last night's public data (2026-10-17, ~22:00 Beijing) showed this pattern:
   - Mobile → **Hong Kong**, ~100 ms
   - Telecom → **Singapore**, ~115–155 ms
   - Unicom → **US West**, ~230–340 ms

   This repo now includes a tool that measures this through your real Worker:
   **`bin/cf-node-probe.mjs`** (§6).
4. **Capacity.** The free plan allows **100,000 Worker requests/day**, and **every connection a
   customer's phone opens counts as one request**. A realistic estimate is 1,200–4,700 requests
   per active customer per day, which puts the free plan at about **20–80 customers**. 50–200
   paying customers would exhaust it **every day**. After that, everyone gets Error 1027 until
   08:00 Beijing time. The paid plan fixes the quota for roughly US$7–15/month.
5. **The biggest risk is the rules, not the speed.** Cloudflare's terms explicitly forbid VPN/proxy
   services, reselling, and the 优选IP technique itself. **In October 2026 many edgetunnel users got
   1101 errors, "network abuse" emails and account suspensions** (§5). For a paid service, one
   suspension takes all your customers offline at once.
6. **Recommendation.** Don't make edgetunnel your product. Run **your own VPS nodes** (Xray/sing-box,
   VLESS+REALITY, multi-user panel) and plug each customer's panel link into sp-vpn-hub. The hub
   already accepts that as a "supplier URL", and every customer then gets their **own UUID**. That
   closes the gap your README says "cannot be fixed in your code" (§8). Keep edgetunnel as a
   personal or backup line, hardened as in §7.

---

## 1. How edgetunnel lets you "have your own nodes"

### 1.1 The picture

```
 Customer's phone (Clash / Shadowrocket / v2rayN)
   │  vless://UUID@<entry IP>:<port>?security=tls&type=ws&sni=sp-vpn.us.ci&host=sp-vpn.us.ci&path=/
   │
   │  ① TLS to a Cloudflare IP — looks like ordinary HTTPS to a Cloudflare website
   ▼
 Cloudflare data centre ("colo") that this IP is routed to from the customer's ISP
   │  (Hong Kong, Singapore, Tokyo… or Los Angeles, Frankfurt — the ISP decides, not you)
   ▼
 Your Worker (edgetunnel _worker.js)
   │  ② WebSocket upgrade → reads the VLESS header → checks the UUID
   │  ③ connect() straight to the website ─────────────────────────► the website
   │
   └─ ④ if the website is itself on Cloudflare, Workers aren't allowed to connect() to it,
        so the Worker detours via a "ProxyIP" (a third-party server that relays to Cloudflare)
        default: <colo>.proxyip.cmliussss.net (the author's public pool) ─► website
```

Why this gets through the Great Firewall: the phone only ever talks TLS to Cloudflare
IPs, which also serve millions of ordinary websites, so blocking them all is costly. The
weak spot is that your domain is visible in the TLS SNI. If `sp-vpn.us.ci` itself gets
blocked, every node dies at once, whichever IP it uses.

### 1.2 What the Worker does, step by step

| Step | What happens | Where (`_worker.js`) |
|---|---|---|
| Entry | `fetch()` routes `/sub`, `/admin`, `/login`, WebSocket upgrades, gRPC/XHTTP POSTs; anything else gets a fake "nginx" page | l.17–552; WebSocket branch l.69 |
| Protocol detection | First WebSocket message: bytes 56–57 = `\r\n` → Trojan, otherwise VLESS | l.1657 |
| VLESS parse | `version · UUID(16) · addons · cmd (1 TCP / 2 UDP) · port · addr-type · address · payload`; reply prefix `[version, 0]` | `解析魏烈思请求` l.1965 |
| Outbound | `connect()` straight to the target (2 parallel dials, 1 for CMCC, 1 s timeout), via `request.fetcher.connect` | `forwardataTCP` l.2170; l.3332 |
| Fallback | If the direct connect fails (target is on Cloudflare) → ProxyIP. Default `${colo}.proxyip.cmliussss.net`; the `PROXYIP` variable overrides | l.44–47; `解析地址端口` l.6440 |
| UDP | **Only DNS (port 53)**, relayed over TCP to 8.8.4.4. No QUIC, no UDP voice/video calls, no UDP games | `forwardataudp` l.2468 |
| Fake speed test | Requests to `speed.cloudflare.com` / `cp.cloudflare.com` are answered **locally with a fake 204** (default mode) | `isSpeedTestSite` l.3097 |

> **Practical consequence:** if an app's latency-test URL is `cp.cloudflare.com/generate_204`,
> **every node looks fast even when it's broken.** sp-vpn-hub's Clash config tests against
> `http://www.gstatic.com/generate_204`, which does travel the real path. Keep it that way.

### 1.3 Where your UUID and sub token come from

- **UUID** = `MD5MD5(ADMIN + KEY)`, formatted as a v4 UUID, **unless you set the `UUID` variable** (l.30–34).
  So with no `UUID` variable, **changing your admin password silently changes every node's UUID.**
- **Sub token** = `MD5MD5(host + UUID)` (l.305). The token **can't be rotated on its own**. A new token
  needs a new UUID, which breaks every customer's nodes at the same moment.
- **Admin login cookie** = `MD5MD5(UA + KEY + ADMIN)`, valid 24 h.
- **The admin panel's code is not in your Worker.** It's fetched live from the author's GitHub Pages
  site, `https://edt-pages.github.io` (l.4). Whoever controls that site controls the page where you
  type your admin password.

### 1.4 How `/sub` builds the node list

The admin panel (优选订阅生成) has three modes:

| Mode (admin label) | What customers get | Stable? |
|---|---|---|
| **随机优选** (random, the default) | **16 random IPs** from the author's CF-CIDR list (per-ISP variant picked from the visitor's network), each with a **random port** (443/2053/2083/2087/2096/8443), named `CF官方优选1…16` | ❌ A different list **on every refresh**: untested, and apps lose the selected node |
| **优选订阅生成器** (generator) | IPs from someone else's generator site | ⚠️ Somebody else's measurements, from somebody else's network |
| **自定义订阅** (custom, stored as KV `ADD.txt`) | Exactly the lines you paste: `ip:port#name`, CSV/API sources, `[IPv6]:port#name`, domains | ✅ Use this, filled with IPs **you measured** (§6) |

When a Clash, sing-box, Surge or Loon user agent fetches the sub, edgetunnel has a **third-party converter**
(`SUBAPI.cmliussss.net`, l.458) fetch a placeholder copy (UUID `00000000-0000-4000-8000-000000000000`, host
`example.com`), then swaps your real values back in. The converter learns your Worker's domain, but not your UUID. sp-vpn-hub fetches with a
`Shadowrocket/…` user agent, which gets the plain base64 VLESS list. The hub builds its own Clash config
from that, so the converter is never involved.

### 1.5 Other things worth knowing

- **Logging writes to KV on every subscription fetch** (up to a 4 MB `log.json`) unless `OFF_LOG=1` (l.5337–5390).
  KV free-tier writes are limited.
- **The project now actively tries to avoid Cloudflare's detection.** Identifiers are assembled at runtime
  (for example `"PROXYIP"` is built from `Proxy.name + "IP"` and `"cmliu"` from character codes, l.11–15).
  The real code ends around line 6,646. **Lines 6,647–33,144 are a comment containing the Hebrew Bible.**
  Users in [#1798](https://github.com/cmliu/edgetunnel/issues/1798) say it is there to confuse Cloudflare's
  automated code scanning. A business whose survival depends on not being detected is fragile.

**Verified, not just read.** I ran the unmodified `_worker.js` under Cloudflare's own runtime (workerd,
via wrangler 4.151.1) with a test UUID:
- Its default `/sub` returned 16 random `CF官方优选N` nodes on random ports.
- `bin/cf-node-probe.mjs` tunnelled through it end-to-end over VLESS and Trojan, including a byte-exact 10 MiB download.
- A wrong UUID was rejected.

---

## 2. Your current subscription, node by node

Fetched 2026-10-18. All six nodes are `tls` + `ws`, SNI/host `sp-vpn.us.ci`, fingerprint `chrome`,
path `/`, with no `proxyip` set, so the default public ProxyIP is used.

| # | Entry IP:port | Label in your sub | What it tells you |
|---|---|---|---|
| 1 | 190.93.245.249:443 | US 联通优选 [192ms 52.89Mbps] | Unicom-oriented, US colo |
| 2 | 190.93.247.131:2096 | US 联通优选 [201ms 51.20Mbps] | 〃 |
| 3 | 104.19.87.45:2053 | US 联通优选 [201ms 47.30Mbps] | 〃 |
| 4 | 104.16.7.216:2087 | US 联通优选 [217ms 46.58Mbps] | 〃 |
| 5 | 173.245.49.47:2083 | US 联通优选 [217ms 45.72Mbps] | 〃 |
| 6 | 104.17.251.251:2096 | US 联通优选 [226ms 3.06Mbps] | 〃, and **slow (3 Mbps)**: drop it |

What this means:
- **The ms/Mbps numbers are fixed text.** Someone measured them once, on a China Unicom line. They don't
  update and they say nothing about your customers' networks.
- **Only Unicom users are targeted.** Public data (§3) shows China Mobile's best Cloudflare IPs usually land
  in **Hong Kong** (~100 ms), and Telecom's in **Singapore** (~115–155 ms). For those customers, US-West
  entries are likely 2–3× slower.
- **Every node falls back to the same shared public ProxyIP pool** (`<colo>.proxyip.cmliussss.net`). If that
  pool has a bad evening, ChatGPT, X, Discord and other Cloudflare-hosted sites break on all six nodes together.
- I can't measure these from Singapore in a way that predicts China. That's what §6 is for.

---

## 3. Where speed and stability actually come from

| Hop | What decides its quality | Does choosing an entry IP help? |
|---|---|---|
| ① Phone → Cloudflare colo | The ISP's international route to that IP range, and peak-hour congestion | **Yes. This is the only thing 优选IP changes** |
| ② Inside the Worker | Free plan: 10 ms CPU per request and 100k requests/day (§4) | No (plan choice) |
| ③ Worker → website | Cloudflare's own backbone from that colo, which is usually excellent | Indirectly: a nearer colo means a nearer exit |
| ④ ProxyIP detour (Cloudflare-hosted sites only) | Whoever runs the ProxyIP server, and how loaded it is | No: set your own `PROXYIP` (§7) |

**Where each ISP's traffic lands.** Snapshot from [wetest.vip](https://www.wetest.vip/page/cloudflare/address_v4.html),
2026-10-17 around 22:00 Beijing (evening peak). The site blocks scripted access, so these figures come from a
search-engine copy of that page.

| ISP | Where its best Cloudflare IPs landed | Latency at peak |
|---|---|---|
| China Mobile | **HKG** (Hong Kong); some SEA (Seattle) | ~103 ms (HKG) · ~185 ms (SEA) |
| China Telecom | **SIN** (Singapore); some FRA | ~116–156 ms (SIN) · ~257 ms (FRA) |
| China Unicom | **LAX / SJC** (US West) | ~232–343 ms |

[biuping.com's analysis](https://www.biuping.com/article/23) reaches the same conclusion from a different
angle. China Mobile's *default* routing to Cloudflare is the worst of the three (US/EU colos, 300 ms+, 10%+ loss
at peak), so choosing entry IPs carefully helps **Mobile users the most**.

**What "fully stable" can realistically mean.** No one can guarantee it on Cloudflare's free network from
China. These are the things that actually break nodes, and what controls each one:

| Cause | Who controls it | Mitigation |
|---|---|---|
| Evening congestion on the international link | ISP | Per-ISP entry IPs, 3–5 spares each, `url-test` + `fallback` groups (the hub already generates both) |
| An entry IP range gets throttled or re-routed | ISP / Cloudflare | Re-test weekly (§6.6) |
| Your domain gets SNI-blocked in China | GFW | Keep a spare custom domain bound to the Worker, ready to switch |
| ProxyIP pool down | Whoever runs it | Your own `PROXYIP` |
| Daily quota exhausted (Error 1027) | You (plan choice) | Workers Paid (§4) |
| Account suspended | Cloudflare | Nothing technical fixes this (§5) |

---

## 4. Can the free plan carry 50–200 customers? (the math)

Cloudflare's published limits ([limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/)) are:
- **Free:** 100,000 requests/day per account (shared with Pages Functions), resetting at 00:00 UTC (**08:00 Beijing**).
  Over the limit you get Error 1027. Each request gets 10 ms CPU; going over gives Error 1102.
- **Paid:** US$5/month, including 10 M requests (then $0.30 per million) and 30 M CPU-ms (then $0.02 per million).

**The key fact: one proxied TCP connection is one Worker request**, because each connection is a separate
WebSocket. Every health check is one request too.

**Requests per active customer per day.** These are planning assumptions. Real numbers depend on the apps
people use and on routing rules (Chinese sites go DIRECT and cost nothing).

| | Low | Typical | Heavy |
|---|---|---|---|
| App health checks (Clash `url-test`: 6 nodes × every 5 min while in use; 2 groups when heavy) | 700 | 1,150 | 1,700 |
| Real proxied connections (browsing, social apps, video) | 500 | 1,250 | 3,000 |
| **Total** | **~1,200** | **~2,400** | **~4,700** |

**Results:**

| Customers | Requests/day (typical) | vs free 100k | Quota typically gone at |
|---|---|---|---|
| 20–40 | 48k–96k | fits, barely | — |
| **50** | ~120k | 1.2× | ~21:00 Beijing (right at peak) |
| **100** | ~240k | 2.4× | mid-afternoon |
| **200** | ~480k | 4.8× | before lunch |

- After that, **every customer** gets Error 1027 until 08:00 the next morning.
- The 10 ms CPU limit also cuts long video streams. Users are getting "CPU limit exceeded 1000+ times/24h"
  emails ([#1791](https://github.com/cmliu/edgetunnel/issues/1791)).
- **On the paid plan, 200 customers cost roughly US$7–15/month in Worker fees.** For example, 14.4 M
  requests/month comes to $5 + $1.32, plus CPU overage of a few dollars. Cost isn't the problem. §5 is.

---

## 5. The risk to weigh before selling this

**Cloudflare's terms.** [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/), updated Dec 3 2024
(paraphrased; read the original):
- **§2.2(a):** you may not sell, resell or rent access to the Services.
- **§2.2.1(b):** you may not send a Cloudflare-proxied domain's traffic to Cloudflare IP addresses that weren't
  assigned to it. **That is exactly what 优选IP does.**
- **§2.2.1(j):** you may not use the Services to provide a VPN or similar proxy service.

A paid edgetunnel service breaks all three at once.

**What enforcement looked like in October 2026** (edgetunnel's own issue tracker):

| Issue | What users reported |
|---|---|
| [#1787](https://github.com/cmliu/edgetunnel/issues/1787) | Account put under ToS review **after the 100k-requests usage emails**. Replies: "who else would they check", "running an airport?" |
| [#1796](https://github.com/cmliu/edgetunnel/issues/1796) | Automated "Network abuse" emails from Trust & Safety. Deleting the Worker didn't help; new accounts and obfuscation reported useless; Workers Builds disabled |
| [#1795](https://github.com/cmliu/edgetunnel/issues/1795) | Abuse notice plus 522 errors after an auto-update |
| [#1791](https://github.com/cmliu/edgetunnel/issues/1791) | Free plan: "CPU limit exceeded 1000+/24h" emails |
| [#1783](https://github.com/cmliu/edgetunnel/issues/1783) | Error 1101 on fresh deploys; users believe Cloudflare is detecting the traffic pattern |
| [#1798](https://github.com/cmliu/edgetunnel/issues/1798) | The Bible padding is meant to defeat code scanning; a user who removed it got an abuse email within ~5 minutes |
| [#1810](https://github.com/cmliu/edgetunnel/issues/1810) | Banned, needs a new account |

There was also a Cloudflare community thread on 2026-10-14 where *all* Workers on an account returned 1101.

**What that means for a reseller with 50–200 customers:**
- **No warning, no partial outage.** One automated decision takes every customer offline at the same moment.
  If your hub runs on the same Cloudflare account, the hub and your customer links go down with it.
- **Crossing 100k/day appears to draw attention.** In [#1787](https://github.com/cmliu/edgetunnel/issues/1787) the
  review followed Cloudflare's usage-limit emails. As §4 shows, a paying customer base would cross it every day.
- Working around enforcement (new accounts, obfuscation) breaks the same agreement again, and users report
  it doesn't last. This guide doesn't cover it.

**A short legal note.** In mainland China, providing VPN services without a licence is illegal, and sellers
have been prosecuted. One widely reported 2017 case in Guangxi ended in a 5½-year sentence. You're based in
Singapore, but mainland customers, payment channels and travel can still create exposure. Get proper local
advice if this becomes a real business.

---

## 6. How to find the best nodes, step by step

### 6.1 Rules

1. **Measure from inside China, on each ISP.** Do Mobile, Unicom and Telecom separately, ideally in the
   provinces where most of your customers live, because routing differs by province. **Turn the VPN off**
   while testing; TUN/global mode would route the test through another proxy.
2. **Measure at the evening peak, 20:00–23:00 Beijing**, on 2–3 different evenings. An IP that's great at
   10:00 can fall apart at 21:00.
3. **Choose the data centre (colo) first**, then latency and loss, then speed. A 110 ms HKG entry with 0% loss
   beats a 90 ms entry that loses 5% at peak.
4. **Keep 3–5 winners per ISP, no more.** Every extra node adds health-check requests (§4).
5. **Use TLS ports only:** 443, 2053, 2083, 2087, 2096, 8443. They all reach the same Worker.
6. Third-party "best IP" lists (wetest.vip, [HandsomeMJZ/cfip](https://github.com/HandsomeMJZ/cfip),
   [vipmc838/cf_best_ip](https://github.com/vipmc838/cf_best_ip)) are fine as **candidates**. They were
   measured on someone else's line, so verify them on yours.

> edgetunnel's admin panel has a built-in 在线优选 (online optimize) button, but it **refuses to run unless the
> browser is on a mainland-China connection** ("在线优选仅有 CN 直连网络环境才可以实现"). Run from Singapore,
> it can't help you. Testing must happen on the customers' side.

### 6.2 Who runs the test

Ask one trusted person per ISP, such as a friend or a loyal customer. They **don't need your admin password**.

- **CloudflareSpeedTest** needs no secrets at all.
- **`cf-node-probe`** needs the subscription link. That contains the node UUID, which is the same thing every
  customer's app already holds.

### 6.3 Tool A: `bin/cf-node-probe.mjs` (in this repo, zero dependencies, Node 18+)

It tests candidates in three stages, each one filtering for the next:

| Stage | What it does | Cloudflare cost |
|---|---|---|
| 1. TCP ping | Connect round-trips → latency and loss | none |
| 2. Edge trace | TLS with your domain as SNI, plus `GET /cdn-cgi/trace` → proves the IP serves your domain with a valid certificate, and **which colo it lands on from this network** | none (the edge answers, not your Worker) |
| 3. Tunnel | Real VLESS-over-WebSocket sessions **through your Worker**: real delay to `www.gstatic.com/generate_204` (what Clash measures), a **ProxyIP check** through a Cloudflare-hosted target, and a timed download for the top N | ~3 requests per IP; announced before it runs |

Stage 2 matters more than it looks. While building this, I saw a network that completed TCP handshakes to
Cloudflare IPs and then killed TLS. Ping-only tools report IPs like that as "fast". This one doesn't.

Run it on the tester's computer:

```bash
# 0) once: get the repo (or just copy bin/cf-node-probe.mjs, it has no dependencies)
git clone <this repo> && cd sp-vpn-hub

# 1) check the nodes you have now (on a China Mobile line, VPN off)
node bin/cf-node-probe.mjs --sub "https://sp-vpn.us.ci/sub?token=<TOKEN>" --isp mobile

# 2) hunt for better ones: your current nodes + 300 random Cloudflare IPs, keep Hong Kong/Asia
node bin/cf-node-probe.mjs --sub "https://sp-vpn.us.ci/sub?token=<TOKEN>" \
     --sample 300 --ports 443,2053,2083,2087,2096,8443 \
     --colo HKG,SIN,NRT,KIX,ICN,TPE --isp mobile --top 5 \
     --out mobile-ADD.txt --json mobile-report.json

# 3) re-rank a CloudflareSpeedTest result through your real Worker (Telecom tester)
node bin/cf-node-probe.mjs --sub "https://sp-vpn.us.ci/sub?token=<TOKEN>" \
     --ips telecom.csv --isp telecom --out telecom-ADD.txt
```

How to read the output (illustrative numbers):

```
#  entry               colo  tcp ms  edge ms  real delay  ProxyIP    Mbps  was
1  104.18.x.x:443      HKG   38      41       182         ok 240ms   48.2  US 联通优选[192ms…]
```

- **colo:** where this IP lands from the tester's network. For China, HKG/SIN/NRT/ICN/TPE are best.
- **real delay:** a fresh connection through your Worker, measured to first byte. It's directly comparable to
  Clash's latency test.
- **ProxyIP:** `FAIL` means Cloudflare-hosted sites (ChatGPT, X, Discord…) won't load via that entry.
- **Mbps:** download through the tunnel. The default file is 10 MB; use
  `--dl-url http://cachefly.cachefly.net/100mb.test` on fast lines.
- The tool also prints **what Cloudflare thinks the tester's location is**. If it isn't `loc=CN`, it warns
  that the results don't describe China.

Output files:
- **`--out` (default `best-ADD.txt`)**: lines like `104.18.x.x:443#香港•移动 CF01`, ready to paste.
- **`--json`**: every measurement. It never contains the UUID, the token or the tester's IP.

Run `node bin/cf-node-probe.mjs --help` for all options.

### 6.4 Tool B: CloudflareSpeedTest (wide scans, no secrets)

[XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) v2.3.5 is a single binary
(`cfst` / `cfst.exe`). It scans thousands of Cloudflare IPs quickly. Use `-httping` so it reports the colo,
and **keep `-n` low**, because its README warns that HTTPing counts as network scanning to some ISPs.

```bash
# China Mobile tester (expect HKG first)
cfst -httping -n 50 -cfcolo HKG,SIN,NRT,KIX,ICN,TPE -tl 300 -tlr 0.1 -dn 10 -sl 1 -o mobile.csv
# China Telecom tester (expect SIN/HKG)
cfst -httping -n 50 -cfcolo SIN,HKG,NRT,ICN,LAX,SJC -tl 300 -tlr 0.1 -dn 10 -sl 1 -o telecom.csv
# China Unicom tester (expect US West; Asia if lucky)
cfst -httping -n 50 -cfcolo SJC,LAX,SEA,NRT,HKG,SIN -tl 350 -tlr 0.1 -dn 10 -sl 1 -o unicom.csv
```

`-tl` is the max average latency (ms), `-tlr` the max loss rate, and `-sl` the minimum download speed in
**MB/s**. CFST tests raw reachability to Cloudflare, not your Worker. **Then feed the CSV to the probe**
(example 3 above) to confirm the winners through your real tunnel.

### 6.5 Load the winners into edgetunnel

1. Merge the three files: `cat mobile-ADD.txt unicom-ADD.txt telecom-ADD.txt > ADD.txt`
   (Windows: `type mobile-ADD.txt unicom-ADD.txt telecom-ADD.txt > ADD.txt`).
2. Admin panel → **优选订阅生成** → choose **自定义订阅** (not 随机优选) → paste into **自定义优选地址** → **保存**.
3. Don't add comment lines with commas. edgetunnel splits that box on commas, quotes and tabs. The probe's
   output is already safe.

**How the hub shows them.** sp-vpn-hub groups nodes by the carrier word in their names (`carrierOf()`:
电信/联通/移动) and translates country words. `香港•移动 CF01` therefore appears as
**`Hong Kong•Mobile CF01`** inside a **Mobile** group. Customers pick their own carrier's group, and the
existing `AUTO` (url-test) and `FAIL` (fallback) groups handle failover.

### 6.6 Upkeep

- **Weekly**, or whenever customers complain: re-run the probe per ISP at peak. Keep last week's winners
  until the new ones prove themselves.
- **After any big outage or holiday** (routes get reshuffled): re-test.
- Track the `real delay` and `Mbps` columns in the JSON reports over time. A steady climb on one colo means
  it's time to move.

---

## 7. Hardening checklist (if you keep edgetunnel running)

| # | Do this | Why |
|---|---|---|
| 1 | **Switch to 自定义订阅 with measured IPs** (§6.5) | Random mode serves 16 untested IPs that change on every refresh |
| 2 | **Set `OFF_LOG=1`** (Worker → Settings → Variables) | Stops a ≤4 MB KV write on every subscription fetch |
| 3 | **Set the `UUID` variable explicitly** | Otherwise a password change silently rotates every customer's UUID. Setting it to the *current* value changes nothing for customers; a *new* value is how you rotate (#9) |
| 4 | **Set `PROXYIP` to a relay you control** | The default `<colo>.proxyip.cmliussss.net` is a shared public pool you don't control. If you rent a VPS for this, compare with §8: that VPS could simply *be* your node |
| 5 | **Keep 3–5 nodes per ISP** | Health checks multiply with node count (§4) |
| 6 | **Move to Workers Paid if more than a handful of people use it** | Removes the 100k/day cap and the 10 ms CPU limit. It does **not** change the ToS position (§5) |
| 7 | **Keep sp-vpn-hub on a different account or provider from edgetunnel** | So one suspension can't take down your customer links and dashboard too |
| 8 | **Use a long, unique `ADMIN` password** | Every customer's config contains your Worker domain, so anyone can open `/admin` and try passwords |
| 9 | **Rotate now:** your sub link (token) was pasted into a chat | Anyone holding it gets every node, including the UUID. A new `UUID` value gives a new token; then update the supplier URL stored in the hub |
| 10 | **Bind a spare custom domain to the Worker** | If the main domain gets SNI-blocked in China, you can switch quickly |

---

## 8. The sustainable path: your own servers, sold through the hub you already built

```
 Customer's phone (Clash / Shadowrocket)
   │  your hub link with an opaque token          ← what you sell (already built)
   ▼
 sp-vpn-hub ── fetches ──► THIS customer's panel subscription URL
   │                       (3x-ui / Marzban / Remnawave running on your VPS)
   ▼
 nodes carrying THIS customer's own UUID ──► your VPS nodes (HK / JP / SG …)
                                             VLESS + REALITY  (+ Hysteria2 on lossy lines)
```

| | edgetunnel on Cloudflare | Your own VPS + panel |
|---|---|---|
| Allowed by the platform? | **No** (§5) | Depends on the host's acceptable-use policy. Many VPS hosts allow proxies; **check before buying** |
| One UUID per customer, revoke one customer | **No.** Everyone shares one UUID | **Yes.** Disable a user and their nodes stop working immediately |
| Quotas and expiry enforced | No | Yes, by the panel |
| Capacity | 100k requests/day free; crossing it draws attention | You buy bandwidth; capacity is predictable |
| UDP (QUIC, calls, games) | DNS only | Yes (VLESS UDP, Hysteria2) |
| Entry IPs | Shared Cloudflare IPs you have to hunt through | Your own IPs; swap one out if it gets blocked |
| Speed from China | Whatever route the ISP has to some Cloudflare colo | Whatever route your VPS has: pick China-optimised lines (CN2 GIA for Telecom, CMIN2 for Mobile, AS9929/CUII for Unicom) or nearby HK/JP/SG |
| Who can break it | Cloudflare, the author's ProxyIP pool, `edt-pages.github.io` | You and your VPS provider |

**What to build:**
1. **At least 2 VPS from different providers/regions.** For example, Hong Kong or Japan on a China-optimised
   line, plus Singapore or US West as backup.
2. **Xray-core or sing-box with VLESS + REALITY** (TCP, `xtls-rprx-vision`). It's currently the most robust
   choice against active probing, because the server presents a real website's TLS handshake. Optionally add
   **Hysteria2** where the ISP doesn't throttle UDP; it's faster on lossy links.
3. **A multi-user panel.** 3x-ui (one server, simplest), Marzban or Remnawave (several servers, managed
   centrally). Each gives you per-user UUIDs, traffic quotas, expiry dates and a per-user subscription URL.
4. **In the hub, mint each customer's link with *their* panel subscription URL as the "supplier URL"**, the same
   flow you use for supplier links today. The hub fetches it with its Shadowrocket user agent, rewrites and
   translates names, and builds the carrier groups and Clash config. Node delivery needs **no code change**.

**This closes the hole your README says code can't fix.** "What this does NOT fix" says per-customer node UUIDs
from the supplier are "the only real margin protection in this business model". **With your own panel, you are
the supplier.** A customer who digs the UUID out of their Clash config only exposes their own access, and you
can switch it off.

**Two hub changes worth making on this path** (not done here, to keep this change focused):
- **Read the panel's `subscription-userinfo` response header.** Panels report usage and expiry there, but
  `fetchSubscription()` only reads a `STATUS=` line from the body (`sp-vpn-worker.js` l.134–170). It's about
  20 lines of code, and then the dashboard and reminders show real quota and expiry automatically.
- **Add authentication to `/admin/*`.** README "Before you deploy" already flags it as unauthenticated. Once
  your own servers sit behind it, it guards your whole customer list.

**Rough sizing** (planning numbers; replace them after a month of panel data):
- **Monthly traffic** = customers × average *real* usage. With typical 100–200 GB plans, real average use is
  usually well below the cap. Measure it during the pilot.
- **Peak bandwidth** is roughly customers × share online at peak × per-user rate. For example,
  200 × 15% × 8 Mbps ≈ 240 Mbps, spread across your nodes.
- There's no per-request quota, so cost scales with bandwidth, not with how many connections apps open.

**Migration plan:**
1. **Pilot (week 1):** one VPS with 3x-ui and 5 test customers, using hub links that point at their panel URLs.
   Testers on all three ISPs check speed at the evening peak.
2. **Grow (weeks 2–4):** new customers go to the VPS, and existing ones move as their periods renew. Add the
   second VPS.
3. **Keep edgetunnel as an emergency line**, hardened per §7 and on a different account from the hub.

---

## 9. What this research added to the repo

| File | What it is |
|---|---|
| `docs/edgetunnel-research.md` | This document |
| `bin/cf-node-probe.mjs` | The probe (§6.3). Zero dependencies. `npm run probe -- --help` |
| `test/cf-node-probe.test.mjs` | 87 checks covering the parsers, protocol bytes and framing. Includes a **full end-to-end session against a local fake edgetunnel** (TLS → WebSocket → VLESS and Trojan), ranking, the ProxyIP check, download accounting, wrong-UUID rejection, certificate verification, and a check that the UUID never reaches output files. Loopback only; part of `npm test` |

The probe was also run against the **real, unmodified edgetunnel `_worker.js`** under workerd (wrangler 4.151.1)
during development: VLESS and Trojan tunnels worked, a 10 MiB download arrived byte-exact, and a wrong UUID was
rejected.

---

## 10. Sources

- edgetunnel source: <https://github.com/cmliu/edgetunnel> (`_worker.js` @ `a8ab111`). Admin UI source:
  <https://github.com/EDT-Pages/EDT-Pages.github.io>
- Cloudflare Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Cloudflare Self-Serve Subscription Agreement: <https://www.cloudflare.com/terms/>
- Enforcement reports: edgetunnel issues
  [#1783](https://github.com/cmliu/edgetunnel/issues/1783),
  [#1787](https://github.com/cmliu/edgetunnel/issues/1787),
  [#1791](https://github.com/cmliu/edgetunnel/issues/1791),
  [#1795](https://github.com/cmliu/edgetunnel/issues/1795),
  [#1796](https://github.com/cmliu/edgetunnel/issues/1796),
  [#1798](https://github.com/cmliu/edgetunnel/issues/1798),
  [#1810](https://github.com/cmliu/edgetunnel/issues/1810)
- Per-ISP Cloudflare landing data: <https://www.wetest.vip/page/cloudflare/address_v4.html> (2026-10-17 peak
  snapshot); analysis: <https://www.biuping.com/article/23>
- Community IP feeds: <https://github.com/HandsomeMJZ/cfip>, <https://github.com/vipmc838/cf_best_ip>
- CloudflareSpeedTest v2.3.5: <https://github.com/XIU2/CloudflareSpeedTest>
- Cloudflare IP ranges: <https://www.cloudflare.com/ips/>
