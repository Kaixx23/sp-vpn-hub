// ============================================================================
// REMINDERS SUITE — the renewal maths, cron idempotency, and failure handling.
// Run: node test/reminders.test.mjs
// ============================================================================
import worker, { fetchSubscription, quotaSummary } from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import { daysUntil, dueReminders, makeChannel, messageFor, runReminders, runRemindersFromEnv } from "../reminders.js";
import { ADMIN_ENV, ADMIN_COOKIE } from "./admin-session.mjs";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

const enc = encodeURIComponent;
const TODAY = new Date(); // real now — a hardcoded date would rot silently
const day = (o) => new Date(TODAY.getTime() + o * 86400000).toISOString().slice(0, 10);

console.log("\n[1] daysUntil()");
{
  ok(daysUntil(day(0), TODAY) === 0, "today is 0 days");
  ok(daysUntil(day(7), TODAY) === 7, "+7d is 7");
  ok(daysUntil(day(-4), TODAY) === -4, "past date is negative");
  ok(daysUntil(null, TODAY) === null, "missing expiry is null, not 0");
  ok(daysUntil("not-a-date", TODAY) === null, "garbage expiry is null, not NaN");
}

console.log("\n[2] dueReminders() — what needs saying");
{
  const rows = [
    { token: "a", customer: "Ali", supplier_expires: day(52), paid_until: day(30) },   // healthy
    { token: "b", customer: "Bao", supplier_expires: day(5), paid_until: day(10) },    // ≤7d
    { token: "c", customer: "Chen", supplier_expires: day(-4), paid_until: day(-1) },  // expired + unpaid
    { token: "d", customer: "Devi", supplier_expires: null, paid_until: null },        // unknown
    { token: "e", customer: "Emil", supplier_expires: day(140), legacy: true },        // legacy
    { token: "f", customer: "Revoked", supplier_expires: day(-9), revoked: true },     // ignored
  ];
  const due = dueReminders(rows);
  const kinds = (t) => due.filter((x) => x.token === t).map((x) => x.kind);

  ok(kinds("a").length === 0, "healthy 52-day link gets nothing");
  ok(kinds("b").join() === "expiry_7", `5-day link fires the 7-day reminder (got ${kinds("b")})`);
  ok(kinds("c").includes("expired"), "expired link fires 'expired'");
  ok(kinds("c").includes("unpaid"), "expired link ALSO fires 'unpaid' — two separate problems");
  ok(!kinds("c").some((k) => k.startsWith("expiry_")), "expired link does not also fire a countdown");
  ok(kinds("d").join() === "unknown", "missing expiry fires 'unknown' rather than being skipped");
  ok(kinds("e").join() === "legacy", "legacy link is flagged for rotation");
  ok(kinds("f").length === 0, "revoked link is ignored entirely");
  ok(!kinds("c").includes("legacy"), "no spurious reminders");

  const exact = dueReminders([{ token: "x", supplier_expires: day(3) }]);
  ok(exact[0].kind === "expiry_3", `exact threshold hit picks expiry_3 (got ${exact[0].kind})`);
  const jump = dueReminders([{ token: "y", supplier_expires: day(2) }]);
  ok(jump.length === 1, `a link inside several thresholds fires exactly ONE reminder (got ${jump.length})`);
  ok(jump[0].kind === "expiry_3", `and it picks the TIGHTEST threshold crossed: 2 days left -> expiry_3 (got ${jump[0].kind})`);
}

console.log("\n[3] messageFor() — the text a human actually reads");
{
  const row = { customer: "Bao Nguyen", plan: "200GB / 1 month", price: 8, currency: "USD", paid_until: day(10), supplier_expires: day(5), total_gb: 200, used_gb: 184.4 };
  const m = messageFor("expiry_7", row, 5);
  ok(m.includes("Bao Nguyen"), "names the customer");
  ok(m.includes("5 days"), "states the real day count");
  ok(m.includes("USD 8.00"), "shows what they pay");
  ok(m.includes("15.6 / 200 GB left"), `shows quota (${(200 - 184.4).toFixed(1)} GB left)`);
  ok(messageFor("expired", { ...row, supplier_expires: day(-4) }, -4).includes("EXPIRED 4 days ago"), "expired says how long ago");
  ok(messageFor("unknown", { customer: "X" }, null).includes("Refresh quota"), "unknown tells you what to do about it");
}

console.log("\n[4] runReminders() — cron idempotency, the whole point");
{
  const enc2 = encodeURIComponent;
  const panel = (exp, up, down) => [
    `STATUS=↑:${up}GB,↓:${down}GB,TOT:200GB Expires:${exp}`,
    "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=a.com&fp=chrome&pbk=X%3D&sid=6a&type=tcp&flow=xtls-rprx-vision#" + enc2("香港•移联01"),
  ].join("\n");
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes("who=bao")) return new Response(panel(day(5), 88.1, 96.3));
    if (s.includes("who=chen")) return new Response(panel(day(-4), 3.2, 196.1));
    return new Response("nope", { status: 500 });
  };

  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  await store.mint("https://panel.example/sub?who=bao", "Bao", { customer: "Bao Nguyen", plan: "200GB / 1mo", price: 8, currency: "USD", paid_until: day(10) });
  await store.mint("https://panel.example/sub?who=chen", "Chen", { customer: "Chen Wei", plan: "200GB / 3mo", price: 15, currency: "USD", paid_until: day(-1) });

  const sent = [];
  const channel = { name: "capture", async send(text) { sent.push(text); } };
  const deps = {
    listAll: store.listAll, updateRow: store.updateRow,
    hasBeenSent: store.hasBeenSent, markSent: store.markSent,
    fetchSubscription: fetchSubscription, quotaSummary: quotaSummary,
    channel,
  };

  const r1 = await runReminders(deps);
  ok(r1.refreshed === 2, `refreshed both from the supplier (got ${r1.refreshed})`);
  ok(r1.sent.length === 3, `first pass sent 3: Bao expiry + Chen expired + Chen unpaid (got ${r1.sent.length}: ${r1.sent.map((x) => x.kind).join(", ")})`);
  ok(r1.sent.some((x) => x.kind === "expiry_7"), "Bao got the 7-day warning");
  ok(r1.sent.some((x) => x.kind === "expired"), "Chen got the expiry alert");
  ok(r1.sent.some((x) => x.kind === "unpaid"), "Chen got the payment alert");

  const r2 = await runReminders(deps);
  ok(r2.sent.length === 0, `second pass same day sent NOTHING (got ${r2.sent.length})`);
  ok(r2.skipped.length === 3, `and recorded 3 skips (got ${r2.skipped.length})`);

  const r3 = await runReminders(deps);
  ok(r3.sent.length === 0, "third pass still sends nothing — an hourly cron is safe");
  ok(sent.length === 3, `channel received exactly 3 messages total (got ${sent.length})`);

  // Next day: an expired subscription SHOULD nag again.
  const tomorrow = new Date(TODAY.getTime() + 86400000);
  const deps2 = { ...deps, now: tomorrow };
  const r4 = await runReminders(deps2);
  ok(r4.sent.length > 0, `next day it fires again (${r4.sent.length}) — renewals are not forgotten`);

  console.log("\n[5] history is queryable");
  {
    const hist = await store.listReminders();
    ok(hist.length > 0, `GET history returns ${hist.length} rows`);
    ok(hist[0].text && hist[0].text.length > 20, "history stores the message text, not just a flag");
    ok(hist[0].date && hist[0].kind, "history records kind + date");
  }
}

console.log("\n[6] a dead channel must not break the pass or lose the reminder");
{
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  const t = await store.mint("https://panel.example/sub?who=bao", "Bao", { customer: "Bao", supplier_expires: day(2) });
  const boom = { name: "broken", async send() { throw new Error("telegram HTTP 401: unauthorized"); } };
  const r = await runReminders({
    listAll: store.listAll, updateRow: store.updateRow,
    hasBeenSent: store.hasBeenSent, markSent: store.markSent,
    fetchSubscription: fetchSubscription, quotaSummary: quotaSummary,
    channel: boom, refresh: false,
  });
  ok(r.sent.length === 0 && r.failed.length === 1, `delivery failure recorded, not thrown (got ${JSON.stringify(r.failed[0]?.error || "").slice(0, 40)})`);
  ok(!(await store.hasBeenSent(t, "expiry_3", new Date().toISOString().slice(0, 10))), "NOT marked sent — the next run retries");

  const good = [];
  await runReminders({
    listAll: store.listAll, updateRow: store.updateRow,
    hasBeenSent: store.hasBeenSent, markSent: store.markSent,
    fetchSubscription: fetchSubscription, quotaSummary: quotaSummary,
    channel: { name: "ok", async send(x) { good.push(x); } }, refresh: false,
  });
  ok(good.length === 1, "once the channel recovers, the reminder is delivered");
}

console.log("\n[7] makeChannel() refuses to build a half-configured sender");
{
  ok(makeChannel({ channel: "console" }).name === "console", "console channel needs no credentials");
  let threw = false;
  try { makeChannel({ channel: "telegram" }); } catch (e) { threw = /token \+ chat/.test(e.message); }
  ok(threw, "telegram without credentials throws a clear error instead of failing at 3am");
  threw = false;
  try { makeChannel({ channel: "webhook" }); } catch (e) { threw = /WEBHOOK_URL/.test(e.message); }
  ok(threw, "webhook without a URL throws a clear error");
}

console.log("\n[8] end-to-end through the worker route");
{
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  await store.mint("https://panel.example/sub?who=bao", "Bao", { customer: "Bao", supplier_expires: day(2) });
  const HOST = "https://sp.example.com";
  const run = await worker.fetch(new Request(HOST + "/admin/reminders", { method: "POST", body: "", headers: { cookie: ADMIN_COOKIE } }), ADMIN_ENV, {});
  const jr = JSON.parse(await run.text());
  ok(run.status === 200, `POST /admin/reminders 200 (got ${run.status})`);
  ok(jr.sent.length >= 1, `route sent ${jr.sent.length} reminder(s)`);
  const hist = await worker.fetch(new Request(HOST + "/admin/reminders", { headers: { cookie: ADMIN_COOKIE } }), ADMIN_ENV, {});
  const jh = JSON.parse(await hist.text());
  ok(hist.status === 200 && jh.count >= 1, `GET /admin/reminders returns history (${jh.count})`);
}

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
