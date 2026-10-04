// Billing status: renewing a customer into the future marks them paid, and
// "Mark paid" / "Mark unpaid" flip it by hand.
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import { paidThroughOnRenewal } from "../renewal.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✅ " : "  ❌ ") + m); if (!c) fail++; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const HOST = "https://sp.example.com";
const get = (p) => worker.fetch(new Request(HOST + p), {}, {});
const jget = async (p) => JSON.parse(await (await get(p)).text());

console.log("\n[1] paidThroughOnRenewal() — when a renewal counts as payment");
{
  const now = new Date("2026-10-04T00:00:00Z");
  ok(paidThroughOnRenewal({ previousExpiry: day(-5), newExpiry: "2026-11-04", paidUntil: null, now }) === "2026-11-04",
    "expiry jumps into the future -> paid through the new expiry");
  ok(paidThroughOnRenewal({ previousExpiry: "2026-11-04", newExpiry: "2026-11-04", paidUntil: null, now }) === null,
    "expiry unchanged -> no payment inferred");
  ok(paidThroughOnRenewal({ previousExpiry: "2026-09-01", newExpiry: "2026-09-20", paidUntil: null, now }) === null,
    "expiry still in the past -> not a renewal");
  ok(paidThroughOnRenewal({ previousExpiry: "2026-10-10", newExpiry: "2026-11-04", paidUntil: "2027-01-01", now }) === null,
    "a longer manual paid_until is never shortened");
  ok(paidThroughOnRenewal({ previousExpiry: null, newExpiry: "2026-11-04", paidUntil: null, now }) === "2026-11-04",
    "first ever check with a future expiry -> paid");
}

console.log("\n[2] Renew / Check marks the customer paid");
{
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  const SUP = "https://panel.example.com/api/v1/client/subscribe?token=abc";
  globalThis.fetch = async () => new Response(
    "STATUS=↑:1GB,↓:9GB,TOT:512GB Expires:" + day(30) + "\nvless://11111111-1111-4111-8111-111111111111@h:443?type=tcp#n");

  const token = await store.mint(SUP, "Ali", { customer: "Ali", paid_until: day(-6), billing_cycle: "monthly" });
  const before = (await store.listAll()).find((r) => r.token === token);
  ok(before.paid_until === day(-6), "starts overdue (paid_until in the past)");

  const j = await jget("/admin/link/" + token + "?action=renew");
  ok(j.ok === true, "renew/check succeeded");
  ok(j.expiry_changed === true, "expiry moved forward");
  ok(j.marked_paid === true, "response reports the customer was marked paid");
  ok(j.paid_until === day(30), "paid_until now matches the new expiry (" + j.paid_until + ")");
  ok(j.customer.paid_until === day(30), "the row returned to the table carries it too");

  const second = await jget("/admin/link/" + token + "?action=renew");
  ok(second.marked_paid === false, "re-checking an unchanged expiry does not re-mark");
}

console.log("\n[3] Manual Mark paid / Mark unpaid");
{
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  globalThis.fetch = async () => new Response("STATUS=↑:0GB,↓:0GB,TOT:512GB Expires:" + day(20) + "\nvless://a@h:443#n");

  const t = await store.mint("https://panel.example.com/sub?token=z", "Bea", { customer: "Bea", supplier_expires: day(20), billing_cycle: "monthly" });
  let j = await jget("/admin/link/" + t + "?action=paid");
  ok(j.ok === true && j.paid === true, "mark paid succeeds");
  ok(j.paid_until === day(20), "defaults to the supplier expiry (" + j.paid_until + ")");

  j = await jget("/admin/link/" + t + "?action=unpaid");
  ok(j.paid === false && j.paid_until === null, "mark unpaid clears the date");

  j = await jget("/admin/link/" + t + "?action=paid&until=2027-03-01");
  ok(j.paid_until === "2027-03-01", "an explicit until= date is honoured");

  // no usable expiry -> fall forward by the billing cycle
  const t2 = await store.mint("https://panel.example.com/sub?token=y", "Cy", { customer: "Cy", supplier_expires: day(-40), billing_cycle: "quarterly" });
  j = await jget("/admin/link/" + t2 + "?action=paid");
  ok(j.paid_until === day(91), "expired customer paying again -> one billing cycle out (" + j.paid_until + ")");

  const bad = await get("/admin/link/nope-not-a-token?action=paid");
  ok(bad.status === 404, "unknown token -> 404");
}

console.log("\n" + "─".repeat(70));
console.log(fail ? "❌ " + fail + " CHECK(S) FAILED" : "🎉 ALL PAID-STATUS CHECKS PASSED");
process.exit(fail ? 1 : 0);
