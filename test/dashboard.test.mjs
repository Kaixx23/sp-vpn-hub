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

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
