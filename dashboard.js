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

  // Only an explicitly recorded customer payment counts. A renewed supplier
  // account (shared or individual) says nothing about who has paid.
  const unpaid = active.filter((r) => { const d = day(r.paid_until); return d === null || d < 0; });

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

// CLIENT is static source, not user input. Script elements are raw text:
// HTML-escaping the script would prevent every dashboard control from running.
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
      <button id="refresh" class="btn ghost" title="Fetch supplier quota and expiry only; payments stay unchanged">⟳ Refresh quota</button>
      <button id="add" class="btn">＋ Add customer</button>
    </div>
  </div>
</header>

<main class="wrap">
  <section id="stats" class="stats"></section>

  <div class="toolbar">
    <input id="q" type="search" placeholder="Search customer, supplier account, plan…">
    <select id="filter">
      <option value="all">All</option>
      <option value="action">Needs action</option>
      <option value="expiring">Expiring ≤ 30d</option>
      <option value="overdue">Overdue</option>
      <option value="unpaid">Unpaid</option>
      <option value="shared">Shared link customers</option>
      <option value="individual">Individual customers</option>
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

  <p class="dim">Check updates supplier dates and quota only. Use Pay to record each customer’s payment.</p>
  <div class="tablewrap">
  <table>
    <thead><tr>
      <th>Customer</th><th>Supplier account</th><th>Plan</th><th>Supplier expiry</th><th>Quota</th><th>Payment</th><th>Link</th><th></th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="8" class="dim loading">Loading…</td></tr></tbody>
  </table>
  </div>
</main>

<div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle" hidden>
  <div class="sheet">
    <h2 id="mtitle">Add customer</h2>
    <form id="form">
      <input type="hidden" name="token">
      <label>Customer type
        <select name="customer_type" id="customer-type">
          <option value="individual">Individual customer — original supplier link</option>
          <option value="shared">Shared link — use an existing customer's account</option>
        </select>
      </label>
      <label><span id="link-label">Original supplier link</span> <span class="req">*</span>
        <textarea name="link" rows="2" required placeholder="https://your-supplier/api/v1/client/subscribe?token=…"></textarea>
      </label>
      <div id="shared-account" class="account-info" aria-live="polite" hidden></div>
      <label>Supplier account
        <input name="supplier_account" placeholder="Account name or email — not a password">
      </label>
      <p id="account-help" class="dim">Name the supplier account used by this link. Shared customers will inherit it.</p>
      <div class="two">
        <label>Customer name <input name="customer" placeholder="Ali"></label>
        <label>Plan <input name="plan" placeholder="200GB / 3 months"></label>
      </div>
      <div class="two">
        <label>Price <input name="price" type="number" step="0.01" placeholder="15.00"></label>
        <label>Currency <input name="currency" placeholder="USD"></label>
      </div>
      <label>Billing cycle <input name="billing_cycle" placeholder="quarterly"></label>
      <p class="dim">Payment is separate. After saving, use this customer's Pay button to record payment.</p>
      <label>Notes <input name="notes" placeholder="Telegram @ali"></label>
      <div id="result" class="result"></div>
      <div class="macts">
        <button type="button" id="cancel" class="btn ghost">Cancel</button>
        <button type="submit" class="btn" id="save">Save</button>
      </div>
    </form>
  </div>
</div>

<div id="pay-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="pay-title" hidden>
  <div class="sheet">
    <h2 id="pay-title">Record payment</h2>
    <p id="pay-info" class="dim"></p>
    <form id="pay-form">
      <input type="hidden" name="token">
      <label>Paid until <span class="req">*</span><input name="paid_until" type="date" required></label>
      <p class="dim">Confirm the date this customer has paid through. This records payment only; it does not charge them or renew the supplier account. Other customers stay unchanged.</p>
      <div id="pay-result" class="result" role="alert"></div>
      <div class="macts">
        <button type="button" id="pay-cancel" class="btn ghost">Cancel</button>
        <button type="submit" id="pay-save" class="btn">Pay — mark as paid</button>
      </div>
    </form>
  </div>
</div>
<div id="toast" class="toast" role="status" hidden></div>
<script>${CLIENT}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0b1220;--card:#141d31;--card2:#0e1626;--line:rgba(148,163,184,.14);--text:#e8eef8;
--dim:#8ea0ba;--green:#34d399;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa}
*{box-sizing:border-box}
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
table{width:100%;border-collapse:collapse;font-size:13px;min-width:1100px}
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
.usage-up{color:var(--amber);font-weight:700}.usage-reset{color:var(--green);font-weight:700}
.lnk{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--blue);
max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.mini{background:#1b2740;border:1px solid var(--line);color:var(--text);border-radius:7px;
padding:5px 8px;font-size:11px;cursor:pointer;margin-right:4px}
.mini:hover{border-color:var(--blue)}
.mini.cell-action{margin-top:6px}
.account-name{max-width:180px;overflow-wrap:anywhere}
.mini.pay{color:var(--green);border-color:rgba(52,211,153,.3)}
.mini:disabled{opacity:.5;cursor:default}
.mini.danger:hover{border-color:var(--red);color:var(--red)}
.modal{position:fixed;inset:0;background:rgba(4,8,16,.75);display:flex;align-items:flex-start;
justify-content:center;padding:40px 16px;overflow:auto;z-index:50}
.sheet{background:linear-gradient(180deg,#17233c,#121a2c);border:1px solid var(--line);
border-radius:18px;padding:22px;width:100%;max-width:520px}
h2{margin:0 0 14px;font-size:17px}
label{display:block;font-size:12px;color:#cbd5e1;font-weight:600;margin-bottom:11px}
.req{color:var(--red)}
input,textarea,form select{width:100%;margin-top:5px;background:var(--card2);border:1px solid var(--line);
color:var(--text);border-radius:9px;padding:9px 11px;font-size:13px;outline:none;font-family:inherit}
.account-info{border:1px solid var(--line);background:var(--card2);border-radius:9px;padding:10px 12px;font-size:12px;line-height:1.6;margin-bottom:12px}
input:read-only{color:var(--dim)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.macts{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.result{font-size:12px;margin:6px 0;line-height:1.6;word-break:break-all}
.result.ok{color:var(--green)} .result.err{color:var(--red)}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1b2740;
border:1px solid var(--line);border-radius:10px;padding:10px 16px;font-size:13px;z-index:60;
box-shadow:0 12px 30px rgba(0,0,0,.5)}
[hidden]{display:none!important}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}
`;

const CLIENT = `
let DATA = [], FILTER = "all", SORT = "expiry", Q = "";
let EDIT_ROW = null, sharedTimer, sharedSequence = 0, closeTimer;

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

function paymentCell(r) {
  const paid = daysTo(r.paid_until);
  return '<span class="pill ' + (paid !== null && paid >= 0 ? 'green">Paid' : 'red">Unpaid') + '</span>' +
    '<div class="sub">' + (r.paid_until ? 'Until ' + esc(r.paid_until) : 'No payment recorded') + '</div>';
}

function accountCell(r) {
  const a = r.supplier_account;
  if (!a) return '<span class="dim">No account recorded</span>';
  return '<div class="account-name">' + esc(a.name) + '</div><div class="sub">' + esc(a.host) + ' · ' +
    esc(a.id.slice(0, 8)) + '</div><div class="sub">' + a.customers + ' customer' + (a.customers === 1 ? '' : 's') + '</div>';
}

function needsAction(r) {
  const e = daysTo(r.supplier_expires), p = daysTo(r.paid_until);
  return r.revoked || e === null || e <= 30 || (p === null || p < 0) || r.legacy;
}

function rowsToShow() {
  let rs = DATA.slice();
  const q = Q.toLowerCase();
  if (q) rs = rs.filter((r) => [r.customer, r.label, r.plan, r.token, r.notes, r.supplier_account?.name, r.supplier_account?.host]
    .some((v) => String(v || "").toLowerCase().includes(q)));
  if (FILTER === "action") rs = rs.filter(needsAction);
  if (FILTER === "expiring") rs = rs.filter((r) => { const d = daysTo(r.supplier_expires); return d !== null && d >= 0 && d <= 30; });
  if (FILTER === "overdue") rs = rs.filter((r) => { const d = daysTo(r.supplier_expires); return d !== null && d < 0; });
  if (FILTER === "unpaid") rs = rs.filter((r) => !r.revoked && (daysTo(r.paid_until) === null || daysTo(r.paid_until) < 0));
  if (FILTER === "shared" || FILTER === "individual") rs = rs.filter((r) => r.customer_type === FILTER);
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
        '<span class="pill ' + (r.customer_type === 'shared' ? 'amber">Shared link' : 'gray">Individual') + '</span>' +
        '<div class="sub">' + esc(r.token.slice(0, 10)) + '…' + (r.legacy ? ' · legacy' : '') + '</div></td>' +
      '<td>' + accountCell(r) + '</td>' +
      '<td>' + esc(r.plan || "—") + '<div class="sub">' + esc(money(r)) + (r.billing_cycle ? " · " + esc(r.billing_cycle) : "") + '</div></td>' +
      '<td>' + expPill(r) + '<div class="sub">' + esc(r.supplier_expires || "") + '</div>' +
        (r.revoked ? "" : '<button class="mini cell-action" data-a="check" data-t="' + r.token + '" title="Check supplier dates and quota; payment stays unchanged">Check</button>') + '</td>' +
      '<td>' + quotaCell(r) + '</td>' +
      '<td>' + paymentCell(r) +
        (r.revoked ? "" : '<button class="mini pay cell-action" data-a="pay" data-t="' + r.token + '">Pay</button>') + '</td>' +
      '<td><span class="lnk" title="' + esc(one) + '">' + esc(one) + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="mini" data-a="copy" data-v="' + esc(one) + '">copy</button>' +
        '<button class="mini" data-a="edit" data-t="' + r.token + '">edit</button>' +
        '<button class="mini" data-a="rotate" data-t="' + r.token + '">rotate</button>' +
        (r.revoked ? "" : '<button class="mini danger" data-a="revoke" data-t="' + r.token + '">revoke</button>') +
      '</td></tr>';
  }).join("") : '<tr><td colspan="8" class="dim loading">No customers match.</td></tr>';
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
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  DATA = j.customers || [];
  renderStats(j.stats); render();
}

$("#q").addEventListener("input", (e) => { Q = e.target.value; render(); });
$("#filter").addEventListener("change", (e) => { FILTER = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { SORT = e.target.value; render(); });

$("#refresh").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "⟳ Checking supplier…";
  try {
    const response = await fetch("/admin/refresh");
    const j = await response.json();
    if (!response.ok) throw new Error(j.error || ("HTTP " + response.status));
    toast("Payments unchanged. Updated " + j.updated + " of " + j.checked + (j.failed ? " (" + j.failed + " failed)" : ""));
    await load();
  } catch (err) { toast("Refresh failed: " + err.message); }
  e.target.disabled = false; e.target.textContent = "⟳ Refresh quota";
});

function syncCustomerType() {
  const f = $("#form").elements;
  const shared = f.customer_type.value === "shared";
  f.supplier_account.readOnly = shared;
  $("#link-label").textContent = shared ? "Existing customer's link" : "Original supplier link";
  f.link.placeholder = shared ? "Paste the first customer's SP VPN link (or their registered supplier URL)" : "https://your-supplier/api/v1/client/subscribe?token=…";
  $("#account-help").textContent = shared
    ? "The supplier account is inherited automatically. This customer keeps a separate payment record."
    : "Name the supplier account used by this link. Shared customers will inherit it.";
  $("#shared-account").hidden = !shared;
  clearTimeout(sharedTimer); sharedSequence++;
  if (!shared) return;
  if (EDIT_ROW) {
    $("#shared-account").textContent = "Uses supplier account: " + (EDIT_ROW.supplier_account?.name || "Not recorded");
    return;
  }
  f.supplier_account.value = "";
  $("#shared-account").textContent = "Paste the original customer's link to find their supplier account.";
  if (f.link.value.trim()) lookupSharedAccount();
}

async function lookupSharedAccount() {
  const f = $("#form").elements;
  if (EDIT_ROW || f.customer_type.value !== "shared") return;
  const seq = ++sharedSequence;
  f.supplier_account.value = "";
  const box = $("#shared-account");
  if (!f.link.value.trim()) { box.textContent = "Paste the original customer's link to find their supplier account."; return; }
  box.textContent = "Finding supplier account…";
  try {
    const response = await fetch("/admin/shared-link", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link: f.link.value.trim() }).toString(),
    });
    const j = await response.json();
    if (seq !== sharedSequence) return;
    if (!response.ok) throw new Error(j.error || ("HTTP " + response.status));
    f.supplier_account.value = j.account.name;
    box.textContent = "Supplier account: " + j.account.name + " · " + j.account.host +
      " · currently used by " + j.account.customers + " customer(s). Payment is tracked separately.";
  } catch (err) {
    if (seq === sharedSequence) box.textContent = err.message;
  }
}

function openModal(row) {
  clearTimeout(closeTimer);
  EDIT_ROW = row;
  const form = $("#form"), f = form.elements;
  form.reset(); $("#result").textContent = ""; $("#result").className = "result";
  $("#mtitle").textContent = row ? "Edit " + (row.customer || row.label || "customer") : "Add customer";
  f.token.value = row ? row.token : "";
  f.link.disabled = !!row;
  f.customer_type.value = row?.customer_type || "individual";
  f.supplier_account.value = row?.supplier_account?.name || "";
  $("#save").disabled = false;
  $("#save").textContent = row ? "Save changes" : "Create customer";
  if (row) {
    for (const k of ["customer", "plan", "price", "currency", "billing_cycle", "notes", "label"])
      if (row[k] != null && f[k]) f[k].value = row[k];
  }
  syncCustomerType();
  $("#modal").hidden = false;
}
$("#customer-type").addEventListener("change", syncCustomerType);
$("#form").elements.link.addEventListener("input", () => {
  clearTimeout(sharedTimer); sharedSequence++;
  if ($("#form").elements.customer_type.value === "shared") {
    $("#form").elements.supplier_account.value = "";
    $("#shared-account").textContent = "Finding supplier account…";
    sharedTimer = setTimeout(lookupSharedAccount, 300);
  }
});
$("#add").addEventListener("click", () => openModal(null));
$("#cancel").addEventListener("click", () => {
  $("#modal").hidden = true; clearTimeout(sharedTimer); sharedSequence++;
});

function openPay(row) {
  const form = $("#pay-form"), f = form.elements;
  form.reset(); f.token.value = row.token;
  const today = new Date().toISOString().slice(0, 10);
  f.paid_until.min = today;
  // A suggestion only: nothing is saved until Pay is explicitly confirmed.
  f.paid_until.value = [row.paid_until, row.supplier_expires].filter((d) => d && d >= today).sort().pop() || "";
  $("#pay-title").textContent = "Record payment — " + (row.customer || row.label || "customer");
  $("#pay-info").textContent = "Previously paid until: " + (row.paid_until || "not recorded") +
    ". Supplier expiry (last checked): " + (row.supplier_expires || "unknown") + ".";
  $("#pay-result").textContent = "";
  $("#pay-save").disabled = false;
  $("#pay-modal").hidden = false;
  f.paid_until.focus();
}
$("#pay-cancel").addEventListener("click", () => ($("#pay-modal").hidden = true));
$("#pay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target, f = form.elements, button = $("#pay-save"), result = $("#pay-result");
  if (button.disabled || !form.reportValidity()) return;
  button.disabled = true; $("#pay-cancel").disabled = true; result.textContent = "";
  try {
    const response = await fetch("/admin/link/" + encodeURIComponent(f.token.value) + "?action=pay", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ paid_until: f.paid_until.value }).toString(),
    });
    const j = await response.json();
    if (!response.ok) throw new Error(j.error || ("HTTP " + response.status));
    $("#pay-modal").hidden = true;
    toast("Payment recorded for this customer only, until " + j.paid_until);
    try { await load(); } catch (err) { toast("Payment saved. Reload the dashboard to see it."); }
  } catch (err) {
    result.className = "result err"; result.textContent = err.message;
  } finally { button.disabled = false; $("#pay-cancel").disabled = false; }
});

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  const editing = !!d.token;
  const res = $("#result"), button = $("#save");
  let created = false;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const r = await fetch(editing ? "/admin/customer" : "/admin/mint", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(d).toString(),
    });
    const j = await r.json();
    if (!r.ok) { res.className = "result err"; res.textContent = j.error || ("HTTP " + r.status); return; }
    created = !editing;
    res.className = "result ok";
    res.textContent = editing ? "Saved." : "Created. Send this to the customer:  " + j.oneLink;
    if (!editing) { await load(); closeTimer = setTimeout(() => ($("#modal").hidden = true), 1400); }
    else { await load(); $("#modal").hidden = true; toast("Saved"); }
  } catch (err) { res.className = "result err"; res.textContent = err.message; }
  finally { button.disabled = created; }
});

$("#rows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  if (a === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.v); toast("Link copied"); }
    catch (err) { toast("Copy failed — select the link manually"); }
    return;
  }
  if (b.disabled) return;
  if (a === "pay") { openPay(DATA.find((r) => r.token === b.dataset.t)); return; }
  if (a === "check") {
    const original = b.textContent; b.disabled = true; b.textContent = "checking…";
    try {
      const response = await fetch("/admin/link/" + b.dataset.t + "?action=check");
      const j = await response.json();
      if (!response.ok) throw new Error(j.error || ("HTTP " + response.status));
      await load();
      if (j.expiryChanged) toast("Supplier expiry updated to " + (j.expiry || "unknown") + ". Payment unchanged.");
      else toast("Checked: expiry " + (j.expiry || "unknown") + ". Payment unchanged.");
    } catch (err) {
      toast("Supplier check failed: " + err.message);
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

load().catch((err) => toast("Dashboard could not load: " + err.message));
`;
