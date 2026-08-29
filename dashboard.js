import { profitOf, PANEL_PASSWORD_DEFAULT } from "./plans.js";

// ============================================================================
// DASHBOARD — server-rendered shell + a vanilla-JS client.
//
// No CDN, no framework, no build step: everything is inlined so the page still
// loads for a client on a Chinese network, and so a serverless cold start
// serves one document instead of a waterfall of assets.
// ============================================================================

/**
 * Derive the numbers the dashboard leads with, from the raw rows.
 * Exported separately so it can be unit-tested without rendering HTML.
 */
export function summarise(rows) {
  const now = new Date();
  const day = (d) => {
    if (!d) return null;
    const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
    return Number.isNaN(t) ? null : Math.round((t - Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000);
  };

  const active = rows.filter((r) => !r.revoked);
  const revoked = rows.filter((r) => r.revoked);

  const withExp = active.map((r) => ({ r, d: day(r.supplier_expires) })).filter((x) => x.d !== null);
  const overdue = withExp.filter((x) => x.d < 0);
  const exp7 = withExp.filter((x) => x.d >= 0 && x.d <= 7);
  const exp30 = withExp.filter((x) => x.d > 7 && x.d <= 30);

  // A link with no recorded expiry is an unknown, not a healthy one — the
  // dashboard surfaces it separately so it can't hide a renewal.
  const unknownExp = active.filter((r) => !r.supplier_expires);

  const withPaid = active.map((r) => ({ r, d: day(r.paid_until) })).filter((x) => x.d !== null);
  const unpaid = withPaid.filter((x) => x.d < 0);

  const mrr = active.reduce((sum, r) => sum + (Number(r.price) || 0), 0);
  const quotable = active.filter((r) => r.total_gb > 0);
  const avgUsed = quotable.length
    ? quotable.reduce((s, r) => s + (Number(r.used_gb) || 0) / Number(r.total_gb), 0) / quotable.length
    : null;

  // Profit: what each active customer pays minus the catalogue cost of their
  // plan (see plans.js). Rows on unknown plans contribute nothing — profit is
  // never a guess. null when no row has a known plan at all.
  const profits = active.map(profitOf).filter((p) => p !== null);
  const profitMonthly = profits.length ? profits.reduce((a, b) => a + b, 0) : null;

  // Legacy base64 tokens cannot be revoked — worth knowing how many remain.
  const legacy = active.filter((r) => r.legacy).length;

  return {
    total: rows.length,
    active: active.length,
    revoked: revoked.length,
    overdue: overdue.length,
    expiring7: exp7.length,
    expiring30: exp30.length,
    unknownExpiry: unknownExp.length,
    unpaid: unpaid.length,
    mrr: Math.round(mrr * 100) / 100,
    profitMonthly,
    avgQuotaUsedPct: avgUsed === null ? null : Math.round(avgUsed * 1000) / 10,
    legacy,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function dashboardPage(host = "") {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SP VPN — Dashboard</title>
<style>${CSS}</style>
</head><body>
<header>
  <div class="wrap">
    <h1>SP VPN <span>reseller dashboard</span></h1>
    <div class="acts">
      <button id="healthpill" class="pillbtn" title="System health — click for details">🩺 checking…</button>
      <button id="refresh" class="btn ghost" title="Fetch live quota &amp; expiry from the supplier">⟳ Refresh quota</button>
      <button id="add" class="btn">＋ Add customer</button>
    </div>
  </div>
</header>

<main class="wrap">
  <section id="stats" class="stats"></section>

  <div class="toolbar">
    <input id="q" type="search" placeholder="Search name, plan, token…">
    <select id="filter">
      <option value="all">All</option>
      <option value="action">Needs action</option>
      <option value="expiring">Expiring ≤ 30d</option>
      <option value="overdue">Overdue</option>
      <option value="legacy">Legacy links</option>
      <option value="revoked">Revoked</option>
    </select>
    <select id="sort">
      <option value="expiry">Sort: expiry</option>
      <option value="name">Sort: name</option>
      <option value="price">Sort: price</option>
      <option value="created">Sort: newest</option>
    </select>
    <span id="meta" class="dim"></span>
  </div>

  <div class="tablewrap">
  <table>
    <thead><tr>
      <th>Customer</th><th>Plan</th><th>Expires</th><th>Quota</th><th>Paid until</th><th>Link</th><th></th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="7" class="dim loading">Loading…</td></tr></tbody>
  </table>
  </div>
</main>

<div id="modal" class="modal" hidden>
  <div class="sheet">
    <h2 id="mtitle">Add customer</h2>
    <form id="form">
      <input type="hidden" name="token">
      <input type="hidden" name="supplier_expires">
      <input type="hidden" name="total_gb">
      <input type="hidden" name="used_gb">
      <label>Supplier link <span class="req">*</span>
        <textarea name="link" rows="2" placeholder="https://your-supplier/api/v1/client/subscribe?token=…"></textarea>
      </label>
      <div id="peek" class="peek" hidden></div>
      <div class="two">
        <label>Customer name <input name="customer" placeholder="Ali"></label>
        <label>Plan <input name="plan" placeholder="200GB / 3 months"></label>
      </div>
      <div class="two">
        <label>Price <input name="price" type="number" step="0.01" placeholder="15.00"></label>
        <label>Currency <input name="currency" placeholder="USD"></label>
      </div>
      <div class="two">
        <label>Billing cycle <input name="billing_cycle" placeholder="monthly"></label>
        <label>Paid until <input name="paid_until" type="date"></label>
      </div>
      <div class="two">
        <label>Panel account email <input name="account_email" type="email" placeholder="customer@gmail.com" title="The login you created for this customer on the supplier panel — used to renew the account"></label>
        <label>Panel password <input name="account_password" value="${esc(PANEL_PASSWORD_DEFAULT)}" title="Shared password for the panel accounts you create"></label>
      </div>
      <label>Notes <input name="notes" placeholder="Telegram @ali"></label>
      <div id="result" class="result"></div>
      <div class="macts">
        <button type="button" id="cancel" class="btn ghost">Cancel</button>
        <button type="submit" class="btn" id="save">Save</button>
      </div>
    </form>
  </div>
</div>

<div id="healthmodal" class="modal" hidden>
  <div class="sheet">
    <h2>🩺 System health</h2>
    <div id="healthbody"><div class="dim loading">Checking…</div></div>
    <div class="macts" style="margin-top:14px">
      <button type="button" id="healthre" class="btn ghost">⟳ Re-check now</button>
      <button type="button" id="healthclose" class="btn">Close</button>
    </div>
  </div>
</div>

<div id="toast" class="toast" hidden></div>
<script>${CLIENT.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0b1220;--card:#141d31;--card2:#0e1626;--line:rgba(148,163,184,.14);--text:#e8eef8;
--dim:#8ea0ba;--green:#34d399;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa}
*{box-sizing:border-box}
[hidden]{display:none !important}
body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1200px;margin:0 auto;padding:0 18px}
header{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#17233c,#121a2c);padding:16px 0}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
h1{font-size:19px;margin:0;font-weight:800}
h1 span{color:var(--dim);font-weight:500;font-size:14px;margin-left:6px}
.acts{display:flex;gap:8px}
.btn{background:linear-gradient(90deg,#2563eb,#4f46e5);color:#fff;border:0;border-radius:10px;
padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer}
.btn.ghost{background:#1b2740;border:1px solid var(--line);color:var(--text)}
.btn:disabled{opacity:.5;cursor:default}
main{padding:20px 18px 60px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.stat{background:linear-gradient(180deg,#17233c,#121a2c);border:1px solid var(--line);border-radius:14px;padding:13px 15px}
.stat b{display:block;font-size:26px;font-weight:800;line-height:1.15}
.stat span{font-size:12px;color:var(--dim)}
.stat.warn b{color:var(--amber)} .stat.bad b{color:var(--red)} .stat.good b{color:var(--green)}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.toolbar input,.toolbar select{background:var(--card2);border:1px solid var(--line);color:var(--text);
border-radius:9px;padding:9px 11px;font-size:13px;outline:none}
.toolbar input[type=search]{flex:1;min-width:180px}
.dim{color:var(--dim);font-size:12px}
.loading{text-align:center;padding:26px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;
letter-spacing:.05em;padding:11px 13px;border-bottom:1px solid var(--line)}
td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(96,165,250,.05)}
tr.revoked{opacity:.5}
.nm{font-weight:700} .sub{color:var(--dim);font-size:11px}
.pill{display:inline-block;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
.pill.red{background:rgba(248,113,113,.15);color:var(--red)}
.pill.amber{background:rgba(251,191,36,.15);color:var(--amber)}
.pill.green{background:rgba(52,211,153,.15);color:var(--green)}
.pill.gray{background:rgba(148,163,184,.15);color:var(--dim)}
.bar{height:7px;background:#0c1424;border-radius:5px;overflow:hidden;min-width:80px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#60a5fa)}
.bar i.hot{background:linear-gradient(90deg,#fbbf24,#f87171)}
.lnk{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--blue);
max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.mini{background:#1b2740;border:1px solid var(--line);color:var(--text);border-radius:7px;
padding:5px 8px;font-size:11px;cursor:pointer;margin-right:4px}
.mini:hover{border-color:var(--blue)}
.mini.danger:hover{border-color:var(--red);color:var(--red)}
.modal{position:fixed;inset:0;background:rgba(4,8,16,.75);display:flex;align-items:flex-start;
justify-content:center;padding:40px 16px;overflow:auto;z-index:50}
.sheet{background:linear-gradient(180deg,#17233c,#121a2c);border:1px solid var(--line);
border-radius:18px;padding:22px;width:100%;max-width:520px}
h2{margin:0 0 14px;font-size:17px}
label{display:block;font-size:12px;color:#cbd5e1;font-weight:600;margin-bottom:11px}
.req{color:var(--red)}
input,textarea{width:100%;margin-top:5px;background:var(--card2);border:1px solid var(--line);
color:var(--text);border-radius:9px;padding:9px 11px;font-size:13px;outline:none;font-family:inherit}
.two{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.macts{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.result{font-size:12px;margin:6px 0;line-height:1.6;word-break:break-all}
.result.ok{color:var(--green)} .result.err{color:var(--red)}
.peek{font-size:12px;margin:-3px 0 11px;color:var(--dim);line-height:1.6;word-break:break-word}
.peek.ok{color:var(--green)} .peek.err{color:var(--red)}
.pillbtn{background:#1b2740;border:1px solid var(--line);color:var(--dim);border-radius:20px;
padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.pillbtn.ok{border-color:var(--green);color:var(--green)}
.pillbtn.warn{border-color:var(--amber);color:var(--amber)}
.pillbtn.bad{border-color:var(--red);color:var(--red)}
.hrow{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5}
.hrow:last-child{border-bottom:0}
.hdot{width:9px;height:9px;border-radius:50%;margin-top:5px;flex:none;background:var(--dim)}
.hdot.ok{background:var(--green)} .hdot.bad{background:var(--red)}
.hname{font-weight:700;min-width:104px}
.hdetail{color:var(--dim);flex:1}
.onelink{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--blue);background:var(--card2);
border:1px solid var(--line);border-radius:9px;padding:9px 11px;margin:8px 0;word-break:break-all;
user-select:all;-webkit-user-select:all;cursor:text}
.msgbox{white-space:pre-line;background:var(--card2);border:1px solid var(--line);border-radius:9px;
padding:9px 11px;margin:8px 0;font-size:12px;line-height:1.55;word-break:break-word;user-select:text}
.mcpy{display:flex;gap:8px;flex-wrap:wrap}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1b2740;
border:1px solid var(--line);border-radius:10px;padding:10px 16px;font-size:13px;z-index:60;
box-shadow:0 12px 30px rgba(0,0,0,.5)}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}
`;

const CLIENT = `
let DATA = [], FILTER = "all", SORT = "expiry", Q = "";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const daysTo = (d) => {
  if (!d) return null;
  const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
  return isNaN(t) ? null : Math.round((t - Date.parse(new Date().toISOString().slice(0,10) + "T00:00:00Z")) / 864e5);
};
const money = (r) => r.price == null ? "" : (r.currency || "") + " " + Number(r.price).toFixed(2);
const oneLinkOf = (r) => location.origin + "/all/" + encodeURIComponent(r.label || "SP VPN") + "?t=" + r.token;
// The ready-to-send message the admin sends a new customer. The link is the
// converted one-link minted by /admin/mint (j.oneLink) — real host, fresh
// opaque token, never a hardcoded example.
const readyMessage = (link) =>
  "Here is your official SP Connect link: 🔗\n\n" + link +
  "\n\nYour data package will be valid for 30 days from the activation date. Your data will be renewed every 30 days once you renew your package.\n\n" +
  "I'll send you a reminder 3 days before your renewal date, so you'll have enough time to renew without any interruption.\n\n" +
  "Thank you for choosing SP Connect! ❤️";

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2600);
}

function expPill(r) {
  if (r.revoked) return '<span class="pill gray">revoked</span>';
  const d = daysTo(r.supplier_expires);
  if (d === null) return '<span class="pill gray">unknown</span>';
  if (d < 0) return '<span class="pill red">' + (-d) + 'd overdue</span>';
  if (d <= 7) return '<span class="pill red">' + d + 'd left</span>';
  if (d <= 30) return '<span class="pill amber">' + d + 'd left</span>';
  return '<span class="pill green">' + d + 'd left</span>';
}

function quotaCell(r) {
  if (!r.total_gb) return '<span class="dim">—</span>';
  const pct = Math.min(100, ((r.used_gb || 0) / r.total_gb) * 100);
  const left = Math.max(0, r.total_gb - (r.used_gb || 0));
  return '<div class="bar"><i class="' + (pct > 85 ? "hot" : "") + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '<div class="sub">' + left.toFixed(1) + ' / ' + r.total_gb + ' GB left</div>';
}

function needsAction(r) {
  const e = daysTo(r.supplier_expires), p = daysTo(r.paid_until);
  return r.revoked || e === null || e <= 30 || (p !== null && p < 0) || r.legacy;
}

function rowsToShow() {
  let rs = DATA.slice();
  const q = Q.toLowerCase();
  if (q) rs = rs.filter((r) => [r.customer, r.label, r.plan, r.token, r.notes, r.account_email]
    .some((v) => String(v || "").toLowerCase().includes(q)));
  if (FILTER === "action") rs = rs.filter(needsAction);
  if (FILTER === "expiring") rs = rs.filter((r) => { const d = daysTo(r.supplier_expires); return d !== null && d >= 0 && d <= 30; });
  if (FILTER === "overdue") rs = rs.filter((r) => { const d = daysTo(r.supplier_expires); return d !== null && d < 0; });
  if (FILTER === "legacy") rs = rs.filter((r) => r.legacy);
  if (FILTER === "revoked") rs = rs.filter((r) => r.revoked);
  const num = (v) => (v == null ? -Infinity : Number(v));
  rs.sort((a, b) => {
    if (SORT === "name") return String(a.customer || a.label || "").localeCompare(String(b.customer || b.label || ""));
    if (SORT === "price") return num(b.price) - num(a.price);
    if (SORT === "created") return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    const da = daysTo(a.supplier_expires), db = daysTo(b.supplier_expires);
    return (da === null ? 1e6 : da) - (db === null ? 1e6 : db);
  });
  return rs;
}

function render() {
  const rs = rowsToShow();
  $("#meta").textContent = rs.length + " of " + DATA.length + " links";
  $("#rows").innerHTML = rs.length ? rs.map((r) => {
    const name = r.customer || r.label || "—";
    const one = oneLinkOf(r);
    return '<tr class="' + (r.revoked ? "revoked" : "") + '">' +
      '<td><div class="nm">' + esc(name) + '</div>' +
        '<div class="sub">' + esc(r.token.slice(0, 10)) + '…' + (r.legacy ? ' · legacy' : '') + '</div>' +
        (r.account_email ? '<div class="sub" title="panel account (for renewals)">✉ ' + esc(r.account_email) + '</div>' : '') + '</td>' +
      '<td>' + esc(r.plan || "—") + '<div class="sub">' + esc(money(r)) + (r.billing_cycle ? " · " + esc(r.billing_cycle) : "") +
        (r.profit != null ? ' · <span style="color:var(--green)">' + (r.profit > 0 ? "+" : "") + r.profit + ' net</span>' : "") + '</div></td>' +
      '<td>' + expPill(r) + '<div class="sub">' + esc(r.supplier_expires || "") + '</div></td>' +
      '<td>' + quotaCell(r) + '</td>' +
      '<td>' + (r.paid_until ? esc(r.paid_until) + (daysTo(r.paid_until) < 0 ? ' <span class="pill red">unpaid</span>' : "") : '<span class="dim">—</span>') + '</td>' +
      '<td><span class="lnk" title="' + esc(one) + '">' + esc(one) + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="mini" data-a="copy" data-v="' + esc(one) + '">copy</button>' +
        '<button class="mini" data-a="edit" data-t="' + r.token + '">edit</button>' +
        '<button class="mini" data-a="rotate" data-t="' + r.token + '">rotate</button>' +
        (r.revoked ? "" : '<button class="mini danger" data-a="revoke" data-t="' + r.token + '">revoke</button>') +
        '<button class="mini danger" data-a="delete" data-t="' + r.token + '">delete</button>' +
      '</td></tr>';
  }).join("") : '<tr><td colspan="7" class="dim loading">No customers match.</td></tr>';
}

function renderStats(s) {
  if (!s) return;
  const card = (v, l, cls) => '<div class="stat ' + (cls || "") + '"><b>' + v + '</b><span>' + l + '</span></div>';
  $("#stats").innerHTML =
    card(s.active, "active customers") +
    card(s.expiring7, "expiring ≤ 7 days", s.expiring7 ? "bad" : "good") +
    card(s.expiring30, "expiring ≤ 30 days", s.expiring30 ? "warn" : "good") +
    card(s.overdue, "expired / overdue", s.overdue ? "bad" : "good") +
    card(s.unpaid, "unpaid", s.unpaid ? "bad" : "good") +
    card(s.unknownExpiry, "expiry unknown", s.unknownExpiry ? "warn" : "") +
    card((s.mrr || 0).toFixed(2), "revenue / month (RMB)") +
    card(s.profitMonthly == null ? "—" : s.profitMonthly.toFixed(2), "profit / month (RMB)",
      s.profitMonthly == null ? "" : s.profitMonthly > 0 ? "good" : s.profitMonthly < 0 ? "bad" : "") +
    card(s.legacy, "legacy links", s.legacy ? "warn" : "good");
}

async function load() {
  const cell = $("#rows");
  try {
    const r = await fetch("/admin/dashboard.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    DATA = j.customers || [];
    renderStats(j.stats); render();
  } catch (err) {
    cell.innerHTML = '<tr><td colspan="7" class="dim loading">Could not load data — ' +
      esc(err.message) + '. <a href="/admin" style="color:var(--blue)">Reload</a></td></tr>';
  }
}

$("#q").addEventListener("input", (e) => { Q = e.target.value; render(); });
$("#filter").addEventListener("change", (e) => { FILTER = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { SORT = e.target.value; render(); });

$("#refresh").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "⟳ Checking supplier…";
  try {
    const j = await (await fetch("/admin/refresh")).json();
    toast("Updated " + j.updated + " of " + j.checked + (j.failed ? " (" + j.failed + " failed)" : ""));
    await load();
  } catch (err) { toast("Refresh failed: " + err.message); }
  e.target.disabled = false; e.target.textContent = "⟳ Refresh quota";
});

// ---- auto-detect: paste a supplier link, the form fills itself ------------
let peekTimer = null, peekReq = 0, peekPromise = null;

function peekSay(msg, cls) {
  const p = $("#peek");
  p.textContent = msg || "";
  p.className = "peek" + (cls ? " " + cls : "");
  p.hidden = !msg;
}

async function peek(link) {
  const myReq = ++peekReq;
  peekSay("⏳ Reading the link — fetching quota, expiry & nodes…");
  const pr = (async () => {
    const r = await fetch("/admin/inspect", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link }).toString(),
    });
    const j = await r.json().catch(() => ({ ok: false, error: "HTTP " + r.status }));
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j;
  })();
  peekPromise = pr;
  try {
    const j = await pr;
    if (myReq !== peekReq) return; // a newer link was pasted meanwhile
    const f = $("#form");
    f.supplier_expires.value = j.expires || "";
    f.total_gb.value = j.total_gb == null ? "" : String(j.total_gb);
    f.used_gb.value = j.used_gb == null ? "" : String(j.used_gb);
    const bits = [];
    if (j.total_gb != null)
      bits.push(j.total_gb + " GB total · " + (j.used_gb || 0) + " GB used" +
        (j.used_pct != null ? " (" + j.used_pct + "%)" : ""));
    if (j.expires) bits.push("expires " + j.expires);
    if (j.pricing) bits.push(j.pricing.price + " " + j.pricing.currency + " / " + j.pricing.billing_cycle +
      (j.pricing.cost != null ? " (cost " + j.pricing.cost + ", profit " + (j.pricing.price - j.pricing.cost) + ")" : ""));
    if (j.nodes) bits.push(j.nodes + " node" + (j.nodes === 1 ? "" : "s"));
    peekSay(bits.length ? "✓ " + bits.join(" · ") : "✓ link readable, but it carries no quota/expiry info", "ok");
    // Pre-fill only what the user hasn't typed themselves.
    if (!f.link.disabled) {
      if (j.expires && !f.paid_until.value) f.paid_until.value = j.expires;
      if (j.total_gb > 0 && !f.plan.value) f.plan.value = j.total_gb + "GB";
      if (j.pricing) {
        if (!f.price.value) f.price.value = j.pricing.price;
        if (!f.currency.value) f.currency.value = j.pricing.currency;
        if (!f.billing_cycle.value) f.billing_cycle.value = j.pricing.billing_cycle;
      }
    }
  } catch (err) {
    if (myReq !== peekReq) return;
    const f = $("#form");
    f.supplier_expires.value = ""; f.total_gb.value = ""; f.used_gb.value = "";
    peekSay("✗ " + err.message, "err");
  } finally {
    if (peekPromise === pr) peekPromise = null;
  }
}

$("#form").link.addEventListener("input", () => {
  clearTimeout(peekTimer);
  const v = $("#form").link.value.trim();
  if (!v || !/^[a-z0-9+.-]+:\\/\\//i.test(v)) { peekReq++; peekSay(""); return; }
  peekTimer = setTimeout(() => peek(v), 700);
});

function openModal(row) {
  const f = $("#form"); f.reset(); $("#result").textContent = ""; $("#result").className = "result";
  clearTimeout(peekTimer); peekReq++; peekPromise = null; peekSay("");
  if (row && (row.supplier_expires || row.total_gb || row.used_gb != null)) {
    const bits = [];
    if (row.total_gb) bits.push(row.total_gb + " GB total · " + (row.used_gb || 0) + " GB used");
    if (row.supplier_expires) bits.push("expires " + row.supplier_expires);
    peekSay("On file: " + bits.join(" · ") + " — use ⟳ Refresh quota to update");
  }
  $("#mtitle").textContent = row ? "Edit " + (row.customer || row.label || "customer") : "Add customer";
  f.token.value = row ? row.token : "";
  f.link.disabled = !!row;
  $("#save").disabled = false;
  $("#save").textContent = row ? "Save changes" : "Create link";
  $("#cancel").textContent = "Cancel";
  if (row) {
    for (const k of ["customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "label", "account_email", "account_password"])
      if (row[k] != null && f[k]) f[k].value = row[k];
  } else {
    f.link.disabled = false;
  }
  $("#modal").hidden = false;
}
$("#add").addEventListener("click", () => openModal(null));
$("#cancel").addEventListener("click", () => ($("#modal").hidden = true));

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const editing = !!f.token.value;
  const res = $("#result");
  // If auto-detect is still reading the pasted link, let it finish first so
  // the detected quota/expiry are stored together with the new customer.
  if (!editing && peekPromise) {
    res.className = "result"; res.textContent = "Reading the link before saving…";
    try { await peekPromise; } catch (err) {}
    if ($("#modal").hidden) return; // user hit Cancel while we were reading
  }
  const d = Object.fromEntries(new FormData(f));
  try {
    const r = await fetch(editing ? "/admin/customer" : "/admin/mint", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(d).toString(),
    });
    const j = await r.json();
    if (!r.ok) { res.className = "result err"; res.textContent = j.error || ("HTTP " + r.status); return; }
    res.className = "result ok";
    // Keep the modal open and show the customer's one-link plus the
    // ready-to-send message below — auto-closing left no time to copy
    // anything. The link is the one /admin/mint just minted (j.oneLink):
    // real host + fresh opaque token, never a hardcoded example.
    const link = editing ? oneLinkOf({ label: d.label, token: d.token }) : j.oneLink;
    const msg = editing ? "" : readyMessage(link);
    res.innerHTML = (editing ? "Saved ✓ — the customer's one-link" : "Created ✓ — send this ready message to the customer") +
      ':<div class="onelink">' + esc(link) + '</div>' +
      (msg ? '<div class="msgbox">' + esc(msg) + '</div>' : "") +
      '<div class="mcpy">' +
      '<button class="btn" data-copy="' + esc(link) + '" data-label="📋 Copy one-link">📋 Copy one-link</button>' +
      (msg ? '<button class="btn" data-copy="' + esc(msg) + '" data-label="📋 Copy ready message">📋 Copy ready message</button>' : "") +
      '</div>';
    await load();
    if (!editing) { $("#save").disabled = true; $("#save").textContent = "Created ✓"; }
    $("#cancel").textContent = "Close";
  } catch (err) { res.className = "result err"; res.textContent = err.message; }
});

$("#result").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-copy]");
  if (!b) return;
  const label = b.dataset.label || "📋 Copy one-link";
  const isMsg = label.includes("ready message");
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast(isMsg ? "Ready message copied — send it to the customer" : "One-link copied — paste it to the customer");
    b.textContent = "✓ Copied";
    setTimeout(() => (b.textContent = label), 1600);
  } catch (err) {
    toast("Copy blocked — select the text manually, then copy");
  }
});

$("#rows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  if (a === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.v); toast("Link copied"); }
    catch (err) { toast("Copy failed — select the link manually"); }
    return;
  }
  if (a === "edit") { openModal(DATA.find((r) => r.token === b.dataset.t)); return; }
  if (a === "revoke") {
    if (!confirm("Revoke this link? The customer's VPN stops immediately.")) return;
    await fetch("/admin/link/" + b.dataset.t + "?action=revoke"); toast("Revoked"); await load(); return;
  }
  if (a === "delete") {
    const row = DATA.find((r) => r.token === b.dataset.t);
    const name = (row && (row.customer || row.label)) || "this customer";
    if (!confirm('Delete "' + name + '" permanently?\\n\\nThe customer record and its link are removed for good. If you only want the link dead, use revoke instead.')) return;
    const r = await fetch("/admin/link/" + b.dataset.t + "?action=delete");
    const j = await r.json().catch(() => ({}));
    toast(r.ok ? "Deleted " + name : "Delete failed: " + (j.error || ("HTTP " + r.status)));
    await load(); return;
  }
  if (a === "rotate") {
    if (!confirm("Rotate? The old link dies and you must send the new one.")) return;
    const j = await (await fetch("/admin/link/" + b.dataset.t + "?action=rotate")).json();
    await load();
    try { await navigator.clipboard.writeText(location.origin + "/all/SP%20VPN?t=" + j.newToken); toast("Rotated — new link copied"); }
    catch (err) { toast("Rotated: " + j.newToken); }
  }
});

// ---- live health: store -> supplier -> converter end-to-end -------------------
let HEALTH = null;

function renderHealth() {
  const b = $("#healthbody");
  if (!HEALTH) { b.innerHTML = '<div class="dim loading">Checking…</div>'; return; }
  const row = (ok, name, detail) =>
    '<div class="hrow"><div class="hdot ' + (ok ? "ok" : "bad") + '"></div>' +
    '<div class="hname">' + esc(name) + '</div><div class="hdetail">' + detail + "</div></div>";
  let h = "";
  const st = HEALTH.checks.store;
  if (st) h += row(st.ok, "Token store",
    st.ok ? esc(st.backend) + " · " + st.customers + " customers (" + st.active + " active) · " + st.ms + " ms"
          : esc(st.error || "failed"));
  const sup = HEALTH.checks.supplier;
  if (sup) {
    const hosts = Object.entries(sup.hosts || {});
    for (const [host, d] of hosts) {
      h += row(d.ok, "Supplier", d.ok
        ? esc(host) + " · " + d.nodes + " nodes · " + (d.quota_parsed ? "quota OK" : "no quota info") +
          (d.expires ? " · expires " + esc(d.expires) : "") + " · " + d.ms + " ms"
        : esc(host) + " — " + esc(d.error || "failed"));
    }
  }
  const cv = HEALTH.checks.converter;
  if (cv) h += row(cv.ok, "Converter",
    cv.ok ? (cv.skipped ? esc(cv.skipped) : "one-link served " + cv.nodes + " nodes" +
      (cv.quota_parsed ? " with quota header" : "") + " · " + cv.ms + " ms")
          : esc(cv.error || "failed"));
  h += '<div class="dim" style="padding:10px 0 0">' + esc(HEALTH.note || "") + "<br>Checked " +
    esc(HEALTH.generated) + (HEALTH.cached ? " (cached " + Math.round((HEALTH.age_ms || 0) / 1000) + "s ago)" : "") + "</div>";
  b.innerHTML = h;
}

async function loadHealth(force) {
  const pill = $("#healthpill");
  try {
    const r = await fetch("/admin/health" + (force ? "?force=1" : ""));
    if (!r.ok) throw new Error("HTTP " + r.status);
    HEALTH = await r.json();
    const lvl = HEALTH.level || (HEALTH.ok ? "ok" : "down");
    pill.className = "pillbtn " + (lvl === "ok" ? "ok" : lvl === "degraded" ? "warn" : "bad");
    pill.textContent = lvl === "ok" ? "● all systems healthy"
      : lvl === "degraded" ? "● supplier issue — serving cached"
      : "● system down";
    renderHealth();
  } catch (err) {
    pill.className = "pillbtn bad";
    pill.textContent = "● health unknown";
  }
}

$("#healthpill").addEventListener("click", () => {
  renderHealth();
  $("#healthmodal").hidden = false;
  if (!HEALTH || HEALTH.cached) loadHealth(false);
});
$("#healthclose").addEventListener("click", () => ($("#healthmodal").hidden = true));
$("#healthre").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "⟳ Checking…";
  await loadHealth(true);
  e.target.disabled = false; e.target.textContent = "⟳ Re-check now";
});

load();
loadHealth(false);
setInterval(() => loadHealth(false), 300000);
`;
