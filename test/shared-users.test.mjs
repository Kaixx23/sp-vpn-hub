// Read-only shared-link discovery: matching rules, chain resolution, privacy,
// no-write/no-network guarantees, HTTP semantics and the real dashboard dialog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import {
  sharedUsersReport, sharedUsersForToken, MAX_HOPS, SHARED_USERS_NOTE,
} from "../shared-users.js";

const HOST = "https://sp.example.com";
const SUP = "https://panel.example/api/v1/client/subscribe?token=PRIVATE-SUPPLIER-SECRET";
const SUP2 = "https://panel.example/api/v1/client/subscribe?token=OTHER-SUPPLIER-SECRET";
const PANEL_PW = "test-only-panel-password-9f3a";
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const get = (path, init) => worker.fetch(new Request(HOST + path, init), {}, {});
const jget = async (path, init) => {
  const r = await get(path, init);
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const post = (path, data) => worker.fetch(new Request(HOST + path, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
}), {}, {});
const mint = async (data) => (await post("/admin/mint", data)).json();

async function reset() {
  store.setBackend(new store.MemoryBackend());
  store.clearCache();
  await store.ensureInit();
}
async function waitFor(check, message) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) assert.fail("Timed out: " + message);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const hub = (token, kind = "all") => {
  if (kind === "all" || kind === "sr") return `${HOST}/${kind}/SP%20VPN?t=${token}`;
  return `${HOST}/${kind}/${token}`;
};

test("1. customers on the same complete supplier URL group, even when still marked Individual", async () => {
  await reset();
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  const b = await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });
  const c = await mint({ link: SUP, customer: "Cy", supplier_account: "Acct 01" });
  // Historical duplicate: a shared customer whose type label was never corrected.
  await store.updateRow(b.token, { customer_type: "individual" });

  const report = sharedUsersReport(await store.listAll(), HOST);
  assert.equal(report.group_count, 1);
  assert.equal(report.groups[0].active_count, 3, "matching ignores the Individual/Shared label");
  assert.deepEqual(report.groups[0].active.map((m) => m.name).sort(), ["Ali", "Bo", "Cy"]);
  assert.equal(report.groups[0].account.host, "panel.example");
  assert.equal(report.groups[0].account.name, "Acct 01");

  const http = await jget("/admin/shared-users");
  assert.equal(http.status, 200);
  assert.equal(http.headers.get("cache-control"), "no-store");
  assert.equal(http.body.groups[0].active_count, 3);
  assert.equal(http.body.note, SHARED_USERS_NOTE);
});

test("2. same host/email/label but different supplier tokens are never grouped", async () => {
  await reset();
  const a = await mint({
    link: SUP, customer: "Ali", supplier_account: "Same label", account_email: "same@panel.test",
  });
  await mint({
    link: SUP2, customer: "Bo", supplier_account: "Same label", account_email: "same@panel.test",
  });
  const report = sharedUsersReport(await store.listAll(), HOST);
  assert.equal(report.group_count, 0, "hostname/email/label alone do not identify a subscription");
  const single = await jget(`/admin/shared-users?token=${a.token}`);
  assert.equal(single.body.group.active_count, 1);
  assert.equal(single.body.other_active_count, 0);
  assert.equal(single.body.group.account.host, "panel.example");
});

test("3. nested, copied and legacy base64 Hub links all resolve to the original supplier source", async () => {
  await reset();
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  const b = await store.mint(hub(a.token), "Bo", { customer: "Bo" });                                   // /all/?t=A (string token)
  const c = await store.mint(hub(b, "sr"), "Cy", { customer: "Cy" });                                  // /sr/?t=B (nested)
  const d = await store.mint(hub(c, "q"), "Di", { customer: "Di" });                                   // /q/C
  const e = await store.mint(`${HOST}/sub/${c}.yaml`, "Ed", { customer: "Ed" });                       // /sub/<t>.yaml suffix
  const f = await store.mint(hub(b, "share"), "Fi", { customer: "Fi" });                               // /share/B
  const g = await store.mint(`${HOST}/q/${b64url(SUP)}`, "Legacy", { customer: "Gia" });               // legacy base64 Hub link
  // A genuine external supplier /sub/<id> must not be mistaken for a Hub link.
  const ext = await mint({ link: "https://real-supplier.example/sub/abc123-signed-id", customer: "Ex" });

  const report = sharedUsersReport(await store.listAll(), HOST);
  const big = report.groups.find((g2) => g2.active.some((m) => m.name === "Ali"));
  assert.ok(big, "the chain resolves to one shared supplier group");
  assert.deepEqual(big.active.map((m) => m.name).sort(), ["Ali", "Bo", "Cy", "Di", "Ed", "Fi", "Gia"]);
  assert.equal(report.groups.find((g2) => g2.active.some((m) => m.name === "Ex")), undefined);
  const extSingle = sharedUsersForToken(await store.listAll(), HOST, ext.token);
  assert.equal(extSingle.selected.resolved, true);
  assert.equal(extSingle.group.active_count, 1, "external /sub/<id> is a normal supplier URL, not a missing Hub record");
  assert.equal(extSingle.warnings.length, 0);

  // Every customer still has its own opaque token.
  const tokens = (await store.listAll()).map((r) => r.token);
  assert.equal(new Set(tokens).size, tokens.length);
});

test("4. revoked, rotated and system-generated records never inflate active-person counts", async () => {
  await reset();
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  const b = await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });
  const c = await mint({ link: SUP, customer: "Cy" });
  await get(`/admin/link/${b.token}?action=revoke`);
  const rotation = await (await get(`/admin/link/${c.token}?action=rotate`)).json();
  // Anonymous operational rows that happen to reference the same supplier URL.
  await store.mint(SUP, "quota-page");
  await store.mint(SUP, "seller-tool");

  const report = sharedUsersReport(await store.listAll(), HOST);
  assert.equal(report.group_count, 1);
  const g = report.groups[0];
  assert.equal(g.active_count, 2, "only Ali + the rotated active record count as people");
  assert.equal(g.revoked_count, 2, "Bo and Cy's pre-rotation record are listed separately");
  assert.deepEqual(g.active.map((m) => m.token).sort(), [a.token, rotation.newToken].sort());
  assert.ok(g.revoked.every((m) => m.revoked));
  assert.ok(!JSON.stringify(g).includes("quota-page"), "generated records stay out of member lists");

  const revokedView = await jget(`/admin/shared-users?token=${b.token}`);
  assert.equal(revokedView.status, 200, "a revoked customer still gets a full group view");
  assert.equal(revokedView.body.selected.revoked, true);
  assert.ok(revokedView.body.group.revoked.some((m) => m.token === b.token && m.selected));

  const generatedToken = (await store.listAll()).find((r) => r.label === "quota-page").token;
  assert.equal((await get(`/admin/shared-users?token=${generatedToken}`)).status, 404, "non-customer token -> 404");
});

test("5. missing originals, invalid links, cycles and excessive nesting are flagged Needs review", async () => {
  await reset();
  const unknown = "0".repeat(48);
  const missing = await store.mint(`${HOST}/q/${unknown}`, "Missing", { customer: "Mia" });
  const garbage = await store.mint("garbage not a url at all", "Garbage", { customer: "Gar" });
  const empty = await store.mint("   ", "Empty", { customer: "Emp" });
  // Two rows pointing at each other: a cycle.
  const cycA = await store.mint("placeholder-a", "CycA", { customer: "Cyc A" });
  const cycB = await store.mint(hub(cycA), "CycB", { customer: "Cyc B" });
  await store.updateRow(cycA, { supplier_url: hub(cycB) });
  // A chain longer than MAX_HOPS.
  let previous = SUP;
  let deepToken = null;
  for (let i = 0; i < MAX_HOPS + 3; i++) {
    deepToken = await store.mint(previous, "Deep" + i, { customer: "Deep " + i });
    previous = hub(deepToken);
  }

  const report = sharedUsersReport(await store.listAll(), HOST);
  const flagged = [missing, garbage, empty, cycA, cycB, deepToken];
  const memberTokens = report.groups.flatMap((g) => [...g.active, ...g.revoked].map((m) => m.token));
  for (const token of flagged) {
    assert.ok(!memberTokens.includes(token), "unresolved records are never placed in a group: " + token);
  }
  const byToken = Object.fromEntries(report.unresolved.map((u) => [u.token, u]));
  assert.equal(byToken[missing].reason, "missing-record");
  assert.equal(byToken[garbage].reason, "invalid-link");
  assert.equal(byToken[empty].reason, "invalid-link");
  assert.equal(byToken[cycA].reason, "cycle");
  assert.equal(byToken[cycB].reason, "cycle");
  assert.equal(byToken[deepToken].reason, "too-deep");
  assert.equal(report.unresolved_count, report.unresolved.length);
  assert.ok(report.warnings.every((w) => w.includes("Needs review")));
  // No warning text leaks the malformed URL.
  assert.ok(!JSON.stringify(report).includes(unknown));

  const single = await jget(`/admin/shared-users?token=${missing}`);
  assert.equal(single.status, 200);
  assert.equal(single.body.selected.resolved, false);
  assert.equal(single.body.selected.reason, "missing-record");
  assert.equal(single.body.group, null);
  assert.match(single.body.warnings[0], /Needs review/);
});

test("6. reports and errors never leak supplier URLs, upstream tokens, passwords or raw keys", async () => {
  await reset();
  const a = await mint({
    link: SUP, customer: "Ali", supplier_account: "Acct 01",
    account_email: "owner@panel.test", account_password: PANEL_PW,
  });
  await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });
  const legacyToken = b64url(SUP);
  await store.mint(`${HOST}/q/${legacyToken}`, "Legacy", { customer: "Gia" });

  const bodies = [];
  for (const path of [
    "/admin/shared-users",
    `/admin/shared-users?token=${a.token}`,
    "/admin/shared-users?token=",
    `/admin/shared-users?token=${"0".repeat(48)}`,
  ]) {
    const r = await get(path);
    bodies.push(await r.text());
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const r = await get("/admin/shared-users", { method });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "GET");
    assert.equal(r.headers.get("cache-control"), "no-store");
    bodies.push(await r.text());
  }
  const all = bodies.join("\n");
  for (const secret of ["PRIVATE-SUPPLIER-SECRET", PANEL_PW, "supplier_url", "account_password", legacyToken, SUP]) {
    assert.ok(!all.includes(secret), "response must not contain: " + secret);
  }

  // A database failure produces a generic message, never internals.
  const seeded = store.backend();
  const failing = Object.create(seeded);
  failing.list = async () => { throw new Error("turso down: " + SUP); };
  store.setBackend(failing);
  const r = await get("/admin/shared-users");
  assert.equal(r.status, 500);
  const text = await r.text();
  assert.ok(!text.includes("PRIVATE-SUPPLIER-SECRET") && !text.includes("turso"));
  assert.match(text, /try again/i);
  store.setBackend(seeded);
});

test("7. discovery makes no network requests and no storage writes", async () => {
  await reset();
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("discovery must never perform a network request"); };
  const seeded = store.backend();
  const readOnly = Object.create(seeded);
  for (const mutator of ["put", "update", "del", "markSent"]) {
    readOnly[mutator] = async () => { throw new Error("discovery must never write (" + mutator + ")"); };
  }
  store.setBackend(readOnly);
  try {
    assert.equal((await get("/admin/shared-users")).status, 200);
    assert.equal((await get(`/admin/shared-users?token=${a.token}`)).status, 200);
  } finally {
    store.setBackend(seeded);
    globalThis.fetch = realFetch;
  }
});

test("8. scanning leaves every customer, payment and link record exactly unchanged", async () => {
  await reset();
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  const b = await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });
  await post(`/admin/link/${b.token}?action=pay`, { paid_until: day(21) });
  await store.updateRow(a.token, { supplier_expires: day(40), notes: "keep me" });
  const before = structuredClone(await store.listAll());

  await get("/admin/shared-users");
  await get(`/admin/shared-users?token=${a.token}`);
  await get(`/admin/shared-users?token=${b.token}`);
  sharedUsersReport(await store.listAll(), HOST);
  sharedUsersForToken(await store.listAll(), HOST, a.token);

  assert.deepEqual(await store.listAll(), before);
  const afterA = (await store.listAll()).find((r) => r.token === a.token);
  assert.equal(afterA.notes, "keep me");
  assert.equal(afterA.supplier_expires, day(40));
  assert.equal((await store.listAll()).find((r) => r.token === b.token).paid_until, day(21));
});

test("9. dashboard dialog: global and per-customer results, filter independence, escaping, retry, stale replies and focus", async (t) => {
  await reset();
  const evilName = "<img src=x onerror=alert(1)> Bella";
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct <b>01</b>" });
  const b = await mint({ link: a.oneLink, customer: evilName, customer_type: "shared" });
  const c = await mint({ link: SUP2, customer: "Solo" });
  const html = await (await get("/admin")).text();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));
  let stall = null;
  let failNext = false;
  const dom = new JSDOM(html, {
    url: HOST + "/admin", runScripts: "dangerously", virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (path, init = {}) => {
        const p = String(path);
        if (p.includes("/admin/shared-users")) {
          if (stall) return stall.promise;
          if (failNext) {
            failNext = false;
            return new Response(JSON.stringify({ error: "temporary failure" }), {
              status: 503, headers: { "Content-Type": "application/json" },
            });
          }
        }
        return worker.fetch(new Request(new URL(p, HOST), init), {}, {});
      };
    },
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const click = (el) => { assert.ok(el); el.click(); };
  t.after(() => dom.window.close());

  await waitFor(() => $("#meta").textContent.includes("3 of 3"), "table renders");
  assert.deepEqual(errors, [], "inline script parses and runs");
  assert.equal(window.getComputedStyle($("#shared-modal")).display, "none", "dialog is hidden on load");
  assert.ok($("#find-shared"), "global button exists above the table");
  assert.equal(doc.querySelectorAll('[data-a="shared-users"]').length, 3, "one button per real customer row");

  // Search/filter independence: hide two rows in the table, the scan still covers everyone.
  $("#filter").value = "shared";
  $("#filter").dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll("#rows tr").length === 1, "filter applied");
  click($("#find-shared"));
  assert.equal($("#shared-modal").hidden, false);
  await waitFor(() => $("#shared-body").textContent.includes("Ali"), "global report renders");
  assert.ok($("#shared-body").textContent.includes(evilName), "evil customer name is shown as text");
  assert.match($("#shared-body").textContent, /1 supplier subscription/);
  assert.match($("#shared-body").textContent, /renewed together/);
  assert.ok($("#shared-body").textContent.includes(SHARED_USERS_NOTE), "required scope explanation shown");
  // Escaping: the evil customer name is text, not an injected element.
  assert.equal($("#shared-body").querySelectorAll("img").length, 0);
  assert.ok($("#shared-body").innerHTML.includes("&lt;img"));
  assert.ok($("#shared-body").innerHTML.includes("Acct &lt;b&gt;01&lt;/b&gt;"));
  $("#shared-done").click();
  assert.equal($("#shared-modal").hidden, true);

  // Per-customer view: selection highlight and the OTHER-active count.
  $("#filter").value = "all";
  $("#filter").dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => doc.querySelectorAll("#rows tr").length === 3, "filter cleared");
  const boButton = doc.querySelector(`[data-a="shared-users"][data-t="${b.token}"]`);
  click(boButton);
  await waitFor(() => $("#shared-title").textContent === "Find shared users", "per-customer title");
  await waitFor(() => $("#shared-body").textContent.includes("1 other active customer record"), "other-count sentence");
  const selected = $("#shared-body .shared-selected");
  assert.ok(selected && selected.textContent.includes(evilName));
  $("#shared-close").click();
  assert.equal($("#shared-modal").hidden, true);

  // Unique customer shows the exact empty state wording.
  click(doc.querySelector(`[data-a="shared-users"][data-t="${c.token}"]`));
  await waitFor(() => $("#shared-body").textContent.includes("No other active customer records found"), "unique state");
  assert.equal($("#shared-body .shared-selected").textContent.includes("Solo"), true);

  // Error + retry keeps the same selected customer.
  failNext = true;
  $("#shared-close").click();
  click(doc.querySelector(`[data-a="shared-users"][data-t="${c.token}"]`));
  await waitFor(() => $("#shared-retry"), "error state with retry");
  assert.match($("#shared-body").textContent, /Could not run/);
  click($("#shared-retry"));
  await waitFor(() => $("#shared-body").textContent.includes("No other active customer records found"), "retry succeeds");
  assert.equal($("#shared-title").textContent, "Find shared users", "retry kept the selected customer");

  // Stale reply: close before the response arrives, then resolve it — nothing renders.
  let resolveStall;
  stall = { promise: new Promise((res) => { resolveStall = res; }) };
  $("#shared-close").click();
  click(doc.querySelector(`[data-a="shared-users"][data-t="${a.token}"]`));
  await waitFor(() => $("#shared-body").textContent.includes("Scanning"), "loading state");
  const opener = doc.querySelector(`[data-a="shared-users"][data-t="${a.token}"]`);
  $("#shared-done").click();
  assert.equal($("#shared-modal").hidden, true);
  resolveStall(new Response(JSON.stringify({ note: "STALE" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal($("#shared-modal").hidden, true, "a late reply cannot reopen the dialog");
  assert.ok(!$("#shared-body").textContent.includes("STALE"), "stale reply is ignored");
  stall = null;

  // Reopen works after a stale exchange; Escape closes and focus returns to the opener.
  click(opener);
  await waitFor(() => $("#shared-body").textContent.includes("1 other active customer record"), "fresh scan works");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal($("#shared-modal").hidden, true);
  await waitFor(() => doc.activeElement === opener, "focus restored to the opening button");
  assert.deepEqual(errors, [], "no client-side exceptions");
});

test("10. Pay still changes exactly one customer and Check still never records a payment", async () => {
  await reset();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "STATUS=↑:1GB,↓:3GB,TOT:200GB Expires:" + day(35) +
    "\nvless://11111111-1111-4111-8111-111111111111@hk.example.com:443?type=tcp#n");
  const a = await mint({ link: SUP, customer: "Ali", supplier_account: "Acct 01" });
  const b = await mint({ link: a.oneLink, customer: "Bo", customer_type: "shared" });

  const check = await (await get(`/admin/link/${a.token}?action=check`)).json();
  assert.equal(check.marked_paid, false);
  assert.equal((await store.backend().get(a.token)).paid_until, undefined);
  assert.equal((await store.backend().get(b.token)).paid_until, undefined);

  const pay = await (await post(`/admin/link/${b.token}?action=pay`, { paid_until: day(20) })).json();
  assert.equal(pay.ok, true);
  assert.equal((await store.backend().get(b.token)).paid_until, day(20));
  assert.equal((await store.backend().get(a.token)).paid_until, undefined, "the other shared customer stays unpaid");

  // The finder still works alongside the billing actions.
  const report = await jget("/admin/shared-users");
  assert.equal(report.body.groups[0].active_count, 2);
  assert.deepEqual(report.body.groups[0].active.map((m) => m.paid_state).sort(), ["paid", "unpaid"]);
  globalThis.fetch = realFetch;
});
