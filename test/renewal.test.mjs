// ============================================================================
// RENEWAL SUITE — per-customer "Renew / Check" + usage-change tracking.
// Run: node test/renewal.test.mjs
//
// Covers, in order:
//   [1]  helpers: usageKind / usageMessage / renewalMessage / scrubSupplier
//   [2]  first successful check has NO usage delta
//   [3]  a changed expiry reports "Renewed: expiry updated to <date>"
//   [4]  an unchanged expiry reports "Checked: expiry remains <date>"
//   [5]  usage increase is measured against the previous successful check
//   [6]  a supplier usage reset (new used < old used) is reported as a reset
//   [7]  a FAILED check overwrites nothing — values and delta survive
//   [8]  the delta stays visible on the dashboard until the next success
//   [9]  global /admin/refresh still works AND persists deltas for everyone
//   [10] revoked / unknown / direct-node customers are handled safely
//   [11] supplier URLs stay redacted from every admin API
//   [12] the renew action never writes to the supplier (read-only)
// ============================================================================
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import {
  usageKind, usageMessage, renewalMessage, scrubSupplier, checkCustomerRow,
} from "../renewal.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

const enc = encodeURIComponent;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const NODE = "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443" +
  "?encryption=none&security=reality&sni=a.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联01");

// The fake supplier panel. PANEL[who] is mutated between checks to simulate a
// renewal, more usage, a quota reset, or an outage.
const PANEL = {};
const setPanel = (who, up, down, tot, exp) => {
  PANEL[who] = { up, down, tot, exp };
};
const body = (p) => `STATUS=↑:${p.up.toFixed(2)}GB,↓:${p.down.toFixed(2)}GB,TOT:${p.tot}GB Expires:${p.exp}\n${NODE}`;

// Every supplier fetch is counted so we can prove the per-customer action
// touches exactly ONE customer's subscription and nothing else.
let fetchLog = [];
globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.includes("/all/")) return new Response(Buffer.from(body({ up: 1, down: 9, tot: 200, exp: day(45) })).toString("base64"));
  const who = new URL(s).searchParams.get("who");
  fetchLog.push(who);
  const p = PANEL[who];
  if (!p) return new Response("nope", { status: 500 });
  if (p.down === "DEAD") return new Response("upstream exploded", { status: 503 });
  // A CDN/bot wall in front of the panel: an HTML interstitial, not an error page.
  if (p.down === "CHALLENGE") return new Response("<html><title>Just a moment...</title></html>", { status: 403 });
  if (p.down === "NOSTATUS") return new Response(NODE); // nodes but no STATUS line
  return new Response(body(p));
};

store.setBackend(new store.MemoryBackend());
await store.ensureInit();

const HOST = "https://sp.example.com";
const get = (p) => worker.fetch(new Request(HOST + p), {}, {});
const post = (p, form) => worker.fetch(new Request(HOST + p, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(form).toString(),
}), {}, {});

const jget = async (p) => JSON.parse(await (await get(p)).text());
const renew = async (token) => {
  const r = await get("/admin/link/" + token + "?action=renew");
  return { status: r.status, j: JSON.parse(await r.text()) };
};
const rowOf = async (token) =>
  (await jget("/admin/dashboard.json")).customers.find((c) => c.token === token);

/** Mint a customer whose supplier panel is PANEL[who]. */
async function mint(who, fields = {}) {
  const r = await post("/admin/mint", { link: `https://panel.example/sub?who=${who}`, label: who, customer: fields.customer || who, ...fields });
  return JSON.parse(await r.text()).token;
}

// ---------------------------------------------------------------------------
console.log("\n[1] the message helpers");
{
  ok(usageKind(null) === "first", "null delta -> 'first' (no previous check)");
  ok(usageKind(0) === "same", "zero delta -> 'same'");
  ok(usageKind(0.001) === "same", "sub-epsilon noise -> 'same', not a fake increase");
  ok(usageKind(5) === "increase", "positive delta -> 'increase'");
  ok(usageKind(-190) === "reset", "negative delta -> 'reset'");

  ok(usageMessage(null) === null, "first check yields NO usage sentence");
  ok(usageMessage(5) === "+5.0 GB used since last check", `increase wording (${usageMessage(5)})`);
  ok(usageMessage(0) === "No new usage since last check", `unchanged wording (${usageMessage(0)})`);
  ok(usageMessage(-190) === "Usage reset by 190.0 GB", `reset wording (${usageMessage(-190)})`);

  ok(renewalMessage(true, "2026-10-28") === "Renewed: expiry updated to 2026-10-28", `changed wording (${renewalMessage(true, "2026-10-28")})`);
  ok(renewalMessage(false, "2026-10-28") === "Checked: expiry remains 2026-10-28", `unchanged wording (${renewalMessage(false, "2026-10-28")})`);

  const scrubbed = scrubSupplier("fetch failed for https://panel.example/sub?who=ali&token=SECRET", "https://panel.example/sub?who=ali&token=SECRET");
  ok(!scrubbed.includes("SECRET") && !scrubbed.includes("panel.example"), `errors are scrubbed of the supplier URL (${scrubbed})`);
  ok(!scrubSupplier("see https://other.host/x?token=abc", "").includes("other.host"), "any stray URL is scrubbed, not just the known one");
}

// ---------------------------------------------------------------------------
console.log("\n[2] first successful check — no comparison exists yet");
setPanel("ali", 10, 10, 512, day(10));
const ali = await mint("ali", { customer: "Ali", price: "10", currency: "RMB", billing_cycle: "monthly", account_email: "ali@example.com", account_password: "shevinx123" });
{
  const before = await rowOf(ali);
  ok(before.used_gb === null && before.usage_delta_gb === null, "a fresh customer has no usage and no delta");

  const { status, j } = await renew(ali);
  ok(status === 200 && j.ok === true, `renew returned 200/ok (got ${status})`);
  ok(j.used_gb === 20, `used_gb read from the supplier (${j.used_gb})`);
  ok(j.usage_delta_gb === null, `FIRST check has a null delta (got ${j.usage_delta_gb})`);
  ok(j.usage_change === "first", `usage_change is 'first' (got ${j.usage_change})`);
  ok(j.usage_message === null, "no usage sentence is invented on the first check");
  ok(j.previous_used_gb === null, "previous_used_gb is null on the first check");

  const row = await rowOf(ali);
  ok(row.used_gb === 20 && row.total_gb === 512, `values persisted (${row.used_gb}/${row.total_gb})`);
  ok(row.supplier_expires === day(10), `expiry persisted (${row.supplier_expires})`);
  ok(!!row.checked_at, "checked_at stamped");
  ok(row.usage_delta_gb === null && row.usage_message === null, "no delta persisted on the first check");
}

// ---------------------------------------------------------------------------
console.log("\n[3] renewal detected — the expiry moved");
{
  // You renewed Ali with the supplier by hand: new expiry, counter reset.
  setPanel("ali", 0, 0.5, 512, day(40));
  const { status, j } = await renew(ali);
  ok(status === 200 && j.ok === true, `renew returned 200/ok (got ${status})`);
  ok(j.renewed === true && j.expiry_changed === true, "the action reports the expiry CHANGED");
  ok(j.previous_expiry === day(10), `previous expiry reported (${j.previous_expiry})`);
  ok(j.supplier_expires === day(40), `new expiry reported (${j.supplier_expires})`);
  ok(j.message === "Renewed: expiry updated to " + day(40), `message: ${j.message}`);

  const row = await rowOf(ali);
  ok(row.supplier_expires === day(40), "the NEW expiry is persisted");
}

// ---------------------------------------------------------------------------
console.log("\n[4] check with no renewal — the expiry is unchanged");
{
  setPanel("ali", 1, 1.5, 512, day(40)); // same expiry, a little more usage
  const { j } = await renew(ali);
  ok(j.renewed === false && j.expiry_changed === false, "the action reports the expiry did NOT change");
  ok(j.message === "Checked: expiry remains " + day(40), `message: ${j.message}`);
  ok(j.supplier_expires === day(40) && j.previous_expiry === day(40), "same date before and after");
}

// ---------------------------------------------------------------------------
console.log("\n[5] usage increase since the previous successful check");
{
  // Ali currently sits at 2.5 GB used (1 + 1.5). Burn 5 GB more.
  const before = await rowOf(ali);
  ok(before.used_gb === 2.5, `baseline used_gb (${before.used_gb})`);

  setPanel("ali", 3, 4.5, 512, day(40)); // 7.5 GB used
  const { j } = await renew(ali);
  ok(j.used_gb === 7.5, `new used_gb (${j.used_gb})`);
  ok(j.previous_used_gb === 2.5, `previous used_gb carried into the comparison (${j.previous_used_gb})`);
  ok(j.usage_delta_gb === 5, `delta = 7.5 - 2.5 = 5 (got ${j.usage_delta_gb})`);
  ok(j.usage_change === "increase", `classified as an increase (got ${j.usage_change})`);
  ok(j.usage_message === "+5.0 GB used since last check", `message: ${j.usage_message}`);

  const row = await rowOf(ali);
  ok(row.usage_delta_gb === 5, "the delta is PERSISTED in the database");
  ok(row.prev_used_gb === 2.5, "prev_used_gb is persisted so the delta stays auditable");
  ok(row.usage_message === "+5.0 GB used since last check", "the dashboard API serves the same sentence");

  console.log("    …and a check that moves nothing reports exactly that");
  const same = await renew(ali);
  ok(same.j.usage_delta_gb === 0, `delta is 0, not null (got ${same.j.usage_delta_gb})`);
  ok(same.j.usage_change === "same", "classified as unchanged");
  ok(same.j.usage_message === "No new usage since last check", `message: ${same.j.usage_message}`);
  ok((await rowOf(ali)).usage_delta_gb === 0, "a zero delta is persisted as 0, not dropped to null");
}

// ---------------------------------------------------------------------------
console.log("\n[6] usage RESET — the supplier zeroed the counter after a renewal");
{
  // Ali is at 7.5 GB used. The supplier renews and resets the counter to 0.3.
  setPanel("ali", 0.1, 0.2, 512, day(70));
  const { j } = await renew(ali);
  ok(j.used_gb === 0.3, `new used_gb is LOWER (${j.used_gb})`);
  ok(j.usage_delta_gb === -7.2, `negative delta computed (got ${j.usage_delta_gb})`);
  ok(j.usage_change === "reset", `classified as a reset (got ${j.usage_change})`);
  ok(j.usage_message === "Usage reset by 7.2 GB", `message: ${j.usage_message}`);
  ok(j.renewed === true && j.message === "Renewed: expiry updated to " + day(70),
    "a reset alongside a new expiry still reports the renewal");
  ok((await rowOf(ali)).usage_delta_gb === -7.2, "the negative delta is persisted");
}

// ---------------------------------------------------------------------------
console.log("\n[7] a FAILED check must not overwrite anything");
{
  const before = await rowOf(ali);

  // 7a. supplier unreachable
  setPanel("ali", 0, "DEAD", 512, day(70));
  const dead = await renew(ali);
  ok(dead.status === 502 && dead.j.ok === false, `unreachable supplier -> 502 (got ${dead.status})`);
  ok(typeof dead.j.error === "string" && dead.j.error.length > 0, `a clear error is returned (${dead.j.error})`);
  ok(!dead.j.error.includes("panel.example") && !dead.j.error.includes("who=ali"),
    "the failure message never leaks the supplier URL or host");

  let after = await rowOf(ali);
  ok(after.used_gb === before.used_gb, `used_gb preserved (${after.used_gb})`);
  ok(after.supplier_expires === before.supplier_expires, `expiry preserved (${after.supplier_expires})`);
  ok(after.total_gb === before.total_gb, "total_gb preserved");
  ok(after.usage_delta_gb === before.usage_delta_gb, `the previous delta survives the failure (${after.usage_delta_gb})`);
  ok(after.checked_at === before.checked_at, "checked_at is NOT bumped by a failed check");

  // 7b. supplier answers, but with no parsable quota line
  setPanel("ali", 0, "NOSTATUS", 512, day(70));
  const nost = await renew(ali);
  ok(nost.status === 502 && nost.j.ok === false, `unparsable supplier reply -> 502 (got ${nost.status})`);
  ok(nost.j.error.includes("nothing was changed"), `error says nothing changed (${nost.j.error})`);
  after = await rowOf(ali);
  ok(after.used_gb === before.used_gb && after.usage_delta_gb === before.usage_delta_gb,
    "values and delta still untouched after an unparsable reply");
}

// ---------------------------------------------------------------------------
console.log("\n[8] the comparison stays visible until the next SUCCESSFUL check");
{
  const row = await rowOf(ali);
  ok(row.usage_delta_gb === -7.2 && row.usage_message === "Usage reset by 7.2 GB",
    "after two failed checks the dashboard still shows the last successful comparison");
  // and it survives a plain page reload (it is read from the store, not memory)
  const reread = await rowOf(ali);
  ok(reread.usage_delta_gb === -7.2, "still there on the next dashboard.json load");
}

// ---------------------------------------------------------------------------
console.log("\n[9] the per-customer action checks ONE customer only");
setPanel("bao", 5, 5, 200, day(20));
setPanel("chen", 1, 1, 200, day(3));
const bao = await mint("bao", { customer: "Bao" });
const chen = await mint("chen", { customer: "Chen" });
{
  setPanel("ali", 2, 2, 512, day(70));
  fetchLog = [];
  await renew(ali);
  ok(fetchLog.length === 1 && fetchLog[0] === "ali", `exactly one supplier fetch, for Ali only (got ${JSON.stringify(fetchLog)})`);
  ok((await rowOf(bao)).checked_at === null, "Bao was NOT touched by Ali's check");
  ok((await rowOf(chen)).checked_at === null, "Chen was NOT touched by Ali's check");
}

// ---------------------------------------------------------------------------
console.log("\n[10] global /admin/refresh still works — and computes deltas");
{
  fetchLog = [];
  const r1 = await jget("/admin/refresh");
  ok(r1.checked === 3 && r1.updated === 3 && r1.failed === 0, `all 3 checked+updated (got ${JSON.stringify({ c: r1.checked, u: r1.updated, f: r1.failed })})`);
  ok(fetchLog.sort().join(",") === "ali,bao,chen", `every active customer was fetched (${fetchLog.sort().join(",")})`);
  ok(Array.isArray(r1.results) && r1.results.length === 3, "the refresh reports a per-customer result list");
  ok((await rowOf(bao)).used_gb === 10, "Bao's first global check stored usage");
  ok((await rowOf(bao)).usage_delta_gb === null, "Bao's FIRST global check has no delta");

  // Second pass: Bao burns 2.5 GB, Chen's supplier resets, Ali is unchanged.
  setPanel("bao", 6, 6.5, 200, day(20));
  setPanel("chen", 0, 0.25, 200, day(33));
  const r2 = await jget("/admin/refresh");
  ok(r2.updated === 3 && r2.failed === 0, `second pass updated 3 (got ${r2.updated})`);
  ok(r2.renewed === 1, `only Chen's expiry moved (renewed=${r2.renewed})`);

  const b = await rowOf(bao), c = await rowOf(chen), a = await rowOf(ali);
  ok(b.usage_delta_gb === 2.5, `global refresh persisted Bao's +2.5 GB (got ${b.usage_delta_gb})`);
  ok(b.usage_message === "+2.5 GB used since last check", `Bao's sentence: ${b.usage_message}`);
  ok(c.usage_delta_gb === -1.75, `global refresh persisted Chen's reset (got ${c.usage_delta_gb})`);
  ok(c.usage_message === "Usage reset by 1.8 GB", `Chen's sentence: ${c.usage_message}`);
  ok(a.usage_delta_gb === 0 && a.usage_message === "No new usage since last check", `Ali unchanged: ${a.usage_message}`);

  // A customer whose supplier is down must not poison the others.
  setPanel("bao", 0, "DEAD", 200, day(20));
  const bBefore = await rowOf(bao);
  const r3 = await jget("/admin/refresh");
  ok(r3.checked === 3 && r3.updated === 2 && r3.failed === 1, `one failure isolated (got ${JSON.stringify({ c: r3.checked, u: r3.updated, f: r3.failed })})`);
  const bAfter = await rowOf(bao);
  ok(bAfter.used_gb === bBefore.used_gb && bAfter.usage_delta_gb === bBefore.usage_delta_gb,
    "the failed customer keeps its previous values AND delta during a global refresh");
  ok((await rowOf(chen)).usage_delta_gb === 0, "the healthy customers were still updated");
  setPanel("bao", 6, 6.5, 200, day(20)); // restore
}

// ---------------------------------------------------------------------------
console.log("\n[11] revoked, unknown and non-checkable customers are handled safely");
{
  const unknown = await renew("0".repeat(48));
  ok(unknown.status === 404 && unknown.j.ok === false, `unknown token -> 404 (got ${unknown.status})`);
  ok(unknown.j.error === "unknown token", `clear error (${unknown.j.error})`);

  const junk = await renew("not-a-real-token");
  ok(junk.status === 404, `garbage token -> 404 (got ${junk.status})`);

  // revoke Chen, then try to check them
  await get("/admin/link/" + chen + "?action=revoke");
  const cBefore = await rowOf(chen);
  fetchLog = [];
  const rev = await renew(chen);
  ok(rev.status === 409 && rev.j.ok === false, `revoked customer -> 409 (got ${rev.status})`);
  ok(rev.j.error.includes("revoked"), `error explains why (${rev.j.error})`);
  ok(fetchLog.length === 0, "a revoked customer's supplier is never contacted");
  const cAfter = await rowOf(chen);
  ok(cAfter.used_gb === cBefore.used_gb && cAfter.usage_delta_gb === cBefore.usage_delta_gb,
    "a revoked customer's stored values are untouched");

  // global refresh keeps skipping revoked rows
  const g = await jget("/admin/refresh");
  ok(g.checked === 2, `global refresh skips the revoked customer (checked ${g.checked})`);

  // a direct node list has no supplier panel behind it
  const dr = await post("/admin/mint", { link: NODE, customer: "DirectDave", label: "DirectDave" });
  const direct = JSON.parse(await dr.text()).token;
  const dres = await renew(direct);
  ok(dres.status === 422 && dres.j.ok === false, `direct node list -> 422 (got ${dres.status})`);
  ok(dres.j.error.includes("direct node list"), `error explains why (${dres.j.error})`);

  // an unsupported action is still rejected clearly
  const badAction = await get("/admin/link/" + ali + "?action=explode");
  ok(badAction.status === 400, `unknown action -> 400 (got ${badAction.status})`);
  ok((await badAction.text()).includes("check | renew | pay/paid/unpaid (POST) | rotate | revoke | delete"), "the error lists renew and the billing actions alongside the existing ones");
}

// ---------------------------------------------------------------------------
console.log("\n[12] supplier URLs stay redacted from every admin API");
{
  const bodies = {
    "dashboard.json": await (await get("/admin/dashboard.json")).text(),
    "admin/links": await (await get("/admin/links")).text(),
    "admin/refresh": await (await get("/admin/refresh")).text(),
    "renew response": JSON.stringify((await renew(ali)).j),
    "renew failure": JSON.stringify((await renew("0".repeat(48))).j),
    "admin page": await (await get("/admin")).text(),
  };
  for (const [name, text] of Object.entries(bodies)) {
    ok(!text.includes("supplier_url"), `${name}: no supplier_url key`);
    ok(!text.includes("/sub?who="), `${name}: no supplier subscription path`);
    ok(!text.includes("who=ali"), `${name}: no supplier query string / token`);
    ok(!text.includes("panel.example/"), `${name}: no full supplier URL`);
  }
  // NOTE: redact() deliberately exposes `supplier_host` (the bare hostname) and
  // has done since before this change — the dashboard shows which supplier a
  // customer sits on. That is existing, intentional behaviour: the *secret* is
  // the subscription URL with its token, and that never leaves. Asserted here
  // so a future change cannot quietly widen it into the full URL.
  const { j } = await renew(ali);
  ok(j.customer && j.customer.token === ali, "renew returns the refreshed (redacted) customer row");
  ok(j.customer.supplier_host === "panel.example", "…carrying only the supplier HOST, exactly as the dashboard already did");
  ok(j.customer.supplier_url === undefined, "…and never the supplier URL itself");
  ok(!JSON.stringify(j).includes("/sub?"), "…and no path or query string anywhere in the payload");
}

// ---------------------------------------------------------------------------
console.log("\n[13] the action is read-only against the supplier");
{
  // Every supplier call the renew path makes must be a plain GET with no body:
  // this action verifies a renewal, it never performs one.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => { calls.push({ method: (init && init.method) || "GET", body: init && init.body }); return realFetch(u, init); };
  setPanel("ali", 3, 3, 512, day(70));
  await renew(ali);
  globalThis.fetch = realFetch;
  ok(calls.length === 1, `one supplier call (got ${calls.length})`);
  ok(calls.every((c) => c.method === "GET"), "the supplier is only ever GET-ed");
  ok(calls.every((c) => !c.body), "no body is ever sent to the supplier — nothing can be purchased");
}

// ---------------------------------------------------------------------------
console.log("\n[14] checkCustomerRow() is self-contained and never throws");
{
  const boom = await checkCustomerRow(
    { token: "t", supplier_url: "https://panel.example/sub?who=ali", revoked: false },
    {
      fetchSubscription: async () => { throw new Error("kaboom https://panel.example/sub?who=ali"); },
      quotaSummary: () => null,
      updateRow: async () => { throw new Error("should not be called"); },
    },
  );
  ok(boom.ok === false && boom.code === 502, "a throwing supplier becomes a clean 502 result, not an exception");
  ok(!boom.error.includes("panel.example"), `and the URL is scrubbed from it (${boom.error})`);

  const nullRow = await checkCustomerRow(null, {});
  ok(nullRow.ok === false && nullRow.code === 404, "a missing row is a safe 404 result");

  const writeFail = await checkCustomerRow(
    { token: "t", supplier_url: "https://panel.example/sub?who=ali", revoked: false, used_gb: 1 },
    {
      fetchSubscription: async () => ({ status: `STATUS=↑:1.00GB,↓:1.00GB,TOT:10GB Expires:${day(5)}` }),
      quotaSummary: (s) => { const m = s.match(/↑:([\d.]+)GB,↓:([\d.]+)GB,TOT:([\d.]+)GB.*?Expires:([\d-]+)/); return { up: +m[1], down: +m[2], tot: +m[3], left: 0, exp: m[4] }; },
      updateRow: async () => { throw new Error("db offline"); },
    },
  );
  ok(writeFail.ok === false && writeFail.code === 500, "a store write failure is reported, not swallowed as success");
}

// ---------------------------------------------------------------------------
console.log("\n[15] the dashboard renders the new control without losing the old ones");
{
  const html = await (await get("/admin")).text();
  const vm = await import("node:vm");

  // The production "Operations Overview" shell must survive untouched.
  for (const marker of [
    "OPERATIONS OVERVIEW", "Keep every customer", "reseller dashboard",
    "Panel account email", "Revenue / month", "Profit / month",
    "accounts tracked", "Needs attention", "Expiring ≤ 30 days",
  ]) ok(html.includes(marker), `production dashboard keeps "${marker}"`);

  // Every existing row action is still rendered.
  for (const action of ["copy", "edit", "rotate", "revoke", "delete"])
    ok(html.includes('"' + action + '"'), `existing row action "${action}" still wired up`);

  // …plus the new one.
  ok(html.includes('actionButton("check"'), "the per-customer Check button is rendered");
  ok(html.includes("action=check"), "it calls the supplier-only check endpoint");
  ok(html.includes("usage_message"), "the usage comparison sentence is rendered from the API");

  // The global refresh control is untouched.
  ok(html.includes("Refresh quota") && html.includes("/admin/refresh"), "the global refresh is still present");

  // No CDN, and the inlined client must still parse — a SyntaxError here
  // would leave the whole dashboard stuck on "Loading…".
  ok(!html.includes("<script src="), "no external script tags (still loads from China)");
  ok(!html.includes("http://"), "no plain-http references introduced");
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  let parsed = false;
  try { new vm.Script(script[1]); parsed = true; } catch (e) { console.log("     parse error:", e.message); }
  ok(parsed, "the inlined client script is still valid JavaScript");

  // The sweep now pages, so the page has to say so and follow the cursor.
  ok(html.includes("/admin/refresh?after="), "the dashboard drives /admin/refresh with an explicit cursor");
  ok(/of " \+ total/.test(html) || html.includes('Checking " + checked'), "the button counts up while it pages");
  ok(html.includes("not checked"), "a cut-off sweep is reported as 'not checked', not as a supplier failure");

  // readAgo() decides what the renewal cell means, so run the SHIPPED copy on a
  // frozen clock rather than trust it reads well: blank must stay blank (never
  // checked) and every unit boundary must pluralise and not go negative.
  const fn = html.match(/const readAgo = \(iso\) => \{([\s\S]*?)\n\};/);
  ok(!!fn, "the dashboard ships readAgo() for the renewal cell");
  if (fn) {
    const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
    const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
    const ctx = vm.createContext({
      prettyDate: (s) => "date:" + String(s).slice(0, 10),
      out: null,
    });
    vm.runInContext(
      // take the helper exactly as shipped (statement form), no re-wrapping
      // S/M/H/D and NOW live in THIS realm, so the units have to be declared
      // inside the sandbox too — a vm context shares nothing implicitly.
      "const NOW = " + NOW + ", S = " + S + ", M = " + M + ", H = " + H + ", D = " + D + ";\n" +
      "Date.now = () => NOW;\n" + fn[0].replace(/;\s*$/, "") + "\n" +
      "const iso = (ms) => new Date(NOW - ms).toISOString();\n" +
      "out = [readAgo(''), readAgo('0'), readAgo('garbage'), readAgo(iso(30 * S))," +
      " readAgo(iso(-5 * M)), readAgo(iso(5 * M)), readAgo(iso(60 * M)), readAgo(iso(2 * H))," +
      " readAgo(iso(25 * H)), readAgo(iso(2 * D)), readAgo(iso(40 * D))]", ctx,
    );
    const want = ["", "", "", "just now", "just now", "5 min ago", "1 hour ago",
      "2 hours ago", "1 day ago", "2 days ago", "date:2026-10-01"]; // NOW − 40 d
    ctx.out.forEach((got, i) => ok(got === want[i], `readAgo → "${want[i]}" (got "${got}")`));
  }
}

// ---------------------------------------------------------------------------
console.log("\n[16] /admin/refresh pages, so a big book cannot be cut off");
{
  // What this pins: the sweep used to be ONE request over every customer. With
  // ~114 rows and a 500 ms panel that is 9.6 s against Netlify's 10 s function
  // ceiling (and that ceiling is a plan limit, not a netlify.toml setting), so
  // the request died mid-book and the dashboard could only say "Refresh failed"
  // — which reads exactly like a supplier outage when the supplier was fine.
  const extra = [];
  for (let n = 0; n < 14; n++) { const who = "bulk" + n; setPanel(who, 1, 1, 100, day(30)); extra.push(await mint(who)); }
  fetchLog = [];

  const first = await jget("/admin/refresh?after=0&batch=1");
  const TOTAL = first.total;
  ok(TOTAL >= 8, `the book has ${TOTAL} checkable customers — more than one page`);
  ok(first.checked === 6 && first.remaining === TOTAL - 6 && first.partial === true,
    `one page checks one batch and admits the rest is pending (got ${JSON.stringify({ c: first.checked, r: first.remaining, p: first.partial })})`);
  ok(first.next === 6, `…and hands back the offset to continue from (next=${first.next})`);
  ok(first.total === TOTAL && first.checked < first.total, "checked counts THIS call, total counts the book");

  const seen = (first.results || []).slice();
  let after = first.next, guard = 0, last = first;
  while (after) {
    if (++guard > 40) break;
    last = await jget("/admin/refresh?after=" + after + "&batch=1");
    seen.push(...(last.results || []));
    after = last.next;
  }
  ok(guard <= 40, `the sweep converged in ${guard + 1} page(s)`);
  ok(seen.length === TOTAL, `every customer was checked exactly once across pages (${seen.length}/${TOTAL})`);
  ok(new Set(seen.map((r) => r.token)).size === seen.length, "no customer was checked twice by the paging");
  ok(last.remaining === 0 && last.partial === false && last.next === null, "the final page reports the book as done");
  const oks = seen.filter((t) => t.ok === true).length;
  ok(fetchLog.length >= oks && fetchLog.length <= oks * 3,
    `one supplier call per checked customer, retries bounded (${fetchLog.length} calls for ${oks} checkable rows)`);

  // A page with no time left must come back honestly instead of being killed.
  // The panel is made slow AND signal-aware: fetchSubscription bounds each row by
  // AbortSignal.timeout(what is left of the request), so a stub that ignored the
  // signal would prove nothing about that bound.
  const fast = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    await new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("abort-test: panel too slow")), 4000);
      const sig = init && init.signal;
      if (sig) { if (sig.aborted) { clearTimeout(t); reject(new Error("aborted")); return; } sig.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }); }
    });
    return fast(u, init);
  };
  const t0 = Date.now();
  const tight = await jget("/admin/refresh?after=0&budget=1600");
  const ms = Date.now() - t0;
  globalThis.fetch = fast;
  ok(ms < 3500, `a 1.6 s budget returned in ${ms} ms — it did not wait for a 4 s panel`);
  ok(tight.failed === 6 && tight.checked === 6, `rows it could not finish are reported as failures, not swallowed (${JSON.stringify({ c: tight.checked, f: tight.failed })})`);
  ok(tight.remaining === TOTAL - 6 && tight.partial === true, "…and the rest of the book stays queued, so nothing is silently skipped");

  // Garbage or out-of-range cursors cannot corrupt the sweep.
  const junk = await jget("/admin/refresh?after=abc&batch=zz");
  ok(junk.offset === 0 && junk.checked > 0, `a non-numeric cursor starts at the top, not at NaN (${JSON.stringify({ o: junk.offset, c: junk.checked })})`);
  const over = await jget("/admin/refresh?after=99999");
  ok(over.checked === 0 && over.remaining === 0 && over.partial === false, "an offset past the end is an empty page, not an error");
  const huge = await jget("/admin/refresh?budget=999999");
  ok(huge.checked === TOTAL, "an absurd budget is clamped to the platform-safe maximum, not honoured");

  const j2 = await jget("/admin/refresh?after=0&batch=1");
  const j3 = await jget("/admin/refresh?after=6&batch=1");
  ok(j2.checked + j3.checked <= TOTAL, "pages report disjoint slices of the book");
  ok(j2.updated === 6 && j3.updated > 0, `each page counts its own updates (${j2.updated} + ${j3.updated})`);

  // Paging is only safe if the pages are not replayed from the edge cache: a
  // cached "after=6" would hand back "after=0" a second time and the sweep would
  // never reach the end of the book. Netlify's [[headers]] rules cannot express
  // this (they never apply to a function response), so it must come from json().
  for (const path of ["/admin", "/admin/dashboard.json", "/admin/health", "/admin/refresh?after=0&batch=1", "/diag"]) {
    const r = await get(path);
    const cc = r.headers.get("cache-control");
    ok(cc && cc.includes("no-store"), `${path.split("?")[0]} answers with Cache-Control: no-store (got ${JSON.stringify(cc)})`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n[17] a rate limit is not an outage; a loop-back link is not a supplier; a shared pack is fetched once");
{
  // Live evidence from the 2026-11-10 investigation: of the 96 customers the sweep
  // could reach, 58 failed — and those failures were THREE different problems,
  // every one of them printed as "supplier issue". This section pins each apart.
  //
  // NB the store orders by created_at DESC (newest first), so everything minted
  // here is at the FRONT of the book: rows[0..5] are the six wall customers and
  // rows[6] is the one that should never be reached.
  setPanel("afterwall", 1, 1, 100, day(21));
  const survivor = await mint("afterwall", { customer: "AfterTheWall" });
  setPanel("wall", 1, "CHALLENGE", 100, day(9));
  const wallToks = [];
  for (let n = 0; n < 6; n++) wallToks.push(await mint("wall", { customer: "Wall" + n }));
  const total = (await jget("/admin/refresh?after=99999")).total;
  ok(total >= 8, `the book holds ${total} customers, so a back-off has somewhere left to go`);

  fetchLog = [];
  const page = await jget("/admin/refresh?after=0");
  ok(page.checked === 6, `the sweep did one batch and stopped (checked ${page.checked}, not ${total})`);
  ok(page.throttled === 6 && page.failed === 6,
    `all six are classified as throttling, not as broken data (${JSON.stringify({ t: page.throttled, f: page.failed })})`);
  ok(page.backed_off === true, "the response admits it backed off, so the dashboard can say WAIT instead of FAILED");
  ok(page.remaining === total - 6 && page.partial === true && page.next === 6,
    `everyone else stays queued rather than being skipped (${JSON.stringify({ r: page.remaining, p: page.partial, n: page.next })})`);
  // fetchSubscription tries up to 3 user agents per call, so ONE logical fetch of a
  // shared subscription logs 3 entries. Un-deduped it would be 18: six customers on
  // one 512 GB pack asking the panel the same question six times at once, which is
  // exactly what pulls a CDN challenge down on the whole sweep.
  const wallCalls = fetchLog.filter((w) => w === "wall").length;
  ok(wallCalls > 0 && wallCalls <= 3, `six customers sharing one subscription cost ONE logical fetch (${wallCalls} UA attempts, not 18)`);
  ok(new Set(fetchLog).size === 1, `only that subscription was touched (${JSON.stringify([...new Set(fetchLog)])})`);
  ok((await rowOf(survivor)).checked_at == null, "the customer behind the wall was not touched");

  const resume = await jget("/admin/refresh?after=" + page.next + "&batch=1");
  ok(resume.checked === 6 && resume.results.some((x) => x.ok && x.customer === "AfterTheWall"),
    "resuming from the returned cursor reaches the row the wall stopped us at");

  // One challenged row inside an otherwise healthy batch must NOT stop the book:
  // the first live paged run was 17 updated + 1 bot-check, and stopping there would
  // have discarded 96 customers that were answering fine.
  {
    const { REFRESH_THROTTLE_STOP } = await import("../sp-vpn-worker.js");
    // the six wall rows from above are still in the book; with their panel healthy
    // again, the ONLY challenged row here is the lonely one — which is the case
    // that must not stop anything.
    setPanel("wall", 1, 1, 100, day(9));
    ok(REFRESH_THROTTLE_STOP === 2, `a host has to push back ${REFRESH_THROTTLE_STOP}× before the sweep gives up`);
    for (let n = 0; n < 5; n++) { setPanel("healthy" + n, 1, 1, 100, day(25 + n)); await mint("healthy" + n, { customer: "H" + n }); }
    setPanel("singlewall", 1, "CHALLENGE", 100, day(9));
    const lonely = await mint("singlewall", { customer: "LonelyWall" });
    const one = await jget("/admin/refresh?after=0");
    ok(one.throttled === 1 && one.checked >= 6, `one wall row among healthy customers (checked ${one.checked}, throttled ${one.throttled})`);
    ok(one.backed_off === false, "the sweep does NOT stop for a single challenged row");
    ok(one.remaining === 0 || one.partial === false || one.checked > 6, "…and keeps going through the rest of the book");
    ok(one.results.some((x) => x.customer === "H4" && x.ok === true), "the healthy rows around it were still updated");
    ok(one.throttle_hosts.length === 1 && /panel\.example/.test(one.throttle_hosts[0]),
      `the response names which panel pushed back (${JSON.stringify(one.throttle_hosts)})`);
    ok((await rowOf(lonely)).checked_at == null, "the challenged row still kept its old values");
  }

  // One row at a time gets the same honesty, with the status the fix deserves.
  // Re-arm the wall and use a FRESH row: the six above were just checked
  // successfully by the lonely-row sweep, so their checked_at is no longer null.
  setPanel("wall", 1, "CHALLENGE", 100, day(9));
  const perRowWall = await mint("wall", { customer: "WallSolo" });
  const r = await get("/admin/link/" + perRowWall + "?action=check");
  const j = JSON.parse(await r.text());
  ok(r.status === 503, `a challenged single-row check answers 503, not 502 (got ${r.status})`);
  ok(j.ok === false && j.throttled === true, "and it carries the throttled flag the dashboard reads");
  ok(/rate.?limit|bot check/i.test(j.error), `the sentence says what to do about it (${JSON.stringify(j.error)})`);
  ok((await rowOf(perRowWall)).checked_at == null, "a throttled check still writes nothing");

  // ---- (b) the loop-back link: a customer link saved as if it were the supplier's
  const loopTok = await mint("loop", { customer: "Loopy" });
  setPanel("loop", 1, 1, 100, day(5));
  await store.updateRow(loopTok, { supplier_url: HOST + "/all/SP VPN?t=" + loopTok });
  let allFetches = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { allFetches++; return inner(u, i); };
  const rl = await get("/admin/link/" + loopTok + "?action=check");
  globalThis.fetch = inner;
  const jl = JSON.parse(await rl.text());
  ok(rl.status === 422 && jl.self_referential === true,
    `a customer link saved as the supplier link is refused by name (${JSON.stringify({ s: rl.status, r: jl.self_referential })})`);
  ok(/our own customer links/i.test(jl.error || ""), `…with the fix in the sentence (${JSON.stringify(jl.error)})`);
  ok(allFetches === 0, `and it costs no fetch at all — it used to ask the panel, and the panel was us (${allFetches})`);
  ok((await rowOf(loopTok)).supplier_expires == null, "nothing was written for the loop-back row");

  // A supplier URL that merely LIVES under one of our route names, on a foreign
  // host, is not ours — the host half of the test is what keeps this from being a
  // false accusation against a real panel.
  setPanel("dead", 1, "DEAD", 0, day(1));
  await store.updateRow(loopTok, { supplier_url: "https://panel.example/sr/other-tenant?who=dead" });
  const r2 = await get("/admin/link/" + loopTok + "?action=check");
  const j2 = JSON.parse(await r2.text());
  // …and a /sub/ path ON OUR OWN HOST that is not one of our tokens is still a
  // supplier link. This is the case the branded domain creates: the owner proxies
  // the panel through the same hostname as the customer links, so the route name
  // alone cannot tell them apart — the 48-hex token shape can.
  await store.updateRow(loopTok, { supplier_url: HOST + "/sub/account-one?token=PRIVATE-SUPPLIER-SECRET" });
  const r3 = await get("/admin/link/" + loopTok + "?action=check");
  const j3 = JSON.parse(await r3.text());
  // The proof that does not need a host at all: the branded domain serves BOTH our
  // customer links and the panel, so on that domain only "this token belongs to a
  // row of the book" distinguishes a loop-back from a supplier link.
  await store.updateRow(loopTok, { supplier_url: "https://brand.example/sub/" + survivor });
  const r4 = await get("/admin/link/" + loopTok + "?action=check");
  const j4 = JSON.parse(await r4.text());
  ok(r4.status === 422 && j4.self_referential === true && j4.points_at === "AfterTheWall",
    `a loop-back on a foreign-looking host is caught by the token, and named (${JSON.stringify({ s: r4.status, at: j4.points_at })})`);
  ok(/belongs to AfterTheWall/.test(j4.error || ""), "…and says whose link it is");

  ok(j3.self_referential === false && r3.status === 502,
    `our own host + /sub/ + a non-token path is fetched, not refused (${JSON.stringify({ s: r3.status, r: j3.self_referential })})`);

  ok(j2.self_referential === false && j2.throttled === false && r2.status === 502,
    `someone else's /sr/ path is still tried and reported as a real failure (${JSON.stringify({ s: r2.status, r: j2.self_referential, t: j2.throttled })})`);

  // ---- (c) the classifier, unit-tested, because everything above rides on it
  const { isThrottleResponse } = await import("../sp-vpn-worker.js");
  const cases = [
    [[403, ""], true, "403"],
    [[429, "slow down"], true, "429"],
    [[200, "<html>Just a moment...</html>"], true, "200 with a challenge page"],
    [[503, "Attention Required! | Cloudflare"], true, "503 interstitial"],
    [[200, "STATUS=↑:1GB,↓:2GB,TOT:512GB Expires:2026-12-01\nvless://a@b:443#x"], false, "a real payload"],
    [[500, "upstream exploded"], false, "a plain server error"],
    [[200, "x".repeat(5000)], false, "a long body cannot be a wall"],
  ];
  for (const [args, want, label] of cases)
    ok(isThrottleResponse(...args) === want, `isThrottleResponse(${label}) → ${want}`);
}

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
