// ============================================================================
// DASHBOARD SUITE — the stats maths, the live quota refresh, and the routes.
// Run: node test/dashboard.test.mjs
// ============================================================================
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import { summarise, summariseAt, cycleMonths } from "../dashboard.js";
import vm from "node:vm";

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
  if (s.includes("/all/")) return new Response(Buffer.from(
    `STATUS=↑:1.00GB,↓:9.00GB,TOT:200GB Expires:${day(45)}\nvless://99999999-9999-4999-8999-999999999999@hk9.example.com:443?encryption=none&security=reality&sni=z.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp#${enc("香港•移联01")}`
  ).toString("base64"));
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
    // Anonymous/system-generated rows should remain visible elsewhere, but they
    // must never inflate customer counts, MRR, expiry alerts, or profit.
    { label: "quota-page", revoked: false, supplier_expires: day(-99), paid_until: day(-99), price: 999, total_gb: 512, currency: "RMB", billing_cycle: "monthly" },
    { label: "seller-tool", revoked: false, supplier_expires: day(1), price: 888, total_gb: 1024, currency: "RMB", billing_cycle: "monthly" },
  ];
  const s = summarise(rows);
  ok(s.total === 7, `total counts real customer rows only (got ${s.total})`);
  ok(s.allLinks === 9, `allLinks still records every stored link (got ${s.allLinks})`);
  ok(s.generatedLinks === 2 && s.generatedActive === 2, `anonymous/generated links are counted separately (${s.generatedLinks}/${s.generatedActive})`);
  ok(s.active === 6, `active excludes revoked and generated rows (got ${s.active})`);
  ok(s.revoked === 1, `revoked counted separately (got ${s.revoked})`);
  ok(s.overdue === 1, `overdue = expiry in the past (got ${s.overdue})`);
  ok(s.expiring7 === 1, `expiring ≤7d catches the 4-day link (got ${s.expiring7})`);
  ok(s.expiring30 === 1, `expiring 8–30d catches the 20-day link (got ${s.expiring30})`);
  ok(s.unknownExpiry === 1, `unknown expiry surfaced, not counted as healthy (got ${s.unknownExpiry})`);
  ok(s.unpaid === 2, `unpaid includes missing payments and expired paid-through dates (got ${s.unpaid})`);
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
    billing_cycle: "quarterly", label: name, notes: "tg @" + name,
  });
  const j = JSON.parse(await r.text());
  tokens[who] = j.token;
  await store.updateRow(j.token, { paid_until: paid }); // historical payment fixture
  ok(r.status === 200 && j.token, `${name}: minted with customer data`);
}
const anonymousQuotaToken = await store.mint("https://panel.example/sub?who=healthy", "quota-page");
ok(anonymousQuotaToken, "anonymous quota-page token created as a generated link");

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
  const anon = after.customers.find((c) => c.token === anonymousQuotaToken);
  ok(anon && anon.system_generated === true && anon.system_kind === "quota-page", "quota-page row is flagged as anonymous/generated");
  ok(anon && anon.supplier_expires === null, "global refresh skipped anonymous quota-page rows");
  const s = after.stats;
  ok(s.active === 3, `3 active paying/customer rows (got ${s.active})`);
  ok(s.generatedLinks === 1, `1 generated quota-page link counted separately (got ${s.generatedLinks})`);
  ok(s.overdue === 1, `1 overdue — Chen (got ${s.overdue})`);
  ok(s.expiring7 === 1, `1 expiring ≤7d — Bao at 4 days (got ${s.expiring7})`);
  ok(s.unpaid === 1, `1 unpaid — Chen (got ${s.unpaid})`);
  // These three fixture rows are "200GB / 3mo" at 15/20/15, i.e. a QUARTERLY
  // price each. The old expectation here was `mrr === 50` — the raw sum of the
  // three face prices, which is what you collect THIS quarter, not a monthly
  // run-rate. The test was pinning the bug, so it is corrected rather than
  // preserved: 50 over 3 months is 16.67/month.
  ok(s.mrr === 16.67, `revenue = (15+20+15) / 3mo = 16.67 per month (got ${s.mrr})`);
  ok(s.currency === "USD", `single currency named on the number (${s.currency})`);
  ok(s.mixedCurrencies === false, "one currency in the book -> no blending warning");
  ok(s.byCurrency.USD.customers === 3, `per-currency customer count (${s.byCurrency.USD.customers})`);
  ok(s.revenue.arr === 200, `annual run-rate = 16.67 * 12 ≈ the 200 collected per 3mo cycle (got ${s.revenue.arr})`);
  ok(s.revenue.assumedMonthly === 0, "every row stated its cycle -> nothing assumed");
  const monthsRow = after.customers.find((c) => c.customer === "Ali");
  ok(monthsRow && monthsRow.months === 3, `rows carry their period for the table (got ${monthsRow && monthsRow.months})`);
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
  const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";
  ok(script.includes('document.querySelector(s)'), "dashboard client JS is embedded");
  ok(script.includes('FILTER = "all"') && script.includes('$("#toast")') && !script.includes('FILTER = &quot;all&quot;'), "dashboard client JS is not HTML-escaped");
  try { new Function(script); ok(true, "dashboard client JS parses as valid JavaScript"); }
  catch (e) { ok(false, "dashboard client JS parses as valid JavaScript (" + e.message + ")"); }
  ok(!html.includes("<script src="), "no external script tags (no CDN — loads from China)");
  ok(!html.includes("http://") && !html.includes("https://cdn"), "no CDN references at all");
  ok(html.includes("Refresh quota"), "has the refresh control");
  ok(html.includes("Anonymous quota checks") && html.includes("All links"), "generated quota links have their own dashboard filters");
  ok(html.includes("hidden from customer totals") && html.includes("Anonymous checks"), "stats explain generated links are separate from customers/profit");
  ok(html.includes("[hidden]{display:none !important}"), "modal/toast hidden state is enforced over component CSS");
  ok(html.includes('id="close"') && html.includes('function closeModal()'), "customer popup has reliable close controls");
  ok(html.includes('e.key === "Escape"') && html.includes('e.target === $("#modal")'), "customer popup closes on Escape and backdrop click");
  ok(html.includes("QR Maker") && html.includes('actionButton("qr"'), "dashboard exposes QR maker and per-row QR buttons");
  ok(html.includes('actionButton("check"'), "has a per-customer supplier check control");
  ok(html.includes('actionButton("pay"'), "has a separate Pay control");
  ok(html.includes("Here is your official SP Connect link") && html.includes("Thank you for choosing SP Connect! ❤️"),
    "ready-to-send SP Connect message template present in the page");
  ok(html.includes("j.oneLink") && html.includes("📋 Copy ready message") && html.includes("📋 Copy one-link"),
    "ready message inserts the minted one-link (j.oneLink, not a hardcoded example); copy ready message + copy one-link buttons present");
  const alias = await get("/admin/dashboard");
  ok(alias.status === 200, "GET /admin/dashboard alias works too");

  // Regression: the client is a JS template literal inlined raw into <script>.
  // Any newline the ready-to-send message needs must be a DOUBLED backslash-n;
  // a single-backslash "\n" is eaten by that outer template literal into a real
  // line break, which splits the quoted string and makes the WHOLE inlined
  // client script a fatal SyntaxError — the dashboard then dies at parse time
  // (stuck on "Loading…", every button dead). Assert the served script is valid
  // JavaScript and readyMessage() yields real line breaks.
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  ok(!!scriptMatch, "page carries one inlined <script> block");
  let parsed = false, readySrc = "";
  try {
    new vm.Script(scriptMatch[1]); // throws on a SyntaxError, exactly like the browser
    parsed = true;
    const rm = scriptMatch[1].match(/const readyMessage = \(link\) =>([\s\S]*?);/);
    readySrc = rm ? rm[1] : "";
  } catch (e) {
    console.log("     inlined client script failed to parse:", e.message);
  }
  ok(parsed, "inlined client script is valid JavaScript (no fatal SyntaxError)");
  // After the outer template literal is evaluated, the message strings must
  // still contain an explicit "\n" escape so the browser-built message has real
  // line breaks — not one mashed line.
  ok((readySrc.match(/\\n/g) || []).length >= 6,
    `readyMessage keeps escaped newline sequences for the multi-line message (got ${(readySrc.match(/\\n/g) || []).length})`);
  // Evaluate just readyMessage and confirm it returns a real multi-line string
  // with the link embedded.
  let builtMessage = "";
  try {
    const ctx = {};
    vm.createContext(ctx);
    builtMessage = vm.runInContext(scriptMatch[1].match(/const readyMessage = \(link\) =>[\s\S]*?;/)[0] + "\nreadyMessage('https://x/all/LINK');", ctx);
  } catch (e) { /* reported above */ }
  ok(builtMessage.split("\n").length >= 7,
    `readyMessage() builds a multi-line message (${builtMessage.split("\n").length} lines), not one mashed line`);
  ok(builtMessage.includes("https://x/all/LINK"), "readyMessage() embeds the one-link it is given");
  ok(!builtMessage.includes("\\n"), "no literal backslash-n leaks into the built customer message");
}

console.log("\n[6] editing a customer");
{
  const r = await post("/admin/customer", { token: tokens.healthy, customer: "Ali Hassan", plan: "500GB / 6mo", price: "30" });
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
  ok(bj.pricing && bj.pricing.price === 10 && bj.pricing.currency === "RMB" && bj.pricing.billing_cycle === "monthly",
    `512GB auto-priced 10 RMB monthly (got ${JSON.stringify(bj.pricing)})`);
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

console.log("\n[11] /admin/health — live pipeline health");
{
  const r = await get("/admin/health?force=1");
  ok(r.status === 200, `health returned 200 (got ${r.status})`);
  const j = JSON.parse(await r.text());
  ok(j.checks.store && j.checks.store.ok === true, `store check ok (${j.checks.store && j.checks.store.backend}, ${j.checks.store && j.checks.store.ms} ms)`);
  ok(j.checks.store && j.checks.store.customers >= 5, `store counted customers (${j.checks.store && j.checks.store.customers})`);
  ok(j.checks.supplier && j.checks.supplier.ok === true, "supplier check ok");
  const hosts = Object.entries(j.checks.supplier.hosts || {});
  ok(hosts.length === 1 && hosts[0][0] === "panel.example", `one representative host per supplier (${hosts.map((h) => h[0]).join(", ")})`);
  ok(hosts[0][1].ok === true && hosts[0][1].nodes === 1 && hosts[0][1].quota_parsed === true, `supplier host detail ok (${JSON.stringify(hosts[0][1])})`);
  ok(j.checks.converter && j.checks.converter.ok === true, `converter end-to-end ok (${j.checks.converter && j.checks.converter.ms} ms)`);
  ok(j.checks.converter && j.checks.converter.nodes === 1 && j.checks.converter.quota_parsed === true, "converter served nodes with quota parsed");
  ok(j.ok === true && j.level === "ok", `overall verdict ok (got ${j.level})`);
  // A deploy that silently failed serves the OLD profile while answering 200
  // everywhere, so the dashboard's own health check has to see it.
  ok(!!j.checks.profile, "health reports the deployed build's profile policy");
  ok(j.checks.profile.ok === true, `deployed profile is current (${j.checks.profile.label})`);
  ok(Array.isArray(j.checks.profile.problems) && j.checks.profile.problems.length === 0,
    `no profile problems (got ${JSON.stringify(j.checks.profile.problems)})`);
  const r2 = await get("/admin/health");
  const j2 = JSON.parse(await r2.text());
  ok(j2.cached === true, `second call served from cache (age ${Math.round((j2.age_ms || 0) / 1000)}s)`);
  const fresh = await get("/admin/health?force=1");
  ok(JSON.parse(await fresh.text()).cached === undefined, "?force=1 bypasses the cache");
}

console.log("\n[12] revenue maths — monthly-normalised, per currency");
{
  // A 12-month plan paid once must NOT count as 12 months of revenue…
  const annual = summariseAt([
    { revoked: false, price: 120, currency: "USD", billing_cycle: "annual", supplier_expires: day(300) },
  ], new Date(day(0) + "T00:00:00Z"));
  ok(annual.mrr === 10, `120/12mo -> 10 per month (got ${annual.mrr})`);
  ok(annual.revenue.arr === 120, `…and 120 per year (got ${annual.revenue.arr})`);

  // …and a 120/year customer must never be added to an 8/month one as if equal.
  const mixedBook = summariseAt([
    { revoked: false, price: 120, currency: "USD", billing_cycle: "annual" },
    { revoked: false, price: 8, currency: "USD", billing_cycle: "monthly" },
  ], new Date(day(0) + "T00:00:00Z"));
  ok(mixedBook.mrr === 18, `120/12 + 8 = 18/mo in one currency (got ${mixedBook.mrr})`);

  // Two currencies are not one number.
  const two = summariseAt([
    { revoked: false, price: 10, currency: "RMB", billing_cycle: "monthly" },
    { revoked: false, price: 8, currency: "USD", billing_cycle: "monthly" },
  ], new Date(day(0) + "T00:00:00Z"));
  ok(two.mixedCurrencies === true, "RMB + USD is reported as mixed, not summed");
  ok(two.mrr === 0, "no blended cross-currency headline figure exists (got " + two.mrr + ")");
  ok(two.byCurrency.RMB.mrr === 10 && two.byCurrency.USD.mrr === 8,
    `each currency keeps its own figure (${JSON.stringify(two.revenue.currencies)})`);
  ok(two.revenue.currencies[0] === "RMB", `biggest earner listed first (${two.revenue.currencies[0]})`);

  // Cycle read off the plan label when billing_cycle was never filled in.
  ok(cycleMonths({ plan: "200GB / 3mo" }) === 3, "plan label '3mo' parsed");
  ok(cycleMonths({ plan: "512GB 一年" }) === 12, "Chinese '年' parsed");
  ok(cycleMonths({ plan: "512GB/3个月" }) === 3, "Chinese '个月' parsed");
  ok(cycleMonths({ plan: "包月" }) === 1, "bare '包月' is monthly");
  ok(cycleMonths({ plan: "512GB 三个月" }) === 3, "CJK numeral before 个月 (一年/两周 style labels)");
  ok(cycleMonths({ plan: "一星期" }) === 0.23, "CJK '星期' read as a week (7/30.44)");
  ok(cycleMonths({ plan: "30天" }) === 0.99, "CJK '天' read as days");
  ok(cycleMonths({ billing_cycle: "QUARTERLY" }) === 3, "billing_cycle wins and case does not matter");
  ok(cycleMonths({ billing_cycle: "3  months " }) === 3, "sloppy spacing tolerated");
  ok(cycleMonths({ plan: "512GB" }) === null, "no period stated -> null, never a silent guess");
  ok(cycleMonths({}) === null, "empty row -> null");

  // Unpriced / free rows must not become 0-currency customers.
  const free = summariseAt([{ revoked: false, price: 0 }, { revoked: false, price: null }], new Date(day(0) + "T00:00:00Z"));
  ok(free.revenue.currencies.length === 0, "zero/null prices contribute nothing");
  ok(free.active === 2, "…but they are still active customers (got " + free.active + ")");

  // Unknown cycle: assume monthly (this catalogue sells monthly) BUT say so.
  const assumed = summariseAt([{ revoked: false, price: 25 }], new Date(day(0) + "T00:00:00Z"));
  ok(assumed.mrr === 25, "an unstated cycle is treated as monthly (got " + assumed.mrr + ")");
  ok(assumed.revenue.assumedMonthly === 1 && assumed.revenue.assumedFace === 25,
    `…and the guess is counted and shown (${assumed.revenue.assumedMonthly} row / ${assumed.revenue.assumedFace})`);

  // Revenue at risk: only rows expiring within 30 days (or already overdue).
  const risk = summariseAt([
    { revoked: false, price: 9, currency: "RMB", billing_cycle: "monthly", supplier_expires: day(5) },
    { revoked: false, price: 12, currency: "RMB", billing_cycle: "monthly", supplier_expires: day(-2) },
    { revoked: false, price: 30, currency: "RMB", billing_cycle: "monthly", supplier_expires: day(90) },
    { revoked: true, price: 99, currency: "RMB", billing_cycle: "monthly", supplier_expires: day(1) },
  ], new Date(day(0) + "T00:00:00Z"));
  ok(risk.byCurrency.RMB.atRisk30 === 21, `9 due soon + 12 overdue = 21 at risk, 30d-out and revoked excluded (got ${risk.byCurrency.RMB.atRisk30})`);
  ok(risk.mrr === 51, `risk is a slice of revenue, not the whole book (got ${risk.mrr})`);
}

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
