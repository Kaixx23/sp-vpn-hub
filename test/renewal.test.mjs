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
}

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
