// Regression coverage for independent payments on a shared supplier account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import worker, { fetchSubscription, quotaSummary } from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import { supplierAccounts, supplierKey, validPaidUntil } from "../customer-accounts.js";
import { dueReminders, runReminders } from "../reminders.js";

const HOST = "https://sp.example.com";
const SUPPLIER = "https://panel.example/sub/account-one?token=PRIVATE-SUPPLIER-SECRET";
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const get = (path) => worker.fetch(new Request(HOST + path), {}, {});
const post = (path, data) => worker.fetch(new Request(HOST + path, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
}), {}, {});
const jsonOK = async (response) => {
  const r = await response;
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
};
const mint = (data) => jsonOK(post("/admin/mint", data));
const dashboard = () => jsonOK(get("/admin/dashboard.json"));
const pay = (token, date = day(30)) => jsonOK(post(`/admin/link/${token}?action=pay`, { paid_until: date }));
async function reset() {
  store.setBackend(new store.MemoryBackend());
  store.clearCache();
  await store.ensureInit();
}

function supplierMock(t) {
  const original = globalThis.fetch;
  const state = { expiry: day(-2), used: 10, calls: 0, failing: false };
  globalThis.fetch = async () => {
    state.calls++;
    if (state.failing) return new Response("supplier unavailable", { status: 503 });
    return new Response([
      `STATUS=↑:0GB,↓:${state.used}GB,TOT:200GB Expires:${state.expiry}`,
      "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=reality&sni=a.com&pbk=X%3D&type=tcp#HongKong",
    ].join("\n"));
  };
  t.after(() => { globalThis.fetch = original; });
  return state;
}

test("second and third customers inherit the first customer's supplier account, not her payment", async (t) => {
  await reset();
  const supplier = supplierMock(t);
  const first = await mint({
    link: SUPPLIER, customer: "Aisha", customer_type: "individual", supplier_account: "Supplier account 01",
  });
  await pay(first.token);
  const lookup = await jsonOK(post("/admin/shared-link", { link: first.oneLink }));
  assert.equal(lookup.account.name, "Supplier account 01");
  assert.equal(lookup.account.id, first.token);
  assert.equal(lookup.account.host, "panel.example");
  assert.equal(lookup.account.customers, 1);
  assert.ok(!JSON.stringify(lookup).includes("PRIVATE-SUPPLIER-SECRET"));

  const second = await mint({
    link: first.oneLink + "&fmt=yaml", customer: "Bella", customer_type: "shared",
    supplier_account: "A stale or tampered form value must not win",
  });
  const third = await mint({ link: second.oneLink, customer: "Chloe", customer_type: "shared" });
  assert.equal(supplier.calls, 0, "link lookup, sharing and payment never contact the supplier");
  assert.notEqual(first.token, second.token, "each person has a separate record and revocable alias");
  assert.notEqual(second.token, third.token);
  const raw = await store.listAll();
  assert.equal(new Set(raw.map((r) => r.supplier_url)).size, 1);
  assert.equal(raw.find((r) => r.token === second.token).supplier_url, SUPPLIER, "no nested self-fetching link");

  const d = await dashboard();
  assert.equal(d.stats.active, 3);
  assert.equal(d.stats.unpaid, 2);
  assert.equal(d.customers.find((r) => r.token === first.token).customer_type, "individual");
  for (const token of [second.token, third.token]) {
    const r = d.customers.find((r) => r.token === token);
    assert.equal(r.customer_type, "shared");
    assert.equal(r.paid_until, null);
    assert.equal(r.supplier_account.name, "Supplier account 01");
    assert.equal(r.supplier_account.id, first.token);
    assert.equal(r.supplier_account.customers, 3);
  }
  const profile = await get(`/all/SP%20VPN?t=${second.token}&fmt=yaml`);
  assert.equal(profile.status, 200);
  assert.match(await profile.text(), /hk\.example\.com/, "the new shared alias serves the original supplier's VPN");
  for (const path of ["/admin/dashboard.json", "/admin/links"]) {
    const body = await (await get(path)).text();
    assert.ok(!body.includes("supplier_url"));
    assert.ok(!body.includes("PRIVATE-SUPPLIER-SECRET"));
  }
});

test("checks, bulk refresh and reminder refresh never mark shared customers as paid", async (t) => {
  await reset();
  const supplier = supplierMock(t);
  const first = await mint({ link: SUPPLIER, customer: "Aisha", supplier_account: "Account 01" });
  const second = await mint({ link: first.oneLink, customer: "Bella", customer_type: "shared" });
  const third = await mint({ link: SUPPLIER, customer: "Chloe", customer_type: "shared" });
  // Historical customer payments, independent of the supplier's expiry.
  for (const { token } of [first, second, third]) {
    await store.updateRow(token, { paid_until: day(-1), supplier_expires: day(-2) });
  }
  supplier.expiry = day(60);
  supplier.used = 2;
  const checked = await jsonOK(get(`/admin/link/${first.token}?action=check`));
  assert.equal(checked.expiryChanged, true);
  assert.equal(checked.customer.supplier_expires, day(60));
  assert.equal(checked.customer.paid_until, day(-1));
  assert.equal((await dashboard()).stats.unpaid, 3);

  await jsonOK(get(`/admin/link/${second.token}?action=renew`)); // old clients' alias is still a check
  await jsonOK(get("/admin/refresh"));
  let d = await dashboard();
  assert.ok(d.customers.every((r) => r.supplier_expires === day(60)));
  assert.ok(d.customers.every((r) => r.paid_until === day(-1)));

  const calls = supplier.calls;
  await pay(second.token, day(20));
  assert.equal(supplier.calls, calls, "Pay never fetches or renews the supplier");
  d = await dashboard();
  assert.equal(d.stats.unpaid, 2);
  assert.equal(d.customers.find((r) => r.token === second.token).paid_until, day(20));
  assert.equal(d.customers.find((r) => r.token === first.token).paid_until, day(-1));
  assert.equal(d.customers.find((r) => r.token === third.token).paid_until, day(-1));
  assert.equal(dueReminders(await store.listAll()).filter((r) => r.kind === "unpaid").length, 2);

  supplier.expiry = day(90);
  const reminderPass = await runReminders({
    listAll: store.listAll, updateRow: store.updateRow,
    hasBeenSent: store.hasBeenSent, markSent: store.markSent,
    fetchSubscription, quotaSummary, channel: { async send() {} },
  });
  assert.equal(reminderPass.refreshed, 3);
  assert.deepEqual(reminderPass.sent.filter((r) => r.kind === "unpaid").map((r) => r.token).sort(), [first.token, third.token].sort());
  d = await dashboard();
  assert.equal(d.stats.unpaid, 2);
  assert.equal(d.customers.find((r) => r.token === second.token).paid_until, day(20));
  assert.ok(d.customers.every((r) => r.supplier_expires === day(90)));

  supplier.failing = true;
  const beforeFailure = await store.backend().get(first.token);
  assert.equal((await get(`/admin/link/${first.token}?action=check`)).status, 502);
  assert.deepEqual(await store.backend().get(first.token), beforeFailure, "a failed check changes neither expiry nor payment");
  await pay(third.token, day(35)); // can still record an actual payment when the supplier is down
  assert.equal((await dashboard()).stats.unpaid, 1);
});

test("shared account matching uses the complete supplier link and validates the source", async () => {
  await reset();
  const a = await mint({ link: SUPPLIER, customer: "A", supplier_account: "Account A" });
  const b = await mint({ link: SUPPLIER.replace("account-one", "account-two"), customer: "B", supplier_account: "Account B" });
  assert.equal((await jsonOK(post("/admin/shared-link", { link: SUPPLIER }))).account.name, "Account A");
  assert.equal((await jsonOK(post("/admin/shared-link", { link: b.oneLink }))).account.name, "Account B");
  const accounts = (await dashboard()).customers.map((r) => r.supplier_account.id);
  assert.equal(new Set(accounts).size, 2, "same supplier host is not the same supplier account");
  for (const link of ["bad link", "", "javascript:alert(1)", HOST + "/admin", "https://panel.example/sub/unregistered"]) {
    const r = await post("/admin/mint", { link, customer_type: "shared" });
    assert.equal(r.status, 400, link);
    assert.ok((await r.json()).error);
  }
  assert.equal((await post("/admin/mint", { link: a.oneLink, customer_type: "individual" })).status, 400);
  assert.equal((await post("/admin/mint", { link: SUPPLIER, customer_type: "invalid" })).status, 400);
  assert.equal((await post("/admin/shared-link", { link: HOST + "/all/SP%20VPN?t=" + "0".repeat(48) })).status, 404);
  for (const path of ["/q/", "/sub/", "/share/"]) {
    const result = await jsonOK(post("/admin/shared-link", { link: HOST + path + a.token }));
    assert.equal(result.account.name, "Account A");
  }
  await jsonOK(get(`/admin/link/${a.token}?action=revoke`));
  assert.equal((await post("/admin/shared-link", { link: a.oneLink })).status, 400);
  assert.equal((await post("/admin/mint", { link: a.oneLink, customer_type: "shared" })).status, 400);
});

test("Pay is explicit, per customer, validated and idempotent", async () => {
  await reset();
  const { token } = await mint({ link: SUPPLIER, customer: "A" });
  const initial = await store.backend().get(token);
  const path = `/admin/link/${token}?action=pay`;
  const noGet = await get(path + "&paid_until=" + day(30));
  assert.equal(noGet.status, 405);
  assert.equal(noGet.headers.get("Allow"), "POST");
  for (const date of ["", day(-1), "2030-02-30", "2030-13-01", "2030-01-01T00:00:00Z", "2030-1-1", "not-a-date"]) {
    const r = await post(path, { paid_until: date });
    assert.equal(r.status, 400, date);
    assert.ok((await r.json()).error);
  }
  assert.deepEqual(await store.backend().get(token), initial, "failed and GET requests cannot mark a payment");
  assert.equal((await post("/admin/customer", { token, paid_until: day(60) })).status, 400);
  assert.equal((await post("/admin/mint", { link: SUPPLIER, paid_until: day(60) })).status, 400);
  await pay(token, day(0));
  const paid = await store.backend().get(token);
  await pay(token, day(0));
  assert.deepEqual(await store.backend().get(token), paid, "double clicks cannot extend a billing cycle twice");
  assert.equal((await dashboard()).stats.unpaid, 0, "paid through today counts as paid");
  assert.equal((await post(`/admin/link/${"0".repeat(48)}?action=pay`, { paid_until: day(30) })).status, 404);
  await store.updateRow(token, { revoked: true });
  assert.equal((await post(path, { paid_until: day(30) })).status, 400);
  assert.equal((await store.backend().get(token)).paid_until, day(0));
  assert.ok(validPaidUntil("2032-02-29", new Date("2032-02-01")));
  assert.ok(!validPaidUntil("2031-02-29", new Date("2031-02-01")));
});

test("editing, rotation and deleting the original record preserve the shared association and independent payments", async () => {
  await reset();
  const first = await mint({ link: SUPPLIER, customer: "Aisha", supplier_account: "Account 01" });
  const second = await mint({ link: first.oneLink, customer: "Bella", customer_type: "shared" });
  await pay(second.token);
  await jsonOK(post("/admin/customer", { token: first.token, supplier_account: "Account renamed", customer: "Aisha A" }));
  let d = await dashboard();
  assert.ok(d.customers.every((r) => r.supplier_account.name === "Account renamed"));
  assert.equal(d.stats.unpaid, 1);
  await jsonOK(post("/admin/customer", { token: second.token, customer_type: "shared", supplier_account: "Wrong account" }));
  assert.ok((await dashboard()).customers.every((r) => r.supplier_account.name === "Account renamed"));

  const rotation = await jsonOK(get(`/admin/link/${second.token}?action=rotate`));
  const fresh = (await dashboard()).customers.find((r) => r.token === rotation.newToken);
  assert.equal(fresh.customer_type, "shared");
  assert.equal(fresh.paid_until, day(30));
  assert.equal(fresh.supplier_account.name, "Account renamed");
  assert.equal(await store.resolve(second.token), null);
  assert.equal(await store.resolve(rotation.newToken), SUPPLIER);
  assert.equal(await store.resolve(first.token), SUPPLIER, "rotating one shared customer does not revoke the others");

  await jsonOK(get(`/admin/link/${first.token}?action=delete`));
  const surviving = (await dashboard()).customers.find((r) => r.token === rotation.newToken);
  assert.equal(surviving.supplier_account.name, "Account renamed");
  assert.equal(surviving.paid_until, day(30));
  assert.equal(await store.resolve(rotation.newToken), SUPPLIER, "shared links don't depend on the original token remaining alive");
});

// Run the D1 backend against real SQLite via a small binding adapter, so both
// deployed SQL update implementations are checked (not just the memory store).
function d1Binding(db) {
  return { prepare(sql) {
    let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async run() { const r = await db.execute({ sql, args }); return { meta: { changes: r.rowsAffected } }; },
      async all() { return { results: (await db.execute({ sql, args })).rows }; },
      async first() { return (await db.execute({ sql, args })).rows[0] || null; },
    };
    return statement;
  } };
}

for (const kind of ["libsql", "d1"]) {
  test(`${kind}: additive migration, persistence and concurrent payment/refresh isolation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sp-vpn-accounts-"));
    const url = "file:" + join(directory, "tokens.db");
    const db = createClient({ url });
    let backend;
    try {
      const oldDDL = store.LINKS_DDL
        .replace("  customer_type    TEXT NOT NULL DEFAULT 'individual',\n", "")
        .replace("  supplier_account TEXT,\n", "");
      await db.execute(oldDDL);
      const old = store.newToken();
      await db.execute({
        sql: "INSERT INTO links (token, supplier_url, customer, created_at, paid_until) VALUES (?, ?, ?, ?, ?)",
        args: [old, SUPPLIER, "Existing customer", new Date().toISOString(), day(15)],
      });
      backend = kind === "libsql" ? new store.LibsqlBackend({ url }) : new store.D1Backend(d1Binding(db));
      await backend.init();
      const row = await backend.get(old);
      assert.equal(row.customer_type, "individual");
      assert.equal(row.supplier_account, null);
      assert.equal(row.paid_until, day(15), "existing manually entered payments survive migration");
      await backend.update(old, { supplier_account: "Persisted account" });
      const shared = store.newToken();
      await backend.put({
        token: shared, supplier_url: SUPPLIER, label: "Second", customer: "Second", revoked: false,
        created_at: new Date().toISOString(), customer_type: "shared", supplier_account: "Persisted account",
      });
      await Promise.all([
        backend.update(shared, { supplier_expires: day(60), used_gb: 4 }),
        backend.update(shared, { paid_until: day(30) }),
        backend.update(shared, { notes: "Concurrent edit" }),
      ]);
      const stored = await backend.get(shared);
      assert.equal(stored.paid_until, day(30));
      assert.equal(stored.supplier_expires, day(60));
      assert.equal(stored.used_gb, 4);
      assert.equal(stored.notes, "Concurrent edit");
      assert.equal(stored.customer_type, "shared");
      assert.equal((await backend.get(old)).paid_until, day(15));
      assert.equal(supplierAccounts(await backend.list()).get(supplierKey(SUPPLIER)).name, "Persisted account");
      assert.equal(await backend.update("missing", { paid_until: day(30) }), null);
      if (kind === "libsql") {
        backend.db.close();
        backend = new store.LibsqlBackend({ url });
        await backend.init();
        assert.equal((await backend.get(shared)).paid_until, day(30), "payment survives a backend restart");
        assert.equal((await backend.get(shared)).supplier_account, "Persisted account");
        assert.equal((await backend.get(shared)).customer_type, "shared");
      }
    } finally {
      if (kind === "libsql") backend?.db.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Worker requests use the supplied D1 binding for persistent customer/account/payment fields", async (t) => {
  const db = createClient({ url: "file::memory:" });
  const env = { DB: d1Binding(db) };
  // Remove the test override so the worker must choose the runtime backend.
  store.setBackend(undefined);
  t.after(() => { store.setBackend(new store.MemoryBackend()); db.close(); });
  const request = (path, data) => worker.fetch(new Request(HOST + path, {
    method: "POST", body: new URLSearchParams(data).toString(),
  }), env, {});
  const first = await jsonOK(request("/admin/mint", {
    link: SUPPLIER, customer: "Runtime original", supplier_account: "D1 account",
  }));
  const second = await jsonOK(request("/admin/mint", {
    link: first.oneLink, customer: "Runtime shared", customer_type: "shared",
  }));
  await jsonOK(request(`/admin/link/${second.token}?action=pay`, { paid_until: day(30) }));
  assert.equal(store.backend().name, "d1");
  const rows = (await db.execute("SELECT customer, customer_type, supplier_account, paid_until FROM links")).rows;
  assert.equal(rows.length, 2);
  const shared = rows.find((r) => r.customer === "Runtime shared");
  assert.equal(shared.customer_type, "shared");
  assert.equal(shared.supplier_account, "D1 account");
  assert.equal(shared.paid_until, day(30));
  assert.equal(rows.find((r) => r.customer === "Runtime original").paid_until, null);
});

test("existing panel-account email and password are inherited without re-entering them", async () => {
  await reset();
  await store.mint(SUPPLIER, "quota-page"); // anonymous checks aren't account owners
  const first = await mint({
    link: SUPPLIER, customer: "Original customer", account_email: "supplier01@example.test",
    account_password: "test-only-account-password",
  });
  const preview = await jsonOK(post("/admin/shared-link", { link: first.oneLink }));
  assert.equal(preview.account.name, "supplier01@example.test");
  assert.equal(preview.account.email, "supplier01@example.test");
  assert.equal(preview.account.id, first.token, "anonymous quota checks cannot own the supplier account");
  assert.equal(preview.account.customers, 1);
  assert.ok(!JSON.stringify(preview).includes("test-only-account-password"));
  const second = await mint({
    link: first.oneLink, customer: "Shared customer", customer_type: "shared",
    account_email: "wrong@example.test", account_password: "ignore stale form values",
  });
  const row = await store.backend().get(second.token);
  assert.equal(row.account_email, "supplier01@example.test");
  assert.equal(row.account_password, "test-only-account-password");
  assert.equal(row.paid_until, undefined);
  await jsonOK(post("/admin/customer", { token: first.token, account_email: "renamed@example.test" }));
  await jsonOK(get(`/admin/link/${first.token}?action=delete`));
  const surviving = await jsonOK(post("/admin/shared-link", { link: second.oneLink }));
  assert.equal(surviving.account.name, "renamed@example.test");
  assert.equal(surviving.account.email, "renamed@example.test");
});
