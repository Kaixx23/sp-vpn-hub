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
    avgQuotaUsedPct: avgUsed === null ? null : Math.round(avgUsed * 1000) / 10,
    legacy,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Inline scripts live in a raw-text element: HTML entities such as &quot; and
// &gt; are not decoded there. Escape only sequences that can terminate or mangle
// the script tag; otherwise the dashboard client must remain real JavaScript.
const scriptEsc = (s) => String(s)
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

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
      <label>Supplier link <span class="req">*</span>
        <textarea name="link" rows="2" placeholder="https://your-supplier/api/v1/client/subscribe?token=…"></textarea>
      </label>
      <div class="two">
        <label>Customer name <input name="customer" placeholder="Ali"></label>
        <label>Plan <input name="plan" placeholder="200GB / 3 months"></label>
      </div>
      <div class="two">
        <label>Price <input name="price" type="number" step="0.01" placeholder="15.00"></label>
        <label>Currency <input name="currency" placeholder="USD"></label>
      </div>
      <div class="two">
        <label>Billing cycle <input name="billing_cycle" placeholder="quarterly"></label>
        <label>Paid until <input name="paid_until" type="date"></label>
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

<div id="toast" class="toast" hidden></div>
<script>${scriptEsc(CLIENT)}</script>
</body></html>`;
}

const CSS = `
:root{
  color-scheme:dark;
  --bg:#070f1d;--bg2:#0e1729;--card:rgba(15,23,42,.86);--card2:rgba(8,15,29,.9);
  --line:rgba(148,163,184,.18);--line2:rgba(148,163,184,.28);--text:#eef6ff;--dim:#93a4bd;
  --green:#34d399;--red:#fb7185;--amber:#fbbf24;--blue:#60a5fa;--purple:#8b5cf6;
  --shadow:0 22px 60px rgba(2,6,23,.42);--radius:18px
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{min-height:100%;background:var(--bg)}
body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
  background:
    radial-gradient(circle at 12% -10%,rgba(96,165,250,.25),transparent 34rem),
    radial-gradient(circle at 88% 0%,rgba(139,92,246,.18),transparent 30rem),
    linear-gradient(180deg,#08111f 0%,#0b1220 48%,#070f1d 100%);
  color:var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility
}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;
  background-image:linear-gradient(rgba(148,163,184,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.045) 1px,transparent 1px);
  background-size:44px 44px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.65),transparent 72%)
}
.wrap{width:min(1180px,calc(100% - 32px));margin:0 auto}
header{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);
  background:rgba(7,15,29,.78);backdrop-filter:blur(18px);box-shadow:0 12px 30px rgba(2,6,23,.18)}
header .wrap{min-height:74px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 0}
h1{display:flex;align-items:baseline;gap:10px;font-size:23px;letter-spacing:-.045em;margin:0;font-weight:850}
h1::before{content:"";width:11px;height:28px;border-radius:999px;background:linear-gradient(180deg,var(--blue),var(--purple));box-shadow:0 0 24px rgba(96,165,250,.7)}
h1 span{color:var(--dim);font-weight:650;font-size:13px;letter-spacing:.02em;text-transform:uppercase}
.acts{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.btn{appearance:none;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;border:0;border-radius:12px;
  padding:10px 15px;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 12px 26px rgba(37,99,235,.24);
  transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease,opacity .16s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 16px 32px rgba(37,99,235,.32)}
.btn.ghost{background:rgba(30,41,59,.72);border:1px solid var(--line2);color:var(--text);box-shadow:none}
.btn.ghost:hover{border-color:rgba(96,165,250,.6);box-shadow:0 14px 28px rgba(2,6,23,.24)}
.btn:disabled{opacity:.55;cursor:default;transform:none;box-shadow:none}
button,input,select,textarea{font:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid rgba(96,165,250,.85);outline-offset:2px}
main.wrap{padding:24px 0 64px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
.stat{position:relative;overflow:hidden;background:linear-gradient(180deg,rgba(23,35,60,.88),rgba(12,20,36,.88));
  border:1px solid var(--line);border-radius:var(--radius);padding:16px;min-height:94px;box-shadow:var(--shadow)}
.stat::after{content:"";position:absolute;right:-24px;top:-28px;width:86px;height:86px;border-radius:50%;background:rgba(96,165,250,.10)}
.stat b{display:block;font-size:30px;font-weight:900;line-height:1;letter-spacing:-.055em;margin-bottom:9px}
.stat span{display:block;font-size:12px;color:var(--dim);font-weight:700;letter-spacing:.03em;text-transform:uppercase}
.stat.warn b{color:var(--amber)}.stat.bad b{color:var(--red)}.stat.good b{color:var(--green)}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;background:rgba(15,23,42,.72);
  border:1px solid var(--line);border-radius:var(--radius);padding:12px;box-shadow:0 18px 40px rgba(2,6,23,.24)}
.toolbar input,.toolbar select{height:42px;width:auto;margin-top:0;background:rgba(8,15,29,.86);border:1px solid var(--line);color:var(--text);
  border-radius:12px;padding:0 13px;font-size:13px;outline:none;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.toolbar input:focus,.toolbar select:focus{border-color:rgba(96,165,250,.68);box-shadow:0 0 0 4px rgba(96,165,250,.12);background:rgba(8,15,29,.98)}
.toolbar input[type=search]{flex:1 1 280px;min-width:180px}.toolbar select{min-width:145px}.toolbar #meta{margin-left:auto;white-space:nowrap}
.dim{color:var(--dim);font-size:12px}.loading{text-align:center;padding:34px!important}
.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:rgba(15,23,42,.78);box-shadow:var(--shadow)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:940px}
th{text-align:left;color:var(--dim);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.085em;
  padding:13px 14px;border-bottom:1px solid var(--line);background:rgba(8,15,29,.72);position:sticky;top:0;z-index:1}
td{padding:14px;border-bottom:1px solid rgba(148,163,184,.12);vertical-align:middle}tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .14s ease,opacity .14s ease}tbody tr:hover{background:rgba(96,165,250,.07)}tr.revoked{opacity:.55}
.nm{font-weight:850;letter-spacing:-.015em}.sub{color:var(--dim);font-size:11px;margin-top:4px;line-height:1.35}.pill{display:inline-flex;align-items:center;gap:5px;
  padding:4px 9px;border-radius:999px;font-size:11px;font-weight:850;white-space:nowrap;border:1px solid transparent}
.pill.red{background:rgba(251,113,133,.13);color:#fda4af;border-color:rgba(251,113,133,.22)}
.pill.amber{background:rgba(251,191,36,.13);color:#fde68a;border-color:rgba(251,191,36,.22)}
.pill.green{background:rgba(52,211,153,.13);color:#86efac;border-color:rgba(52,211,153,.22)}
.pill.gray{background:rgba(148,163,184,.12);color:#cbd5e1;border-color:rgba(148,163,184,.18)}
.bar{height:8px;background:rgba(2,6,23,.72);border:1px solid rgba(148,163,184,.12);border-radius:999px;overflow:hidden;min-width:92px;box-shadow:inset 0 1px 2px rgba(0,0,0,.35)}
.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#34d399,#60a5fa);box-shadow:0 0 14px rgba(96,165,250,.35)}
.bar i.hot{background:linear-gradient(90deg,#fbbf24,#fb7185)}.usage-up{color:var(--amber);font-weight:800}.usage-reset{color:var(--green);font-weight:800}
.lnk{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#93c5fd;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
td:last-child{min-width:260px}.mini{appearance:none;background:rgba(30,41,59,.82);border:1px solid var(--line2);color:var(--text);border-radius:9px;
  padding:6px 9px;font-size:11px;font-weight:800;cursor:pointer;margin:2px;transition:transform .14s ease,border-color .14s ease,color .14s ease,background .14s ease}
.mini:hover{transform:translateY(-1px);border-color:rgba(96,165,250,.7);background:rgba(37,99,235,.18)}.mini.danger:hover{border-color:rgba(251,113,133,.75);color:#fda4af;background:rgba(251,113,133,.12)}
.modal{position:fixed;inset:0;background:rgba(2,6,23,.72);display:grid;place-items:start center;padding:52px 16px;overflow:auto;z-index:50;backdrop-filter:blur(10px)}
.sheet{background:linear-gradient(180deg,rgba(23,35,60,.98),rgba(12,20,36,.98));border:1px solid var(--line2);border-radius:22px;padding:24px;width:100%;max-width:560px;box-shadow:0 28px 90px rgba(0,0,0,.55)}
h2{margin:0 0 16px;font-size:19px;letter-spacing:-.03em}label{display:block;font-size:12px;color:#cbd5e1;font-weight:800;margin-bottom:12px;letter-spacing:.01em}.req{color:var(--red)}
input,textarea{width:100%;margin-top:6px;background:rgba(8,15,29,.9);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:10px 12px;font-size:13px;outline:none;font-family:inherit;transition:border-color .16s ease,box-shadow .16s ease}
textarea{resize:vertical;min-height:74px}input:focus,textarea:focus{border-color:rgba(96,165,250,.7);box-shadow:0 0 0 4px rgba(96,165,250,.12)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.macts{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}.result{font-size:12px;margin:8px 0;line-height:1.6;word-break:break-word}.result.ok{color:var(--green)}.result.err{color:var(--red)}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,.96);border:1px solid var(--line2);border-radius:14px;padding:12px 16px;font-size:13px;z-index:60;box-shadow:0 18px 50px rgba(0,0,0,.5)}
@media(max-width:980px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}header{position:relative}.toolbar #meta{width:100%;margin-left:0}}
@media(max-width:640px){.wrap{width:min(100% - 24px,1180px)}h1{font-size:20px}h1 span{display:block;font-size:11px}.acts{width:100%}.acts .btn{flex:1}.stats{grid-template-columns:1fr}.two{grid-template-columns:1fr}.toolbar input[type=search],.toolbar select{flex:1 1 100%;width:100%}.sheet{padding:20px}.modal{padding:24px 12px}}
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
  const delta = r.usage_delta_gb;
  const change = delta == null ? "" : delta > 0
    ? '<div class="sub usage-up">+' + Number(delta).toFixed(1) + ' GB used since last check</div>'
    : delta < 0
      ? '<div class="sub usage-reset">Usage reset by ' + Math.abs(Number(delta)).toFixed(1) + ' GB</div>'
      : '<div class="sub">No new usage since last check</div>';
  return '<div class="bar"><i class="' + (pct > 85 ? "hot" : "") + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '<div class="sub">' + left.toFixed(1) + ' / ' + r.total_gb + ' GB left</div>' + change;
}

function needsAction(r) {
  const e = daysTo(r.supplier_expires), p = daysTo(r.paid_until);
  return r.revoked || e === null || e <= 30 || (p !== null && p < 0) || r.legacy;
}

function rowsToShow() {
  let rs = DATA.slice();
  const q = Q.toLowerCase();
  if (q) rs = rs.filter((r) => [r.customer, r.label, r.plan, r.token, r.notes]
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
    const one = location.origin + "/all/" + encodeURIComponent(r.label || "SP VPN") + "?t=" + r.token;
    return '<tr class="' + (r.revoked ? "revoked" : "") + '">' +
      '<td><div class="nm">' + esc(name) + '</div>' +
        '<div class="sub">' + esc(r.token.slice(0, 10)) + '…' + (r.legacy ? ' · legacy' : '') + '</div></td>' +
      '<td>' + esc(r.plan || "—") + '<div class="sub">' + esc(money(r)) + (r.billing_cycle ? " · " + esc(r.billing_cycle) : "") + '</div></td>' +
      '<td>' + expPill(r) + '<div class="sub">' + esc(r.supplier_expires || "") + '</div></td>' +
      '<td>' + quotaCell(r) + '</td>' +
      '<td>' + (r.paid_until ? esc(r.paid_until) + (daysTo(r.paid_until) < 0 ? ' <span class="pill red">unpaid</span>' : "") : '<span class="dim">—</span>') + '</td>' +
      '<td><span class="lnk" title="' + esc(one) + '">' + esc(one) + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="mini" data-a="copy" data-v="' + esc(one) + '">copy</button>' +
        (r.revoked ? "" : '<button class="mini" data-a="renew" data-t="' + r.token + '">renew / check</button>') +
        '<button class="mini" data-a="edit" data-t="' + r.token + '">edit</button>' +
        '<button class="mini" data-a="rotate" data-t="' + r.token + '">rotate</button>' +
        (r.revoked ? "" : '<button class="mini danger" data-a="revoke" data-t="' + r.token + '">revoke</button>') +
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
    card((s.mrr || 0).toFixed(2), "recurring revenue") +
    card(s.legacy, "legacy links", s.legacy ? "warn" : "good");
}

async function load() {
  const r = await fetch("/admin/dashboard.json");
  const j = await r.json();
  DATA = j.customers || [];
  renderStats(j.stats); render();
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

function openModal(row) {
  const f = $("#form"); f.reset(); $("#result").textContent = ""; $("#result").className = "result";
  $("#mtitle").textContent = row ? "Edit " + (row.customer || row.label || "customer") : "Add customer";
  f.token.value = row ? row.token : "";
  f.link.disabled = !!row;
  $("#save").textContent = row ? "Save changes" : "Create link";
  if (row) for (const k of ["customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "label"])
    if (row[k] != null && f[k]) f[k].value = row[k];
  else f.link.disabled = false;
  $("#modal").hidden = false;
}
$("#add").addEventListener("click", () => openModal(null));
$("#cancel").addEventListener("click", () => ($("#modal").hidden = true));

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  const editing = !!d.token;
  const res = $("#result");
  try {
    const r = await fetch(editing ? "/admin/customer" : "/admin/mint", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(d).toString(),
    });
    const j = await r.json();
    if (!r.ok) { res.className = "result err"; res.textContent = j.error || ("HTTP " + r.status); return; }
    res.className = "result ok";
    res.textContent = editing ? "Saved." : "Created. Send this to the customer:  " + j.oneLink;
    if (!editing) { await load(); setTimeout(() => ($("#modal").hidden = true), 1400); }
    else { await load(); $("#modal").hidden = true; toast("Saved"); }
  } catch (err) { res.className = "result err"; res.textContent = err.message; }
});

$("#rows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  if (a === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.v); toast("Link copied"); }
    catch (err) { toast("Copy failed — select the link manually"); }
    return;
  }
  if (a === "renew") {
    const original = b.textContent; b.disabled = true; b.textContent = "checking…";
    try {
      const response = await fetch("/admin/link/" + b.dataset.t + "?action=renew");
      const j = await response.json();
      if (!response.ok) throw new Error(j.error || ("HTTP " + response.status));
      await load();
      if (j.expiryChanged) toast("Renewed: expiry updated to " + j.expiry);
      else toast("Checked: expiry remains " + (j.expiry || "unknown"));
    } catch (err) {
      toast("Renewal check failed: " + err.message);
      b.disabled = false; b.textContent = original;
    }
    return;
  }
  if (a === "edit") { openModal(DATA.find((r) => r.token === b.dataset.t)); return; }
  if (a === "revoke") {
    if (!confirm("Revoke this link? The customer's VPN stops immediately.")) return;
    await fetch("/admin/link/" + b.dataset.t + "?action=revoke"); toast("Revoked"); await load(); return;
  }
  if (a === "rotate") {
    if (!confirm("Rotate? The old link dies and you must send the new one.")) return;
    const j = await (await fetch("/admin/link/" + b.dataset.t + "?action=rotate")).json();
    await load();
    try { await navigator.clipboard.writeText(location.origin + "/all/SP%20VPN?t=" + j.newToken); toast("Rotated — new link copied"); }
    catch (err) { toast("Rotated: " + j.newToken); }
  }
});

load();
`;
