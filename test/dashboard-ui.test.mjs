// Execute the actual inline dashboard script against a DOM and the real worker.
// This catches broken inline JS, form wiring and accidental payment side effects
// that HTML substring checks cannot detect. No browser/CDN/network is required.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";

const HOST = "https://preview.example.com";
const SUPPLIER = "https://supplier.example/api/subscribe?token=PRIVATE-ACCOUNT";
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
async function waitFor(check, message) {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) assert.fail("Timed out: " + message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("dashboard: add original, inherit shared account, Check without paying, then Pay one person", async (t) => {
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  const realFetch = globalThis.fetch;
  let expiry = day(35), failPay = false;
  globalThis.fetch = async () => new Response([
    `STATUS=↑:1GB,↓:3GB,TOT:200GB Expires:${expiry}`,
    "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=reality&sni=a.com&pbk=X%3D&type=tcp#HongKong",
  ].join("\n"));
  t.after(() => { globalThis.fetch = realFetch; });

  const html = await (await worker.fetch(new Request(HOST + "/admin"), {}, {})).text();
  const errors = [], calls = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: HOST + "/admin", runScripts: "dangerously", virtualConsole: console,
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = async (path, init = {}) => {
        calls.push({ path, method: init.method || "GET", body: init.body || "" });
        assert.ok(String(path).startsWith("/"), "browser requests must be relative, never localhost");
        if (failPay && String(path).includes("action=pay")) {
          return new Response(JSON.stringify({ error: "Payment could not be saved. Try again." }), {
            status: 503, headers: { "Content-Type": "application/json" },
          });
        }
        return worker.fetch(new Request(new URL(path, HOST), init), {}, {});
      };
    },
  });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const click = (s) => { assert.ok($(s), s); $(s).click(); };
  const change = (field, value) => { field.value = value; field.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const input = (field, value) => { field.value = value; field.dispatchEvent(new window.Event("input", { bubbles: true })); };
  const rowFor = (token) => $(`[data-a="pay"][data-t="${token}"]`)?.closest("tr");
  const paymentPill = (token) => rowFor(token)?.querySelector(".paid-cell .pill")?.textContent;
  const payRequests = () => calls.filter((c) => c.path.includes("action=pay"));

  await waitFor(() => $("#meta").textContent.includes("0 of 0"), "initial render");
  assert.deepEqual(errors, [], "inline script executes, rather than being HTML-escaped");
  assert.equal(window.getComputedStyle($("#modal")).display, "none", "hidden dialogs do not cover the dashboard");
  assert.equal(window.getComputedStyle($("#pay-modal")).display, "none");

  click("#add");
  const f = $("#form").elements;
  assert.equal(f.customer_type.value, "individual");
  assert.equal(f.supplier_account.readOnly, false);
  assert.equal(f.namedItem("paid_until"), null, "customer Save cannot record a payment");
  input(f.link, SUPPLIER);
  input(f.customer, "Aisha");
  input(f.supplier_account, "Supplier account 01");
  input(f.account_email, "supplier01@example.test");
  input(f.account_password, "test-only-panel-password");
  click("#save");
  await waitFor(() => $("#meta").textContent.includes("1 of 1"), "original customer created");
  const first = (await store.listAll()).find((r) => r.customer === "Aisha");
  assert.ok(first);
  assert.equal(first.supplier_account, "Supplier account 01");
  assert.equal(paymentPill(first.token), "Unpaid");
  assert.equal(first.paid_until, undefined);
  click("#cancel");

  click("#add");
  change(f.customer_type, "shared");
  assert.equal(f.supplier_account.readOnly, true);
  assert.equal($("#shared-account").hidden, false);
  input(f.link, HOST + "/all/SP%20VPN?t=" + first.token);
  input(f.customer, "Bella");
  await waitFor(() => f.supplier_account.value === "Supplier account 01", "shared-account lookup");
  assert.match($("#shared-account").textContent, /currently used by 1/);
  assert.equal(f.account_email.value, "supplier01@example.test");
  assert.equal(f.account_email.readOnly, true);
  assert.equal(f.account_password.value, "", "lookup never returns the supplier password");
  click("#save");
  await waitFor(() => $("#meta").textContent.includes("2 of 2"), "shared customer created");
  const second = (await store.listAll()).find((r) => r.customer === "Bella");
  assert.equal(second.customer_type, "shared");
  assert.equal(second.supplier_url, first.supplier_url);
  assert.equal(second.supplier_account, "Supplier account 01");
  assert.equal(second.account_email, first.account_email);
  assert.equal(second.account_password, first.account_password);
  assert.notEqual(first.token, second.token);
  assert.match(rowFor(second.token).querySelector(".customer-cell").textContent, /Shared link/);
  assert.match(rowFor(second.token).querySelector(".supplier-account").textContent, /Supplier account 01/);
  assert.equal(paymentPill(second.token), "Unpaid");
  click("#cancel");

  click(`[data-a="check"][data-t="${first.token}"]`);
  await waitFor(() => rowFor(first.token).querySelector(".renewal-cell").textContent.includes("35d left"), "single check");
  assert.equal(paymentPill(first.token), "Unpaid");
  assert.equal(paymentPill(second.token), "Unpaid");
  assert.match($("#toast").textContent, /Payment unchanged/);
  expiry = day(60);
  click("#refresh");
  await waitFor(() => rowFor(second.token).querySelector(".renewal-cell").textContent.includes("60d left"), "bulk refresh");
  assert.equal(paymentPill(first.token), "Unpaid");
  assert.equal(paymentPill(second.token), "Unpaid");
  assert.equal(payRequests().length, 0);

  click(`[data-a="pay"][data-t="${second.token}"]`);
  assert.match($("#pay-title").textContent, /Bella/);
  assert.equal($("#pay-modal").hidden, false);
  assert.equal($("#pay-form").elements.paid_until.value, expiry);
  click("#pay-cancel");
  assert.equal(payRequests().length, 0, "opening or cancelling Pay is not a payment");
  assert.equal(paymentPill(second.token), "Unpaid");

  click(`[data-a="pay"][data-t="${second.token}"]`);
  $("#pay-form").elements.paid_until.value = day(20);
  click("#pay-save");
  await waitFor(() => paymentPill(second.token) === "Paid", "explicit payment");
  assert.equal(paymentPill(first.token), "Unpaid");
  assert.equal($("#pay-modal").hidden, true);
  assert.equal(payRequests().length, 1);
  assert.equal(payRequests()[0].method, "POST");
  assert.equal(new URLSearchParams(payRequests()[0].body).get("paid_until"), day(20));
  assert.equal((await store.backend().get(first.token)).paid_until, undefined);

  failPay = true;
  click(`[data-a="pay"][data-t="${first.token}"]`);
  click("#pay-save");
  await waitFor(() => $("#pay-result").textContent.includes("Try again"), "payment error");
  assert.equal($("#pay-modal").hidden, false);
  assert.equal($("#pay-save").disabled, false);
  assert.equal(paymentPill(first.token), "Unpaid");
  failPay = false;
  click("#pay-save");
  await waitFor(() => paymentPill(first.token) === "Paid", "payment retry");
  assert.equal((await store.backend().get(second.token)).paid_until, day(20));
  click(`[data-a="unpaid"][data-t="${first.token}"]`);
  await waitFor(() => paymentPill(first.token) === "Unpaid", "explicit unpaid correction");
  assert.equal(paymentPill(second.token), "Paid");
  assert.equal(calls.find((c) => c.path.includes("action=unpaid")).method, "POST");
  click(`[data-a="pay"][data-t="${first.token}"]`);
  click("#pay-save");
  await waitFor(() => paymentPill(first.token) === "Paid", "record corrected payment");

  change($("#filter"), "shared");
  assert.match($("#meta").textContent, /1 of 2/);
  assert.equal($("#rows").rows.length, 1);
  assert.match($("#rows").textContent, /Bella/);
  change($("#filter"), "all");
  input($("#q"), "Supplier account 01");
  assert.match($("#meta").textContent, /2 of 2/);
  input($("#q"), "");

  click(`[data-a="edit"][data-t="${first.token}"]`);
  assert.equal(f.link.disabled, true, "editing cannot accidentally overwrite the supplier link");
  assert.equal(f.supplier_account.readOnly, false);
  input(f.supplier_account, "New <img src=x onerror=alert(1)> account");
  click("#save");
  await waitFor(() => rowFor(second.token).querySelector(".supplier-account").textContent.includes("New <img"), "account rename");
  click("#cancel");
  for (const token of [first.token, second.token]) {
    assert.match(rowFor(token).querySelector(".supplier-account").textContent, /New <img/);
    assert.equal(rowFor(token).querySelector(".supplier-account").querySelector("img"), null, "account labels are escaped");
    assert.equal(paymentPill(token), "Paid", "account edits do not alter payments");
  }
  click(`[data-a="edit"][data-t="${second.token}"]`);
  assert.equal(f.supplier_account.readOnly, true);
  assert.match(f.supplier_account.value, /New <img/);
  click("#cancel");

  click("#add");
  change(f.customer_type, "shared");
  input(f.link, HOST + "/all/SP%20VPN?t=" + "0".repeat(48));
  await waitFor(() => $("#shared-account").textContent.includes("not registered"), "unknown shared-link warning");
  assert.equal(f.supplier_account.value, "", "failed lookup cannot retain a stale account");
  input(f.customer, "Not created");
  click("#save");
  await waitFor(() => $("#result").textContent.includes("not registered"), "invalid source rejected on submit too");
  assert.equal((await store.listAll()).length, 2);
  assert.deepEqual(errors, [], "no client-side exceptions during the complete flow");
});
