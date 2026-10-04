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
export function isSystemGeneratedRow(r) {
  return !!(r && !r.customer && (r.system_generated || r.label === "quota-page" || r.label === "seller-tool"));
}

export function systemGeneratedLabel(r) {
  if ((r && r.label) === "quota-page") return "Anonymous quota check";
  if ((r && r.label) === "seller-tool") return "Seller-tool generated link";
  return "System-generated link";
}

export function summarise(rows) {
  const now = new Date();
  const day = (d) => {
    if (!d) return null;
    const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
    return Number.isNaN(t) ? null : Math.round((t - Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000);
  };

  // Anonymous quota-check links and seller-tool scratch links are useful
  // records, but they are NOT paying customers. Keep them visible on their own
  // filter, while excluding them from customer counts, renewal alerts, MRR and
  // profit so the dashboard stays financially accurate.
  const generated = rows.filter(isSystemGeneratedRow);
  const customerRows = rows.filter((r) => !isSystemGeneratedRow(r));
  const active = customerRows.filter((r) => !r.revoked);
  const revoked = customerRows.filter((r) => r.revoked);

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
  // plan (see plans.js). Unknown plans are excluded rather than guessed.
  const profits = active.map(profitOf).filter((p) => p !== null);
  const profitMonthly = profits.length ? profits.reduce((a, b) => a + b, 0) : null;

  // Legacy base64 tokens cannot be revoked — worth knowing how many remain.
  const legacy = active.filter((r) => r.legacy).length;

  return {
    total: customerRows.length,
    allLinks: rows.length,
    generatedLinks: generated.length,
    generatedActive: generated.filter((r) => !r.revoked).length,
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
<meta name="theme-color" content="#0a0808">
<title>SP VPN — Dashboard</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="/admin" aria-label="SP VPN dashboard">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none"><path d="M16 3.5 27 7.8v7.6c0 6.1-4.3 10.9-11 13.1C9.3 26.3 5 21.5 5 15.4V7.8L16 3.5Z" fill="currentColor" opacity=".18"/><path d="M16 4.5 26 8.3v7.1c0 5.4-3.6 9.8-10 12-6.4-2.2-10-6.6-10-12V8.3l10-3.8Z" stroke="currentColor" stroke-width="1.8"/><path d="m11 16 3.2 3.2 6.8-7" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span class="brand-copy"><h1>SP VPN</h1><span>reseller dashboard</span></span>
    </a>
    <div class="top-actions">
      <button id="healthpill" class="pillbtn" title="System health — click for details" aria-label="System health">● checking…</button>
      <span class="live-status"><i></i><span>Live workspace</span></span>
      <a href="/qr" class="btn btn-secondary" style="text-decoration:none" title="Open QR Code Maker">📱 QR Maker</a>
      <button id="refresh" class="btn btn-secondary" aria-label="Refresh quota" title="Fetch live quota &amp; expiry from the supplier">
        <span class="btn-symbol" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="M16.7 8A7 7 0 0 0 4.2 5.5L3 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M3 3.5V7h3.5M3.3 12A7 7 0 0 0 15.8 14.5L17 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M17 16.5V13h-3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>
        <span class="btn-label">Refresh data</span>
      </button>
      <button id="add" class="btn btn-primary"><span class="plus" aria-hidden="true">＋</span> Add customer</button>
      <a id="logout" class="btn btn-secondary" href="/admin/logout" title="Sign out of the admin dashboard" aria-label="Sign out">🔓<span class="btn-label"> Sign out</span></a>
    </div>
  </div>
</header>

<main class="wrap page-main">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow"><span class="eyebrow-line"></span> OPERATIONS OVERVIEW</p>
      <h2 id="hero-title">Keep every customer <em>connected.</em></h2>
      <p class="hero-lede">A clear view of renewals, usage, and revenue — so the next action is always easy to spot.</p>
      <div class="hero-foot"><span class="pulse-ring"><i></i></span><span id="sync">Waiting for your first sync</span></div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="art-glow"></div>
      <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
      <div class="art-core"><span>SP</span><i></i></div>
      <span class="art-node node-one"></span><span class="art-node node-two"></span><span class="art-node node-three"></span>
      <div class="art-card art-card-top"><span class="art-card-icon">↗</span><span><b>Renewals</b><small>stay ahead</small></span></div>
      <div class="art-card art-card-bottom"><span class="art-card-icon green">✓</span><span><b>Protected</b><small>links stay private</small></span></div>
    </div>
  </section>

  <section id="stats" class="stats" aria-label="Key metrics"></section>

  <section class="customer-panel" aria-labelledby="customers-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow"><span class="eyebrow-line"></span> YOUR NETWORK</p>
        <h2 id="customers-title">Customer links</h2>
        <p class="panel-subtitle">Manage access, billing, and subscription health from one place.</p>
      </div>
      <div class="tracked-count"><strong id="activeCount">—</strong><span>accounts tracked</span></div>
    </div>

    <div class="toolbar">
      <label class="search-field" for="q">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.3" stroke="currentColor" stroke-width="1.7"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input id="q" type="search" placeholder="Search customers, plans, or tokens…" autocomplete="off">
      </label>
      <div class="toolbar-spacer"></div>
      <label class="select-wrap"><span class="sr-only">Filter customer links</span><select id="filter" aria-label="Filter customer links">
        <option value="all">Customers</option>
        <option value="action">Needs attention</option>
        <option value="generated">Anonymous quota checks</option>
        <option value="all-links">All links</option>
        <option value="expiring">Expiring ≤ 30 days</option>
        <option value="overdue">Overdue</option>
        <option value="legacy">Legacy links</option>
        <option value="revoked">Revoked</option>
      </select></label>
      <label class="select-wrap"><span class="sr-only">Sort customer links</span><select id="sort" aria-label="Sort customer links">
        <option value="expiry">Sort: expiry</option>
        <option value="name">Sort: name</option>
        <option value="price">Sort: price</option>
        <option value="created">Sort: newest</option>
      </select></label>
      <span id="meta" class="results-meta"></span>
    </div>

    <div class="tablewrap">
      <table>
        <thead><tr>
          <th>Customer</th><th>Plan &amp; billing</th><th>Renewal</th><th>Data usage</th><th>Paid through</th><th>Share link</th><th><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="7" class="loading"><span class="loader"></span> Loading your customers…</td></tr></tbody>
      </table>
    </div>
    <div class="panel-footer"><span class="footer-dot"></span> Supplier URLs are private and never shown here. Anonymous quota-check links are hidden from customer totals by default.</div>
  </section>
</main>

<div id="modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="mtitle">
  <div class="sheet">
    <div class="sheet-heading">
      <div><p class="eyebrow"><span class="eyebrow-line"></span> CUSTOMER PROFILE</p><h2 id="mtitle">Add customer</h2><p id="mhelp" class="sheet-help">Create a private link and keep its billing details close by.</p></div>
      <button type="button" id="close" class="icon-button" aria-label="Close dialog">×</button>
    </div>
    <form id="form">
      <input type="hidden" name="token">
      <input type="hidden" name="supplier_expires">
      <input type="hidden" name="total_gb">
      <input type="hidden" name="used_gb">
      <div class="form-section"><p class="form-section-title">Connection</p>
        <label>Supplier link <span class="req">*</span>
          <textarea name="link" rows="2" placeholder="https://your-supplier/api/v1/client/subscribe?token=…"></textarea>
          <small class="field-hint">Stored securely on the server. It is never included in customer links.</small>
        </label>
        <div id="peek" class="peek" hidden></div>
      </div>
      <div class="form-section"><p class="form-section-title">Customer details</p>
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
          <label>Panel account email <input name="account_email" type="email" placeholder="customer@gmail.com" title="Supplier panel login used to renew this customer"></label>
          <label>Panel password <input name="account_password" value="${esc(PANEL_PASSWORD_DEFAULT)}" title="Shared supplier panel password"></label>
        </div>
        <label>Notes <input name="notes" placeholder="Telegram @ali"></label>
      </div>
      <div id="result" class="result" aria-live="polite"></div>
      <div class="macts"><button type="button" id="cancel" class="btn btn-secondary">Cancel</button><button type="submit" class="btn btn-primary" id="save">Create private link</button></div>
    </form>
  </div>
</div>

<div id="healthmodal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="health-title">
  <div class="sheet">
    <div class="sheet-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span> SYSTEM STATUS</p><h2 id="health-title">System health</h2><p class="sheet-help">A quick end-to-end check of the store, supplier, and converter.</p></div><button type="button" id="healthclose" class="icon-button" aria-label="Close dialog">×</button></div>
    <div id="healthbody"><div class="loading"><span class="loader"></span> Checking…</div></div>
    <div class="macts"><button type="button" id="healthre" class="btn btn-secondary">↻ Re-check now</button><button type="button" id="healthdone" class="btn btn-primary">Done</button></div>
  </div>
</div>

<div id="toast" class="toast" hidden role="status"></div>
<script>${CLIENT.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}

const CSS = `
:root{
  --bg:#0a0808;--bg-deep:#050405;--surface:#141013;--surface-raised:#1a1418;--surface-soft:#100c0e;
  --line:rgba(255,110,122,.13);--line-strong:rgba(255,110,122,.22);--text:#f6f1f2;--muted:#a08e96;
  --muted-strong:#c2b1b9;--mint:#ff4d57;--mint-soft:rgba(255,77,87,.12);--violet:#d81b3f;
  --blue:#f0555f;--amber:#f7c96b;--red:#ff7d84;--shadow:0 24px 70px rgba(0,0,0,.28)
}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{background:var(--bg-deep);scroll-behavior:smooth}
body{margin:0;min-width:320px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:var(--text);background:radial-gradient(900px 520px at 74% -12%,rgba(220,38,38,.17),transparent 65%),radial-gradient(700px 480px at 3% 38%,rgba(220,38,38,.07),transparent 68%),var(--bg);line-height:1.45}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.32;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 76%)}
button,input,textarea,select{font:inherit}
button{appearance:none}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--mint);outline-offset:2px}
.wrap{width:100%;max-width:1320px;margin:0 auto;padding-left:32px;padding-right:32px}
.topbar{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:rgba(10,8,9,.78);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.topbar-inner{min-height:78px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{display:inline-flex;align-items:center;gap:12px;color:var(--text);text-decoration:none;min-width:190px}
.brand-mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(255,77,87,.28);border-radius:12px;color:var(--mint);background:linear-gradient(145deg,rgba(255,77,87,.16),rgba(216,27,63,.14));box-shadow:inset 0 1px rgba(255,255,255,.08)}
.brand-mark svg{width:26px;height:26px}.brand-copy{display:flex;flex-direction:column;line-height:1}.brand-copy h1{margin:0 0 5px;font-size:15px;letter-spacing:.04em;font-weight:800}.brand-copy span{color:var(--muted);font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
.top-actions{display:flex;align-items:center;gap:10px}.live-status{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;color:var(--muted-strong);font-size:12px;border:1px solid var(--line);border-radius:999px;background:rgba(18,13,16,.55)}.live-status i,.pulse-ring i{display:block;width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 4px rgba(255,77,87,.1),0 0 13px rgba(255,77,87,.8)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:10px;padding:10px 14px;color:var(--text);font-size:12px;font-weight:750;line-height:1;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,background .18s ease}.btn:hover{transform:translateY(-1px)}.btn:active{transform:translateY(0)}.btn:disabled{opacity:.55;cursor:default;transform:none}.btn-primary{background:linear-gradient(135deg,#e8323f,#a3131f);color:#ffffff;box-shadow:0 8px 22px rgba(220,38,38,.16)}.btn-primary:hover{box-shadow:0 10px 28px rgba(220,38,38,.28)}.btn-secondary{background:rgba(24,18,22,.85);border-color:var(--line-strong);color:var(--muted-strong)}.btn-secondary:hover{border-color:rgba(255,77,87,.42);color:var(--text);background:rgba(32,22,27,.92)}.btn-symbol{display:grid;place-items:center}.btn-symbol svg{width:16px;height:16px}.plus{font-size:17px;font-weight:400;line-height:10px;margin-left:-2px}
.page-main{padding-top:44px;padding-bottom:88px;position:relative}.hero{min-height:224px;position:relative;display:grid;grid-template-columns:minmax(0,1fr) 360px;align-items:center;overflow:hidden;margin-bottom:27px;padding:34px 48px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(110deg,rgba(26,18,22,.9),rgba(14,10,12,.7) 52%,rgba(43,15,20,.72));box-shadow:var(--shadow)}.hero:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(255,77,87,.045),transparent 34%,rgba(216,27,63,.08))}.hero-copy{position:relative;z-index:2;max-width:600px}.eyebrow{display:flex;align-items:center;gap:9px;margin:0 0 12px;color:var(--mint);font-size:10px;font-weight:800;letter-spacing:.18em}.eyebrow-line{width:22px;height:1px;background:currentColor;opacity:.75}.hero h2{margin:0;font-size:clamp(28px,4vw,45px);letter-spacing:-.045em;line-height:1.08;font-weight:780}.hero h2 em{font-style:normal;color:var(--mint)}.hero-lede{max-width:490px;margin:14px 0 19px;color:var(--muted);font-size:14px;line-height:1.65}.hero-foot{display:flex;align-items:center;gap:9px;color:var(--muted-strong);font-size:11px}.pulse-ring{display:grid;place-items:center;width:16px;height:16px}.pulse-ring i{width:6px;height:6px}.hero-art{position:absolute;right:30px;top:0;width:400px;height:100%;opacity:.95}.art-glow{position:absolute;width:280px;height:220px;right:28px;top:4px;background:radial-gradient(circle,rgba(255,77,87,.14),rgba(216,27,63,.1) 36%,transparent 69%);filter:blur(8px)}.art-orbit{position:absolute;border:1px solid rgba(255,125,132,.18);border-radius:50%;transform:rotate(-24deg)}.orbit-one{width:270px;height:132px;right:47px;top:47px}.orbit-two{width:170px;height:250px;right:95px;top:-10px;transform:rotate(43deg)}.art-core{position:absolute;display:grid;place-items:center;right:150px;top:78px;width:80px;height:80px;border:1px solid rgba(255,77,87,.38);border-radius:50%;background:radial-gradient(circle at 35% 25%,rgba(255,77,87,.27),rgba(24,18,22,.9) 66%);box-shadow:0 0 0 12px rgba(255,77,87,.035),0 0 45px rgba(255,77,87,.18)}.art-core span{font-size:15px;letter-spacing:.1em;font-weight:850;color:var(--mint)}.art-core i{position:absolute;right:10px;top:10px;width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 10px var(--mint)}.art-node{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--violet);box-shadow:0 0 14px rgba(216,27,63,.9)}.node-one{right:66px;top:66px}.node-two{right:92px;bottom:36px;background:var(--mint);box-shadow:0 0 14px rgba(255,77,87,.9)}.node-three{right:274px;top:46px;background:var(--amber);box-shadow:0 0 14px rgba(247,201,107,.9)}.art-card{position:absolute;display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--line-strong);border-radius:11px;background:rgba(22,16,19,.82);box-shadow:0 12px 25px rgba(0,0,0,.22);backdrop-filter:blur(8px)}.art-card b,.art-card small{display:block}.art-card b{font-size:10px}.art-card small{color:var(--muted);font-size:9px;margin-top:2px}.art-card-top{right:4px;top:33px}.art-card-bottom{right:39px;bottom:24px}.art-card-icon{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;color:var(--violet);background:rgba(216,27,63,.14);font-size:14px}.art-card-icon.green{color:var(--mint);background:rgba(255,77,87,.13)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:29px}.stat{position:relative;min-height:132px;overflow:hidden;padding:17px 18px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,rgba(24,18,22,.9),rgba(15,11,14,.84));box-shadow:0 12px 26px rgba(0,0,0,.1);transition:border-color .2s ease,transform .2s ease}.stat:after{content:"";position:absolute;right:-25px;bottom:-45px;width:110px;height:110px;border-radius:50%;background:var(--stat-glow,rgba(255,77,87,.07));filter:blur(4px)}.stat:hover{transform:translateY(-2px);border-color:var(--line-strong)}.stat-head{position:relative;z-index:1;display:flex;align-items:center;gap:9px}.stat-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;color:var(--mint);background:var(--mint-soft)}.stat-icon svg{width:14px;height:14px}.stat-kicker{color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.stat-value{position:relative;z-index:1;display:block;margin-top:17px;color:var(--text);font-size:27px;letter-spacing:-.04em;line-height:1;font-weight:790}.stat-caption{position:relative;z-index:1;display:block;margin-top:9px;color:var(--muted);font-size:11px}.stat.bad{--stat-glow:rgba(255,125,132,.1)}.stat.bad .stat-icon{color:var(--red);background:rgba(255,125,132,.11)}.stat.bad .stat-value{color:#ffabb0}.stat.warn{--stat-glow:rgba(247,201,107,.1)}.stat.warn .stat-icon{color:var(--amber);background:rgba(247,201,107,.11)}.stat.warn .stat-value{color:#f9d98d}.stat.good .stat-icon{color:var(--mint)}
.customer-panel{padding:27px 27px 0;border:1px solid var(--line);border-radius:22px;background:linear-gradient(145deg,rgba(19,14,17,.94),rgba(12,9,11,.92));box-shadow:var(--shadow)}.panel-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:0 2px 24px}.panel-heading .eyebrow{margin-bottom:8px}.panel-heading h2{margin:0;font-size:23px;letter-spacing:-.03em}.panel-subtitle{margin:5px 0 0;color:var(--muted);font-size:12px}.dim{color:var(--muted);font-size:11px}.tracked-count{display:flex;align-items:flex-end;gap:9px;padding-bottom:2px}.tracked-count strong{font-size:24px;letter-spacing:-.04em}.tracked-count span{color:var(--muted);font-size:11px;padding-bottom:3px}.toolbar{display:flex;align-items:center;gap:9px;min-height:54px;padding:8px 10px;margin-bottom:12px;border:1px solid var(--line);border-radius:13px;background:rgba(12,9,11,.65)}.search-field{display:flex;align-items:center;gap:9px;flex:1;min-width:190px;color:var(--muted)}.search-field svg{width:17px;height:17px;flex:none}.search-field input{width:100%;min-width:0;border:0;background:transparent;color:var(--text);font-size:12px;outline:0}.search-field input::placeholder{color:#9c828c}.toolbar-spacer{flex:1}.select-wrap{position:relative}.select-wrap:after{content:"⌄";position:absolute;right:11px;top:7px;color:var(--muted);font-size:14px;pointer-events:none}.toolbar select{appearance:none;min-width:144px;padding:8px 29px 8px 11px;border:1px solid var(--line);border-radius:8px;outline:0;background:var(--surface-soft);color:var(--muted-strong);font-size:11px;cursor:pointer}.toolbar select:hover{border-color:var(--line-strong);color:var(--text)}.results-meta{display:inline-block;min-width:78px;color:var(--muted);font-size:11px;text-align:right;white-space:nowrap}.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:rgba(10,8,9,.48)}table{width:100%;min-width:1110px;border-collapse:collapse;font-size:12px}th{padding:13px 15px;text-align:left;border-bottom:1px solid var(--line);color:#a58a93;font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}td{padding:15px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr{transition:background .18s ease}tbody tr:hover{background:rgba(255,77,87,.035)}tr.revoked{opacity:.54}tr.generated{background:rgba(247,201,107,.025)}tr.generated .avatar{color:var(--amber);background:rgba(247,201,107,.12)}.customer-cell{display:flex;align-items:center;gap:11px;min-width:170px}.avatar{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:11px;color:#ffb3b8;background:linear-gradient(145deg,rgba(255,77,87,.22),rgba(216,27,63,.24));font-size:11px;font-weight:850;letter-spacing:.04em}.nm{font-size:12px;font-weight:750;white-space:nowrap}.sub{display:block;margin-top:3px;color:var(--muted);font-size:10px;line-height:1.35}.plan-cell{min-width:150px;color:var(--muted-strong);font-weight:650}.renewal-cell{min-width:130px}.date{margin-top:4px;color:var(--muted);font-size:10px}.usage-cell{width:186px;min-width:186px}.usage-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:var(--muted-strong);font-size:10px}.usage-top b{color:var(--text);font-weight:700}.bar{height:6px;overflow:hidden;border-radius:99px;background:#0a0808;box-shadow:inset 0 0 0 1px rgba(255,255,255,.035)}.bar i{display:block;height:100%;min-width:3px;border-radius:inherit;background:linear-gradient(90deg,var(--mint),#dc2626);box-shadow:0 0 9px rgba(255,77,87,.25)}.bar i.hot{background:linear-gradient(90deg,var(--amber),var(--red));box-shadow:0 0 9px rgba(255,125,132,.25)}.paid-cell{min-width:130px;color:var(--muted-strong);font-size:11px;white-space:nowrap}.paid-cell .pill{margin-left:4px}.lnk{display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--blue);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.link-cell{min-width:190px}.link-caption{display:flex;align-items:center;gap:5px;margin-top:4px;color:var(--muted);font-size:10px}.link-caption svg{width:11px;height:11px}.pill{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:750;white-space:nowrap}.pill:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}.pill.red{color:var(--red);background:rgba(255,125,132,.11)}.pill.amber{color:var(--amber);background:rgba(247,201,107,.11)}.pill.green{color:var(--mint);background:rgba(255,77,87,.11)}.pill.gray{color:var(--muted);background:rgba(255,125,132,.11)}.mini{display:inline-flex;align-items:center;justify-content:center;padding:6px 8px;margin:0 3px 3px 0;border:1px solid var(--line);border-radius:7px;background:rgba(24,18,22,.76);color:var(--muted-strong);font-size:10px;cursor:pointer;transition:all .18s ease}.mini:hover{border-color:rgba(255,77,87,.45);color:var(--mint);background:rgba(255,77,87,.07)}.mini.danger:hover{border-color:rgba(255,125,132,.48);color:var(--red);background:rgba(255,125,132,.07)}
.mini[data-a="renew"]{border-color:rgba(255,77,87,.38);color:var(--mint);font-weight:800}
.mini[data-a="renew"]:hover{border-color:rgba(255,77,87,.62);background:rgba(255,77,87,.12);color:var(--mint)}
.mini:disabled{opacity:.55;cursor:default}
.delta{margin-top:6px;font-size:10px;font-weight:750;line-height:1.45;word-break:break-word}
.delta.up{color:var(--amber)}
.delta.reset{color:var(--mint)}
.delta.flat{color:var(--muted)}.actions-cell{min-width:250px;white-space:nowrap}.panel-footer{display:flex;align-items:center;gap:7px;padding:13px 2px 15px;color:var(--muted);font-size:10px}.footer-dot{width:5px;height:5px;border-radius:50%;background:var(--mint);box-shadow:0 0 8px rgba(255,77,87,.65)}.loading{text-align:center!important;padding:52px!important;color:var(--muted);font-size:12px}.loader{display:inline-block;width:13px;height:13px;margin-right:7px;vertical-align:-2px;border:2px solid rgba(255,77,87,.2);border-top-color:var(--mint);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.modal{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:38px 18px;background:rgba(8,5,6,.76);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}.sheet{width:100%;max-width:570px;padding:27px;border:1px solid var(--line-strong);border-radius:22px;background:linear-gradient(145deg,#1a1418,#0f0b0d);box-shadow:0 30px 90px rgba(0,0,0,.5)}.sheet-heading{display:flex;justify-content:space-between;gap:18px;margin-bottom:23px}.sheet-heading .eyebrow{margin-bottom:9px}.sheet h2{margin:0;font-size:22px;letter-spacing:-.03em}.sheet-help{margin:5px 0 0;color:var(--muted);font-size:12px}.icon-button{display:grid;place-items:center;flex:none;width:31px;height:31px;border:1px solid var(--line);border-radius:9px;background:rgba(10,8,9,.5);color:var(--muted);font-size:22px;line-height:1;cursor:pointer}.icon-button:hover{border-color:var(--line-strong);color:var(--text)}.form-section{padding-top:2px}.form-section+.form-section{margin-top:21px;padding-top:19px;border-top:1px solid var(--line)}.form-section-title{margin:0 0 13px;color:var(--muted-strong);font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}label{display:block;margin-bottom:13px;color:var(--muted-strong);font-size:11px;font-weight:700}label input,label textarea{display:block;width:100%;margin-top:6px;padding:10px 11px;border:1px solid var(--line);border-radius:9px;outline:0;background:rgba(10,8,9,.64);color:var(--text);font-size:12px;line-height:1.35;transition:border-color .18s ease,background .18s ease}label input:hover,label textarea:hover{border-color:var(--line-strong)}label input:focus,label textarea:focus{border-color:rgba(255,77,87,.6);background:rgba(10,8,9,.85)}label textarea{resize:vertical;min-height:64px}.field-hint{display:block;margin-top:6px;color:var(--muted);font-size:10px;font-weight:400;line-height:1.5}.req{color:var(--red)}.two{display:grid;grid-template-columns:1fr 1fr;gap:13px}.result{min-height:0;margin:5px 0;color:var(--muted);font-size:11px;line-height:1.6;word-break:break-word}.result.ok{color:var(--mint)}.result.err{color:var(--red)}.macts{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}.pillbtn{display:inline-flex;align-items:center;gap:6px;padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:rgba(18,13,16,.7);color:var(--muted);font-size:10px;font-weight:800;white-space:nowrap;cursor:pointer;transition:all .18s ease}.pillbtn:hover{border-color:var(--line-strong);color:var(--text)}.pillbtn.ok{border-color:rgba(255,77,87,.5);color:var(--mint);background:rgba(255,77,87,.08)}.pillbtn.warn{border-color:rgba(247,201,107,.5);color:var(--amber);background:rgba(247,201,107,.08)}.pillbtn.bad{border-color:rgba(255,125,132,.5);color:var(--red);background:rgba(255,125,132,.08)}.peek{margin-top:7px;color:var(--muted);font-size:10px;line-height:1.55;word-break:break-word}.peek.ok{color:var(--mint)}.peek.err{color:var(--red)}.hrow{display:flex;gap:10px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line);font-size:11px;line-height:1.5}.hrow:last-child{border-bottom:0}.hdot{width:8px;height:8px;flex:none;margin-top:4px;border-radius:50%;background:var(--muted)}.hdot.ok{background:var(--mint);box-shadow:0 0 8px rgba(255,77,87,.7)}.hdot.bad{background:var(--red);box-shadow:0 0 8px rgba(255,125,132,.6)}.hname{min-width:100px;color:var(--muted-strong);font-weight:750}.hdetail{flex:1;color:var(--muted)}.onelink{padding:9px 11px;margin:8px 0;border:1px solid var(--line);border-radius:9px;background:rgba(10,8,9,.62);color:var(--blue);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all;user-select:all}.msgbox{padding:10px 11px;margin:8px 0;border:1px solid var(--line);border-radius:9px;background:rgba(10,8,9,.62);color:var(--muted-strong);font-size:11px;line-height:1.6;white-space:pre-line;word-break:break-word}.mcpy{display:flex;gap:8px;flex-wrap:wrap}
.toast{position:fixed;right:28px;bottom:27px;z-index:60;max-width:min(380px,calc(100vw - 40px));padding:12px 16px;border:1px solid var(--line-strong);border-radius:11px;background:#1a1418;color:var(--text);box-shadow:0 14px 38px rgba(0,0,0,.4);font-size:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1020px){.stats{grid-template-columns:repeat(4,minmax(0,1fr))}.hero{grid-template-columns:1fr;padding-left:34px}.hero-art{right:-80px;opacity:.58}.hero-copy{max-width:560px}.top-actions .live-status{display:none}}
@media(max-width:760px){.pillbtn{font-size:0;padding:9px}.pillbtn:before{content:"●";font-size:10px}.wrap{padding-left:18px;padding-right:18px}.topbar-inner{min-height:68px}.brand{min-width:0}.top-actions{gap:7px}.btn{padding:10px}.btn-secondary .btn-label{display:none}.page-main{padding-top:25px;padding-bottom:55px}.hero{min-height:285px;margin-bottom:18px;padding:27px 23px;align-items:start;border-radius:18px}.hero h2{font-size:32px;max-width:390px}.hero-art{right:-105px;top:73px;opacity:.5;transform:scale(.86);transform-origin:top right}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:18px}.stat{min-height:119px;padding:14px}.stat-value{margin-top:14px;font-size:24px}.customer-panel{padding:21px 14px 0;border-radius:17px}.panel-heading{align-items:flex-start;padding:0 4px 18px}.panel-heading h2{font-size:21px}.panel-subtitle{max-width:230px}.tracked-count{display:none}.toolbar{align-items:stretch;flex-wrap:wrap;padding:8px}.search-field{flex-basis:100%;height:31px}.toolbar-spacer{display:none}.select-wrap{flex:1}.toolbar select{width:100%;min-width:0}.results-meta{width:100%;padding:0 2px;text-align:left}.tablewrap{margin:0 -1px}.sheet{padding:22px 18px}.toast{right:20px;bottom:20px}}
@media(max-width:480px){.brand-copy span{font-size:9px}.top-actions .btn-primary{padding:10px 11px}.hero{min-height:300px}.hero-lede{font-size:13px}.hero-art{right:-141px;top:91px}.two{grid-template-columns:1fr;gap:0}.sheet-heading{margin-bottom:18px}.macts{flex-direction:column-reverse}.macts .btn{width:100%}}
a#logout{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
/* --- mobile horizontal-overflow fix: only the table may scroll sideways --- */
html,body{max-width:100%;overflow-x:clip}
@supports not (overflow:clip){html,body{overflow-x:hidden}}
.topbar,.topbar-inner,.page-main,.wrap,.hero,.stats,.customer-panel,.toolbar,.tablewrap{max-width:100%;min-width:0}
.hero{overflow:hidden}
.tablewrap{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;background:var(--bg-deep)}
.tablewrap table{background:rgba(10,8,9,.48)}
.tablewrap thead th{background:#120d0f}
@media(max-width:760px){
.tablewrap{margin:0;box-shadow:inset -16px 0 16px -16px rgba(0,0,0,.75)}
.tablewrap table{min-width:940px;font-size:11px}
.tablewrap th,.tablewrap td{padding:11px 10px}
.usage-cell{width:150px;min-width:150px}
.lnk{max-width:140px}
.link-cell{min-width:150px}
.customer-cell{min-width:140px}
.hero-art{display:none}
}
@media(max-width:480px){
.tablewrap table{min-width:860px}
.toast{right:12px;left:12px;max-width:none}
}
`;

const CLIENT = `
let DATA = [], FILTER = "all", SORT = "expiry", Q = "";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const ICONS = {
  users: '<svg viewBox="0 0 20 20" fill="none"><path d="M13.5 16.2v-1.1a3 3 0 0 0-3-3H5.8a3 3 0 0 0-3 3v1.1M8.2 9.1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13.1 3.3a3 3 0 0 1 0 5.8M14.2 12.2h.8a3 3 0 0 1 3 3v1" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none"><path d="m10 2.5 7.1 13a1.1 1.1 0 0 1-1 1.6H3.9a1.1 1.1 0 0 1-1-1.6l7.1-13Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M10 7v4M10 14.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  calendar: '<svg viewBox="0 0 20 20" fill="none"><rect x="2.8" y="4.4" width="14.4" height="13" rx="2" stroke="currentColor" stroke-width="1.45"/><path d="M6 2.8v3.1M14 2.8v3.1M2.8 8.2h14.4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
  warning: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.7v8.1M10 14.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.45"/></svg>',
  coin: '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.3" stroke="currentColor" stroke-width="1.45"/><path d="M12.4 7.3c-.5-.5-1.2-.8-2.1-.8-1.2 0-2 .6-2 1.5 0 2.3 4.1 1 4.1 3.3 0 .9-.8 1.6-2 1.6-.9 0-1.7-.3-2.3-.9M10.3 5.2v9.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 20 20" fill="none"><path d="M7.8 12.2 12.2 7.8M7 8.8l-.9.9a3 3 0 0 0 4.2 4.2l.9-.9M13 11.2l.9-.9a3 3 0 0 0-4.2-4.2l-.9.9" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
  shield: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5 16 5v4.2c0 3.3-2.1 6.1-6 7.5-3.9-1.4-6-4.2-6-7.5V5l6-2.5Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="m7 9.9 2 2 4-4" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const daysTo = (d) => {
  if (!d) return null;
  const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
  return isNaN(t) ? null : Math.round((t - Date.parse(new Date().toISOString().slice(0,10) + "T00:00:00Z")) / 864e5);
};
const money = (r) => r.price == null ? "" : (r.currency || "") + " " + Number(r.price).toFixed(2);
const oneLinkOf = (r) => location.origin + "/all/" + encodeURIComponent(r.label || "SP VPN") + "?t=" + r.token;
// The ready-to-send message uses the fresh link returned by /admin/mint.
// Backslashes are doubled here because CLIENT itself is an outer template literal.
const readyMessage = (link) =>
  "Here is your official SP Connect link: 🔗\\n\\n" + link +
  "\\n\\nYour data package will be valid for 30 days from the activation date. Your data will be renewed every 30 days once you renew your package.\\n\\n" +
  "I'll send you a reminder 3 days before your renewal date, so you'll have enough time to renew without any interruption.\\n\\n" +
  "Thank you for choosing SP Connect! ❤️";
const prettyDate = (d) => {
  if (!d) return "";
  const p = String(d).slice(0, 10).split("-");
  if (p.length !== 3) return String(d);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))));
};
const initials = (name) => String(name || "SP").trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || "SP";

function toast(msg, ms) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms || 3000);
}

function expPill(r) {
  if (r.revoked) return '<span class="pill gray">revoked</span>';
  const d = daysTo(r.supplier_expires);
  if (d === null) return '<span class="pill gray">unknown</span>';
  if (d < 0) return '<span class="pill red">' + (-d) + 'd overdue</span>';
  if (d === 0) return '<span class="pill red">expires today</span>';
  if (d <= 7) return '<span class="pill red">' + d + 'd left</span>';
  if (d <= 30) return '<span class="pill amber">' + d + 'd left</span>';
  return '<span class="pill green">' + d + 'd left</span>';
}

// Usage movement since the previous successful check. The sentence itself is
// computed server-side (renewal.js) so the dashboard, the API and the tests
// can never drift apart. Empty string on a customer's FIRST successful check —
// there is no previous value, so there is nothing honest to say.
function usageDelta(r) {
  if (!r.usage_message) return "";
  const k = r.usage_change;
  const cls = k === "increase" ? "up" : k === "reset" ? "reset" : "flat";
  return '<div class="delta ' + cls + '">' + esc(r.usage_message) + '</div>';
}

function quotaCell(r) {
  const d = usageDelta(r);
  if (!r.total_gb) return '<span class="dim">No usage data</span>' + d;
  const total = Number(r.total_gb) || 0;
  const used = Math.max(0, Number(r.used_gb) || 0);
  const pct = Math.min(100, total ? (used / total) * 100 : 0);
  const left = Math.max(0, total - used);
  return '<div class="usage-top"><span>' + used.toFixed(1) + ' GB used</span><b>' + pct.toFixed(0) + '%</b></div>' +
    '<div class="bar"><i class="' + (pct > 85 ? "hot" : "") + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '<div class="sub">' + left.toFixed(1) + ' / ' + total + ' GB remaining</div>' + d;
}

function needsAction(r) {
  const e = daysTo(r.supplier_expires), p = daysTo(r.paid_until);
  return r.revoked || e === null || e <= 30 || (p !== null && p < 0) || r.legacy;
}

function isGenerated(r) { return !!(r && !r.customer && (r.system_generated || r.label === "quota-page" || r.label === "seller-tool")); }
function displayName(r) { return r.customer || (isGenerated(r) ? (r.label === "quota-page" ? "Anonymous quota check" : r.label === "seller-tool" ? "Seller-tool generated link" : "System-generated link") : (r.label || "Unnamed customer")); }

function rowsToShow() {
  let rs = DATA.slice();
  if (FILTER === "generated") rs = rs.filter(isGenerated);
  else if (FILTER !== "all-links") rs = rs.filter((r) => !isGenerated(r));
  const q = Q.toLowerCase();
  if (q) rs = rs.filter((r) => [r.customer, r.label, r.plan, r.token, r.notes, r.account_email, displayName(r)]
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

function actionButton(action, token, label, danger) {
  const key = (action === "copy" || action === "qr") ? "data-v" : "data-t";
  return '<button class="mini' + (danger ? ' danger' : '') + '" data-a="' + action + '" ' + key + '="' + esc(token) + '" aria-label="' + label + '">' + label + '</button>';
}

function render() {
  const rs = rowsToShow();
  const customers = DATA.filter((r) => !isGenerated(r));
  const generated = DATA.filter(isGenerated);
  const active = customers.filter((r) => !r.revoked).length;
  $("#activeCount").textContent = active;
  $("#meta").textContent = FILTER === "generated"
    ? rs.length + " of " + generated.length + " generated links"
    : FILTER === "all-links"
      ? rs.length + " of " + DATA.length + " links" + (generated.length ? " · " + generated.length + " generated" : "")
      : rs.length + " of " + customers.length + " customers" + (generated.length ? " · " + generated.length + " hidden generated" : "");
  $("#rows").innerHTML = rs.length ? rs.map((r) => {
    const generatedRow = isGenerated(r);
    const name = displayName(r);
    const one = oneLinkOf(r);
    const paidDays = daysTo(r.paid_until);
    const isPaid = r.paid_until != null && paidDays !== null && paidDays >= 0;
    const paid = r.paid_until
      ? prettyDate(r.paid_until) + (paidDays < 0
          ? ' <span class="pill red">unpaid</span>'
          : ' <span class="pill green">paid</span>')
      : '<span class="dim">Not recorded</span>';
    return '<tr class="' + (r.revoked ? "revoked " : "") + (generatedRow ? "generated" : "") + '">' +
      '<td><div class="customer-cell"><span class="avatar">' + esc(initials(name)) + '</span><div><div class="nm">' + esc(name) + '</div>' +
        '<div class="sub">' + esc(String(r.token || "").slice(0, 10)) + '…' + (r.legacy ? ' · legacy' : '') + (generatedRow ? ' · generated' : '') + '</div>' + (r.account_email ? '<div class="sub">✉ ' + esc(r.account_email) + '</div>' : '') + (generatedRow ? '<div class="sub">Not counted as a customer or profit.</div>' : '') + '</div></div></td>' +
      '<td class="plan-cell">' + esc(r.plan || (generatedRow ? "Not a customer record" : "No plan set")) + '<div class="sub">' + (generatedRow ? "Created by quota/tool page" : (esc(money(r)) + (r.billing_cycle ? " · " + esc(r.billing_cycle) : "") + (r.profit != null ? ' · <span style="color:var(--mint)">' + (r.profit > 0 ? "+" : "") + r.profit + ' net</span>' : ""))) + '</div></td>' +
      '<td class="renewal-cell">' + expPill(r) + '<div class="date">' + esc(prettyDate(r.supplier_expires) || "Not checked") + '</div></td>' +
      '<td class="usage-cell">' + quotaCell(r) + '</td>' +
      '<td class="paid-cell">' + paid + '</td>' +
      '<td class="link-cell"><span class="lnk" title="' + esc(one) + '">' + esc(one) + '</span><span class="link-caption"><svg viewBox="0 0 20 20" fill="none"><path d="M7.5 12.5 12.5 7.5M6 14a3 3 0 0 1 0-4.2l1.6-1.6M14 6a3 3 0 0 1 0 4.2l-1.6 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> private link</span></td>' +
      '<td class="actions-cell">' + (r.revoked || generatedRow ? "" : actionButton("renew", r.token, "Renew / Check")) + (generatedRow ? "" : actionButton(isPaid ? "unpaid" : "paid", r.token, isPaid ? "Mark unpaid" : "Mark paid")) + actionButton("copy", one, "Copy") + actionButton("qr", one, "QR") + actionButton("edit", r.token, generatedRow ? "Convert/Edit" : "Edit") + actionButton("rotate", r.token, "Rotate") + (r.revoked ? "" : actionButton("revoke", r.token, "Revoke", true)) + actionButton("delete", r.token, "Delete", true) + '</td>' +
      '</tr>';
  }).join("") : '<tr><td colspan="7" class="loading">No customers match these filters.</td></tr>';
}

function renderStats(s) {
  if (!s) return;
  const card = (v, l, cls, icon, caption) => '<article class="stat ' + (cls || "") + '"><div class="stat-head"><span class="stat-icon">' + icon + '</span><span class="stat-kicker">' + l + '</span></div><strong class="stat-value">' + v + '</strong><span class="stat-caption">' + caption + '</span></article>';
  $("#stats").innerHTML =
    card(s.active, "Active customers", "good", ICONS.users, "currently connected") +
    card(s.expiring7, "Expiring soon", s.expiring7 ? "bad" : "good", ICONS.alert, "within the next 7 days") +
    card(s.expiring30, "Renewal window", s.expiring30 ? "warn" : "good", ICONS.calendar, "8–30 days from now") +
    card(s.overdue, "Expired / overdue", s.overdue ? "bad" : "good", ICONS.warning, "needs a follow-up") +
    card(s.unpaid, "Unpaid", s.unpaid ? "bad" : "good", ICONS.coin, "past the paid-through date") +
    card(s.unknownExpiry, "Expiry unknown", s.unknownExpiry ? "warn" : "good", ICONS.calendar, "refresh to check status") +
    card((s.mrr || 0).toFixed(2), "Revenue / month", "", ICONS.coin, "active plans · before costs") +
    card(s.profitMonthly == null ? "—" : s.profitMonthly.toFixed(2), "Profit / month", s.profitMonthly == null ? "" : s.profitMonthly > 0 ? "good" : s.profitMonthly < 0 ? "bad" : "", ICONS.coin, "after catalogue cost") +
    card(s.generatedLinks || 0, "Anonymous checks", s.generatedLinks ? "warn" : "good", ICONS.link, "hidden from customer totals") +
    card(s.legacy, "Legacy links", s.legacy ? "warn" : "good", ICONS.shield, s.legacy ? "migrate when convenient" : "all links protected");
}

function setSync(generated) {
  const el = $("#sync");
  if (!generated) { el.textContent = "Ready for your first sync"; return; }
  const stamp = new Date(generated);
  el.textContent = isNaN(stamp.getTime()) ? "Data synced just now" : "Last synced " + stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function load() {
  try {
    const r = await fetch("/admin/dashboard.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    DATA = j.customers || [];
    renderStats(j.stats); render(); setSync(j.generated);
  } catch (err) {
    $("#rows").innerHTML = '<tr><td colspan="7" class="loading">Could not load customers. <button class="mini" data-a="reload">Try again</button></td></tr>';
    $("#sync").textContent = "Waiting for a connection";
    toast("Could not load dashboard: " + err.message);
  }
}

$("#q").addEventListener("input", (e) => { Q = e.target.value; render(); });
$("#filter").addEventListener("change", (e) => { FILTER = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { SORT = e.target.value; render(); });

$("#refresh").addEventListener("click", async (e) => {
  const button = e.currentTarget, label = button.querySelector(".btn-label");
  button.disabled = true; if (label) label.textContent = "Checking supplier…";
  try {
    const response = await fetch("/admin/refresh");
    const j = await response.json();
    toast("Updated " + j.updated + " of " + j.checked + (j.failed ? " · " + j.failed + " failed" : ""));
    await load();
  } catch (err) { toast("Refresh failed: " + err.message); }
  button.disabled = false; if (label) label.textContent = "Refresh data";
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
    if (myReq !== peekReq) return;
    const f = $("#form");
    f.elements.supplier_expires.value = j.expires || "";
    f.elements.total_gb.value = j.total_gb == null ? "" : String(j.total_gb);
    f.elements.used_gb.value = j.used_gb == null ? "" : String(j.used_gb);
    const bits = [];
    if (j.total_gb != null) bits.push(j.total_gb + " GB total · " + (j.used_gb || 0) + " GB used" + (j.used_pct != null ? " (" + j.used_pct + "%)" : ""));
    if (j.expires) bits.push("expires " + j.expires);
    if (j.pricing) bits.push(j.pricing.price + " " + j.pricing.currency + " / " + j.pricing.billing_cycle + (j.pricing.cost != null ? " (cost " + j.pricing.cost + ", profit " + (j.pricing.price - j.pricing.cost) + ")" : ""));
    if (j.nodes) bits.push(j.nodes + " node" + (j.nodes === 1 ? "" : "s"));
    peekSay(bits.length ? "✓ " + bits.join(" · ") : "✓ link readable, but it carries no quota/expiry info", "ok");
    if (!f.elements.link.disabled) {
      if (j.expires && !f.elements.paid_until.value) f.elements.paid_until.value = j.expires;
      if (j.total_gb > 0 && !f.elements.plan.value) f.elements.plan.value = j.total_gb + "GB";
      if (j.pricing) {
        if (!f.elements.price.value) f.elements.price.value = j.pricing.price;
        if (!f.elements.currency.value) f.elements.currency.value = j.pricing.currency;
        if (!f.elements.billing_cycle.value) f.elements.billing_cycle.value = j.pricing.billing_cycle;
      }
    }
  } catch (err) {
    if (myReq !== peekReq) return;
    const f = $("#form");
    f.elements.supplier_expires.value = ""; f.elements.total_gb.value = ""; f.elements.used_gb.value = "";
    peekSay("✗ " + err.message, "err");
  } finally {
    if (peekPromise === pr) peekPromise = null;
  }
}

$("#form").elements.link.addEventListener("input", () => {
  clearTimeout(peekTimer);
  const v = $("#form").elements.link.value.trim();
  if (!v || !/^[a-z0-9+.-]+:\\/\\//i.test(v)) { peekReq++; peekSay(""); return; }
  peekTimer = setTimeout(() => peek(v), 700);
});

function closeModal() { $("#modal").hidden = true; }
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
  $("#mhelp").textContent = row ? "Update the details you use to keep this account on track." : "Create a private link and keep its billing details close by.";
  f.elements.token.value = row ? row.token : "";
  f.elements.link.disabled = !!row;
  $("#save").disabled = false;
  $("#save").textContent = row ? "Save changes" : "Create private link";
  $("#cancel").textContent = "Cancel";
  if (row) {
    for (const k of ["customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "label", "account_email", "account_password", "supplier_expires", "total_gb", "used_gb"])
      if (row[k] != null && f.elements[k]) f.elements[k].value = row[k];
  } else {
    f.elements.link.disabled = false;
  }
  $("#modal").hidden = false;
  setTimeout(() => (row ? f.elements.customer : f.elements.link).focus(), 0);
}
$("#add").addEventListener("click", () => openModal(null));
$("#cancel").addEventListener("click", closeModal);
$("#close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const editing = !!f.elements.token.value;
  const res = $("#result"), save = $("#save");
  save.disabled = true;
  if (!editing && peekPromise) {
    res.className = "result"; res.textContent = "Reading the link before saving…";
    try { await peekPromise; } catch (err) {}
    if ($("#modal").hidden) return;
  }
  const d = Object.fromEntries(new FormData(f));
  try {
    const r = await fetch(editing ? "/admin/customer" : "/admin/mint", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(d).toString(),
    });
    const j = await r.json();
    if (!r.ok) { res.className = "result err"; res.textContent = j.error || ("HTTP " + r.status); save.disabled = false; return; }
    res.className = "result ok";
    const link = editing ? oneLinkOf({ label: d.label, token: d.token }) : j.oneLink;
    const msg = editing ? "" : readyMessage(link);
    res.innerHTML = (editing ? "Saved ✓ — the customer's one-link" : "Created ✓ — send this ready message to the customer") +
      ':<div class="onelink">' + esc(link) + '</div>' +
      (msg ? '<div class="msgbox">' + esc(msg) + '</div>' : "") +
      '<div class="mcpy"><button class="btn btn-primary" data-copy="' + esc(link) + '" data-label="📋 Copy one-link">📋 Copy one-link</button>' +
      (msg ? '<button class="btn btn-secondary" data-copy="' + esc(msg) + '" data-label="📋 Copy ready message">📋 Copy ready message</button>' : "") + '</div>';
    await load();
    if (!editing) { save.disabled = true; save.textContent = "Created ✓"; }
    $("#cancel").textContent = "Close";
  } catch (err) { res.className = "result err"; res.textContent = err.message; save.disabled = false; }
});

$("#result").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-copy]");
  if (!b) return;
  const label = b.dataset.label || "📋 Copy one-link";
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast(label.includes("ready message") ? "Ready message copied" : "One-link copied");
    b.textContent = "✓ Copied";
    setTimeout(() => (b.textContent = label), 1600);
  } catch (err) { toast("Copy blocked — select the text manually, then copy"); }
});

$("#rows").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  if (a === "reload") { load(); return; }
  if (a === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.v); toast("Private link copied"); }
    catch (err) { toast("Copy failed — select the link manually"); }
    return;
  }
  if (a === "qr") {
    window.open("/qr?text=" + encodeURIComponent(b.dataset.v), "_blank");
    return;
  }
  if (a === "edit") { openModal(DATA.find((r) => r.token === b.dataset.t)); return; }
  if (a === "renew") {
    // You already renewed this customer with the supplier by hand. This only
    // re-reads THAT ONE customer's subscription and reports what it now says.
    // It cannot buy or renew anything.
    const row = DATA.find((r) => r.token === b.dataset.t);
    const name = (row && (row.customer || row.label)) || "this customer";
    b.disabled = true; b.textContent = "Checking…";
    try {
      const response = await fetch("/admin/link/" + b.dataset.t + "?action=renew");
      const j = await response.json().catch(() => ({}));
      if (response.ok && j.ok) {
        toast(name + " — " + j.message + (j.usage_message ? " · " + j.usage_message : "") +
          (j.marked_paid ? " · marked paid through " + prettyDate(j.paid_until) : ""), 6000);
        await load();
        return;
      }
      toast("Could not check " + name + ": " + (j.error || ("HTTP " + response.status)), 6000);
    } catch (err) {
      toast("Could not check " + name + ": " + err.message, 6000);
    }
    b.disabled = false; b.textContent = "Renew / Check";
    return;
  }
  if (a === "paid" || a === "unpaid") {
    const row = DATA.find((r) => r.token === b.dataset.t);
    const name = (row && (row.customer || row.label)) || "this customer";
    if (a === "unpaid" && !confirm("Mark " + name + " as not paid? This clears their paid-through date.")) return;
    const label = b.textContent;
    b.disabled = true; b.textContent = a === "paid" ? "Saving…" : "Clearing…";
    try {
      const response = await fetch("/admin/link/" + b.dataset.t + "?action=" + a);
      const j = await response.json().catch(() => ({}));
      if (response.ok && j.ok) {
        toast(a === "paid"
          ? name + " marked paid through " + prettyDate(j.paid_until)
          : name + " marked unpaid", 5000);
        await load();
        return;
      }
      toast("Could not update " + name + ": " + (j.error || ("HTTP " + response.status)), 6000);
    } catch (err) {
      toast("Could not update " + name + ": " + err.message, 6000);
    }
    b.disabled = false; b.textContent = label;
    return;
  }
  if (a === "revoke") {
    if (!confirm("Revoke this link? The customer's VPN stops immediately.")) return;
    const response = await fetch("/admin/link/" + b.dataset.t + "?action=revoke");
    if (!response.ok) { toast("Could not revoke this link"); return; }
    toast("Link revoked"); await load(); return;
  }
  if (a === "delete") {
    const row = DATA.find((r) => r.token === b.dataset.t);
    const name = (row && (row.customer || row.label)) || "this customer";
    if (!confirm('Delete "' + name + '" permanently?\\n\\nThe customer record and its link are removed for good. If you only want the link dead, use revoke instead.')) return;
    const response = await fetch("/admin/link/" + b.dataset.t + "?action=delete");
    const j = await response.json().catch(() => ({}));
    toast(response.ok ? "Deleted " + name : "Delete failed: " + (j.error || ("HTTP " + response.status)));
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
  if (!HEALTH) { b.innerHTML = '<div class="loading"><span class="loader"></span> Checking…</div>'; return; }
  const row = (ok, name, detail) => '<div class="hrow"><div class="hdot ' + (ok ? "ok" : "bad") + '"></div><div class="hname">' + esc(name) + '</div><div class="hdetail">' + detail + '</div></div>';
  let h = "";
  const st = HEALTH.checks.store;
  if (st) h += row(st.ok, "Token store", st.ok ? esc(st.backend) + " · " + st.customers + " customers (" + st.active + " active) · " + st.ms + " ms" : esc(st.error || "failed"));
  const sup = HEALTH.checks.supplier;
  if (sup) for (const [host, d] of Object.entries(sup.hosts || {}))
    h += row(d.ok, "Supplier", d.ok ? esc(host) + " · " + d.nodes + " nodes · " + (d.quota_parsed ? "quota OK" : "no quota info") + (d.expires ? " · expires " + esc(d.expires) : "") + " · " + d.ms + " ms" : esc(host) + " — " + esc(d.error || "failed"));
  const cv = HEALTH.checks.converter;
  if (cv) h += row(cv.ok, "Converter", cv.ok ? (cv.skipped ? esc(cv.skipped) : "one-link served " + cv.nodes + " nodes" + (cv.quota_parsed ? " with quota header" : "") + " · " + cv.ms + " ms") : esc(cv.error || "failed"));
  h += '<div class="dim" style="padding:11px 0 0;line-height:1.55">' + esc(HEALTH.note || "") + "<br>Checked " + esc(HEALTH.generated) + (HEALTH.cached ? " (cached " + Math.round((HEALTH.age_ms || 0) / 1000) + "s ago)" : "") + '</div>';
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
    pill.textContent = lvl === "ok" ? "● all systems healthy" : lvl === "degraded" ? "● supplier issue — serving cached" : "● system down";
    renderHealth();
  } catch (err) { pill.className = "pillbtn bad"; pill.textContent = "● health unknown"; }
}

$("#healthpill").addEventListener("click", () => {
  renderHealth(); $("#healthmodal").hidden = false;
  if (!HEALTH || HEALTH.cached) loadHealth(false);
});
$("#healthclose").addEventListener("click", () => ($("#healthmodal").hidden = true));
$("#healthdone").addEventListener("click", () => ($("#healthmodal").hidden = true));
$("#healthre").addEventListener("click", async (e) => {
  e.currentTarget.disabled = true; e.currentTarget.textContent = "↻ Checking…";
  await loadHealth(true);
  e.currentTarget.disabled = false; e.currentTarget.textContent = "↻ Re-check now";
});

loadHealth(false);
setInterval(() => loadHealth(false), 300000);

load();
`;
