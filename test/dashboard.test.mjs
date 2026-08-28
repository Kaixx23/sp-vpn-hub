// ============================================================================
// DASHBOARD SUITE — the stats maths, the live quota refresh, and the routes.
// Run: node test/dashboard.test.mjs
// ============================================================================
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import { summarise } from "../dashboard.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

const enc = encodeURIComponent;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// supplier bodies with different quotas/expiries, keyed by token in the URL
const PANELS = {
  healthy: ["STATUS=↑:1.00GB,↓:9.00GB,TOT:200GB Expires:" + day(45),
    "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=a.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联01")].join("\n"),
  expiring: ["STATUS=↑:50.00GB,↓:140.00GB,TOT:200GB Expires:" + day(4),
    "vless://22222222-2222-4222-8222-222222222222@sg1.example.com:443?encryption=none&security=reality&sni=b.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("新加坡•电信01")].join("\n"),
  expired: ["STATUS=↑:0.00GB,↓:200.00GB,TOT:200GB Expires:" + day(-3),
    "vless://33333333-3333-4333-8333-333333333333@jp1.example.com:443?encryption=none&security=reality&sni=c.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("日本•移联01")].join("\n"),
  big: ["STATUS=↑:12.00GB,↓:8.28GB,TOT:512GB Expires:" + day(30),
    "vless://55555555-5555-4555-8555-555555555555@hk5.example.com:443?encryption=none&security=reality&sni=e.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联02")].join("\n"),
  huge: ["STATUS=↑:150.90GB,↓:300.20GB,TOT:1024GB Expires:" + day(60),
    "vless://66666666-6666-4666-8666-666666666666@sg6.example.com:443?encryption=none&security=reality&sni=f.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("新加坡•移联02")].join("\n"),
};
globalThis.fetch = async (u) => {
  const s = String(u);
  for (const [k, v] of Object.entries(PANELS)) if (s.includes("who=" + k)) return new Response(v);
  return new Response("nope", { status: 500 });
};

store.setBackend(new store.MemoryBackend());
await store.ensureInit();

const HOST = "https://sp.example.com";
const get = (p) => worker.fetch(new Request(HOST + p), {}, {});
const post = (p, form) => worker.fetch(new Request(HOST + p, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(form).toString(),
}), {}, {});

console.log("\n[1] summarise() — the renewal maths");
{
  const rows = [
    { revoked: false, supplier_expires: day(45), paid_until: day(30), price: 15 },
    { revoked: false, supplier_expires: day(4), paid_until: day(10), price: 20 },
    { revoked: false, supplier_expires: day(-3), paid_until: day(-1), price: 15 },
    { revoked: false, supplier_expires: day(20), paid_until: day(20), price: 10 },
    { revoked: false, supplier_expires: null, paid_until: null, price: 0 },
    { revoked: true, supplier_expires: day(45), paid_until: day(45), price: 99 },
    { revoked: false, supplier_expires: day(60), paid_until: day(60), price: 25, legacy: true },
  ];
  const s = summarise(rows);
  ok(s.total === 7, `total counts every row (got ${s.total})`);
  ok(s.active === 6, `active excludes revoked (got ${s.active})`);
  ok(s.revoked === 1, `revoked counted separately (got ${s.revoked})`);
  ok(s.overdue === 1, `overdue = expiry in the past (got ${s.overdue})`);
  ok(s.expiring7 === 1, `expiring ≤7d catches the 4-day link (got ${s.expiring7})`);
  ok(s.expiring30 === 1, `expiring 8–30d catches the 20-day link (got ${s.expiring30})`);
  ok(s.unknownExpiry === 1, `unknown expiry surfaced, not counted as healthy (got ${s.unknownExpiry})`);
  ok(s.unpaid === 1, `unpaid = paid_until in the past (got ${s.unpaid})`);
  ok(s.mrr === 85, `MRR sums ACTIVE prices only, ignoring the revoked 99 (got ${s.mrr})`);
  ok(s.legacy === 1, `legacy links counted (got ${s.legacy})`);

  // profit: catalogue cost (plans.js) vs the price actually paid
  const ps = summarise([
    { revoked: false, total_gb: 512, price: 12, currency: "RMB", billing_cycle: "monthly" },
    { revoked: false, total_gb: 1024, price: 16, currency: "RMB", billing_cycle: "monthly" },
    { revoked: false, total_gb: 512, price: 15, currency: "RMB", billing_cycle: "monthly" }, // custom price
    { revoked: true, total_gb: 512, price: 12, currency: "RMB", billing_cycle: "monthly" },  // revoked -> no profit
    { revoked: false, total_gb: 200, price: 10, currency: "RMB", billing_cycle: "monthly" }, // unknown plan
    { revoked: false, total_gb: 512, price: 12, currency: "USD", billing_cycle: "monthly" }, // currency mismatch
    { revoked: false, total_gb: 512, price: 12, currency: "RMB", billing_cycle: "quarterly" }, // cycle mismatch
    { revoked: false, total_gb: 512, price: null, currency: "RMB", billing_cycle: "monthly" }, // no price
  ]);
  ok(ps.profitMonthly === 29, `profit = 8 + 10 + 11 (custom price), rest excluded (got ${ps.profitMonthly})`);
  ok(summarise([{ revoked: false, total_gb: 200, price: 10 }]).profitMonthly === null, "no known plans -> profit null");
  ok(summarise([]).profitMonthly === null, "empty table -> profit null");
}

console.log("\n[2] minting with customer + billing fields");
const tokens = {};
for (const [who, name, price, paid] of [
  ["healthy", "Ali", 15, day(30)],
  ["expiring", "Bao", 20, day(10)],
  ["expired", "Chen", 15, day(-1)],
]) {
  const r = await post("/admin/mint", {
    link: `https://panel.example/sub?who=${who}`,
    customer: name, plan: "200GB / 3mo", price, currency: "USD",
    billing_cycle: "quarterly", paid_until: paid, label: name, notes: "tg @" + name,
  });
  const j = JSON.parse(await r.text());
  tokens[who] = j.token;
  ok(r.status === 200 && j.token, `${name}: minted with customer data`);
}

console.log("\n[3] /admin/refresh — pulls live quota + expiry from the supplier");
{
  const before = JSON.parse(await (await get("/admin/dashboard.json")).text());
  ok(before.customers.every((c) => !c.supplier_expires), "no expiry recorded before refresh");

  const r = await get("/admin/refresh");
  const j = JSON.parse(await r.text());
  ok(r.status === 200, `refresh returned 200 (got ${r.status})`);
  ok(j.checked === 3 && j.updated === 3, `checked 3, updated 3 (got ${JSON.stringify(j)})`);

  const after = JSON.parse(await (await get("/admin/dashboard.json")).text());
  const byName = Object.fromEntries(after.customers.map((c) => [c.customer, c]));
  ok(byName.Ali.supplier_expires === day(45), `Ali expiry read from supplier (${byName.Ali.supplier_expires})`);
  ok(byName.Ali.total_gb === 200 && byName.Ali.used_gb === 10, `Ali quota 10/200GB used (got ${byName.Ali.used_gb}/${byName.Ali.total_gb})`);
  ok(byName.Bao.used_gb === 190, `Bao heavy user 190/200GB (got ${byName.Bao.used_gb})`);
  ok(byName.Chen.supplier_expires === day(-3), `Chen already expired (${byName.Chen.supplier_expires})`);
  ok(byName.Ali.checked_at, "checked_at timestamped");

  console.log("\n[4] dashboard.json stats reflect the live data");
  const s = after.stats;
  ok(s.active === 3, `3 active (got ${s.active})`);
  ok(s.overdue === 1, `1 overdue — Chen (got ${s.overdue})`);
  ok(s.expiring7 === 1, `1 expiring ≤7d — Bao at 4 days (got ${s.expiring7})`);
  ok(s.unpaid === 1, `1 unpaid — Chen (got ${s.unpaid})`);
  ok(s.mrr === 50, `MRR 15+20+15 = 50 (got ${s.mrr})`);
  ok(s.avgQuotaUsedPct !== null, `average quota used computed (${s.avgQuotaUsedPct}%)`);
}

console.log("\n[5] /admin — the page itself");
{
  const r = await get("/admin");
  const html = await r.text();
  ok(r.status === 200, `GET /admin 200 (got ${r.status})`);
  ok(html.includes("<!doctype html>"), "serves a full HTML document");
  ok(html.includes("reseller dashboard"), "renders the dashboard title");
  ok(html.includes("dashboard.json"), "client fetches dashboard.json");
  ok(!html.includes("<script src="), "no external script tags (no CDN — loads from China)");
  ok(!html.includes("http://") && !html.includes("https://cdn"), "no CDN references at all");
  ok(html.includes("Refresh quota"), "has the refresh control");
  const alias = await get("/admin/dashboard");
  ok(alias.status === 200, "GET /admin/dashboard alias works too");
}

console.log("\n[6] editing a customer");
{
  const r = await post("/admin/customer", { token: tokens.healthy, customer: "Ali Hassan", plan: "500GB / 6mo", price: "30", paid_until: day(180) });
  ok(r.status === 200, `edit returned 200 (got ${r.status})`);
  const j = JSON.parse(await r.text());
  ok(j.customer === "Ali Hassan" && j.price === 30, `fields persisted (${j.customer}, ${j.price})`);
  const bad = await post("/admin/customer", { token: "0".repeat(48), customer: "X" });
  ok(bad.status === 404, `unknown token -> 404 (got ${bad.status})`);
}

console.log("\n[7] the dashboard never leaks a supplier URL");
{
  const html = await (await get("/admin")).text();
  const dj = await (await get("/admin/dashboard.json")).text();
  const lj = await (await get("/admin/links")).text();
  ok(!html.includes("panel.example"), "page HTML has no supplier host");
  ok(!dj.includes("supplier_url"), "dashboard.json has no supplier_url key");
  ok(!lj.includes("supplier_url"), "admin/links has no supplier_url key");
  ok(!dj.includes("who=healthy"), "supplier query string never leaves the server");
}

console.log("\n[8] /admin/inspect — auto-detect details from a pasted link");
{
  const r = await post("/admin/inspect", { link: "https://panel.example/sub?who=healthy" });
  ok(r.status === 200, `inspect returned 200 (got ${r.status})`);
  const j = JSON.parse(await r.text());
  ok(j.ok === true, "ok: true for a readable subscription");
  ok(j.expires === day(45), `expiry detected (${j.expires})`);
  ok(j.total_gb === 200, `total quota detected (${j.total_gb} GB)`);
  ok(j.used_gb === 10, `used quota detected (${j.used_gb} GB)`);
  ok(j.left_gb === 190, `remaining quota computed (${j.left_gb} GB)`);
  ok(j.nodes === 1, `node count detected (${j.nodes})`);
  const body = JSON.stringify(j);
  ok(!body.includes("panel.example"), "inspect response never echoes the supplier URL");
  const big = await post("/admin/inspect", { link: "https://panel.example/sub?who=big" });
  const bj = JSON.parse(await big.text());
  ok(bj.ok === true && bj.total_gb === 512, `512GB plan detected (${bj.total_gb} GB)`);
  ok(bj.pricing && bj.pricing.price === 12 && bj.pricing.currency === "RMB" && bj.pricing.billing_cycle === "monthly",
    `512GB auto-priced 12 RMB monthly (got ${JSON.stringify(bj.pricing)})`);
  const huge = await post("/admin/inspect", { link: "https://panel.example/sub?who=huge" });
  const hj = JSON.parse(await huge.text());
  ok(hj.ok === true && hj.total_gb === 1024, `1024GB plan detected (${hj.total_gb} GB)`);
  ok(hj.pricing && hj.pricing.price === 16 && hj.pricing.currency === "RMB",
    `1024GB auto-priced 16 RMB (got ${JSON.stringify(hj.pricing)})`);
  ok(j.pricing === null || j.pricing === undefined, "unknown quota (200GB) gets no auto-price");
  const direct = await post("/admin/inspect", { link: PANELS.healthy.split("\n")[1] });
  const dj = JSON.parse(await direct.text());
  ok(direct.status === 200 && dj.ok === true && dj.direct === true && dj.nodes === 1,
    "direct node link inspected — nodes counted, no quota claimed");
  const bad = await post("/admin/inspect", { link: "not a link at all" });
  ok(bad.status === 400, `garbage link -> 400 (got ${bad.status})`);
  const dead = await post("/admin/inspect", { link: "https://panel.example/sub?who=nobody" });
  ok(dead.status === 502, `unreadable supplier -> 502 (got ${dead.status})`);
  ok(!(await dead.text()).includes("who=nobody"), "inspect error message never echoes the supplier URL");
}

console.log("\n[9] minting with auto-detected details (no Refresh needed)");
{
  const r = await post("/admin/mint", {
    link: "https://panel.example/sub?who=expiring", customer: "Dmitri", label: "Dmitri",
    supplier_expires: day(4), total_gb: "200", used_gb: "190",
  });
  ok(r.status === 200, `mint with detected details returned 200 (got ${r.status})`);
  const j = JSON.parse(await r.text());
  const rows = JSON.parse(await (await get("/admin/dashboard.json")).text()).customers;
  const row = rows.find((x) => x.token === j.token);
  ok(row && row.supplier_expires === day(4), `expiry stored at creation (${row && row.supplier_expires})`);
  ok(row && row.total_gb === 200 && row.used_gb === 190, `quota stored at creation (${row && row.total_gb}/${row && row.used_gb})`);
  ok(row && !!row.checked_at, "checked_at stamped at creation");
  const junk = await post("/admin/mint", {
    link: "https://panel.example/sub?who=healthy", customer: "Junk",
    supplier_expires: "<script>alert(1)</script>", total_gb: "-5", used_gb: "NaN",
  });
  const jt = JSON.parse(await junk.text()).token;
  const jrow = JSON.parse(await (await get("/admin/dashboard.json")).text()).customers.find((x) => x.token === jt);
  ok(jrow && jrow.supplier_expires === null && jrow.total_gb === null && jrow.used_gb === null,
    "junk detail fields rejected and not stored");
}

console.log("\n[10] panel account fields + profit on the API");
{
  const r = await post("/admin/mint", {
    link: "https://panel.example/sub?who=big", customer: "Zhang", label: "Zhang",
    price: "12", currency: "RMB", billing_cycle: "monthly",
    account_email: "zhang.renew@gmail.com", account_password: "shevinx123",
    supplier_expires: day(30), total_gb: "512", used_gb: "20",
  });
  const j = JSON.parse(await r.text());
  ok(r.status === 200, `mint with account fields returned 200 (got ${r.status})`);
  const rows = JSON.parse(await (await get("/admin/dashboard.json")).text());
  const row = rows.customers.find((x) => x.token === j.token);
  ok(row && row.account_email === "zhang.renew@gmail.com", `account email stored (${row && row.account_email})`);
  ok(row && row.account_password === "shevinx123", "account password stored");
  ok(row && row.profit === 8, `per-row profit computed (512GB @12 - cost 4 = ${row && row.profit})`);
  ok(rows.stats.profitMonthly != null && rows.stats.profitMonthly >= 8, `stats carry profitMonthly (${rows.stats.profitMonthly})`);
  const upd = await post("/admin/customer", { token: j.token, account_email: "zhang.new@gmail.com" });
  const uj = JSON.parse(await upd.text());
  ok(uj.account_email === "zhang.new@gmail.com", `account email editable (${uj.account_email})`);
  const dr = await post("/admin/customer", { token: "0".repeat(48), account_email: "x@x.com" });
  ok(dr.status === 404, `unknown token still 404 (got ${dr.status})`);
}

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
