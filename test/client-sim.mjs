// ============================================================================
// CLIENT-SIM — executes the dashboard's inline CLIENT script inside a tiny DOM
// harness against the real local server, simulating the full add-customer
// flow: open modal → paste link → auto-detect → submit.
// Not part of npm test (needs the dev server + demo supplier running).
// Run: node test/client-sim.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { dashboardPage } from "../dashboard.js";

const BASE = "http://localhost:8787";
const failures = [];
const ok = (cond, msg) => { console.log((cond ? "  ✅ " : "  ❌ ") + msg); if (!cond) failures.push(msg); };

// ---- tiny DOM ----------------------------------------------------------------
const listeners = {};
function el(id, props = {}) {
  const e = {
    id, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "",
    className: "", dataset: {}, style: {},
    addEventListener: (ev, fn) => { (listeners[id + ":" + ev] ||= []).push(fn); },
    reset: () => { for (const k of Object.keys(e)) if (typeof e[k] !== "function") delete e[k]; Object.assign(e, { value: "", hidden: false, disabled: false, textContent: "", innerHTML: "", className: "", dataset: {} }); },
    ...props,
  };
  return e;
}
const els = {};
for (const id of ["q", "filter", "sort", "refresh", "add", "rows", "stats", "meta", "modal", "result", "mtitle", "toast", "peek", "save", "cancel", "healthpill", "healthmodal", "healthbody", "healthre", "healthclose"])
  els[id] = el(id);
els.form = el("form", {
  reset: () => { for (const f of FORM_FIELDS) els.form[f].value = els.form[f].defaultValue ?? ""; },
});
const FORM_FIELDS = ["token", "supplier_expires", "total_gb", "used_gb", "link", "customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "label", "account_email", "account_password"];
for (const f of FORM_FIELDS) els.form[f] = el("form." + f);

globalThis.document = {
  querySelector: (s) => els[s.replace("#", "")] || null,
};
globalThis.location = { origin: BASE };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.confirm = () => true;
globalThis.FormData = class FormData {
  constructor(f) { this.d = {}; if (f && f.id === "form") for (const k of FORM_FIELDS) if (!f[k].disabled) this.d[k] = String(f[k].value ?? ""); }
  entries() { return Object.entries(this.d); }
  [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }
};
globalThis.setInterval = () => 0; // the client polls health on an interval; keep the sim exitable
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => realFetch(url.startsWith("/") ? BASE + url : url, opts);
const fire = (id, ev, arg) => { for (const fn of listeners[id + ":" + ev] || []) fn(arg || { target: els[id], preventDefault() {} }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- cleanup: remove leftover Sim Client rows from previous runs -------------
{
  const j = await realFetch(BASE + "/admin/dashboard.json").then((r) => r.json());
  for (const r of j.customers.filter((x) => x.customer === "Sim Client"))
    await realFetch(BASE + "/admin/link/" + r.token + "?action=delete");
}

// ---- load the real CLIENT script from the real rendered page ------------------
const html = dashboardPage(BASE);
// mirror the browser: an input's value="" attribute is its reset default
for (const m of html.matchAll(/<input[^>]*name="([a-z_]+)"[^>]*>/g)) {
  const v = m[0].match(/\svalue="([^"]*)"/);
  if (v && els.form[m[1]]) els.form[m[1]].defaultValue = v[1];
}
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
new Function(js)(); // executes: wires listeners + load()

await sleep(1200); // let load() + loadHealth() finish
ok(els.rows.innerHTML.includes("of ") || els.rows.innerHTML.length > 0, "load() rendered rows into #rows");
ok(els.stats.innerHTML.length > 0, "renderStats() filled #stats");

// ---- live health pill + panel -----------------------------------------------
ok(els.healthpill.className.includes("ok"), `health pill went green ("${els.healthpill.textContent}")`);
fire("healthpill", "click");
ok(els.healthmodal.hidden === false, "health panel opens from the pill");
ok(els.healthbody.innerHTML.includes("Token store"), "health panel shows the store row");
ok(els.healthbody.innerHTML.includes("Converter"), "health panel shows the converter row");
els.healthmodal.hidden = true;

// ---- open the Add-customer modal ---------------------------------------------
fire("add", "click");
ok(els.modal.hidden === false, "Add-customer modal opened");
ok(els.mtitle.textContent === "Add customer", "modal title set");
ok(els.form.link.disabled === false, "supplier link editable in add mode");
ok(els.form.account_password.value === "shevinx123", `panel password pre-filled with the shared default (${els.form.account_password.value})`);

// ---- paste a link, wait for the debounced auto-detect -------------------------
els.form.link.value = "http://localhost:9911/?who=riz";
fire("form.link", "input");
ok(els.peek.hidden === true || els.peek.textContent === "", "peek quiet before debounce fires");
await sleep(2600); // debounce 700ms + supplier fetch
const peekText = els.peek.textContent;
ok(els.peek.hidden === false, "peek line became visible after detect");
ok(peekText.includes("512 GB total") && peekText.includes("20.28 GB used"), `peek shows quota ("${peekText}")`);
ok(peekText.includes("expires 2026-09-27"), "peek shows expiry");
ok(peekText.includes("4 nodes"), "peek shows node count");
ok(peekText.includes("12 RMB / monthly"), "peek shows the auto-matched plan price");
ok(peekText.includes("cost 4, profit 8"), "peek shows cost + profit for the matched plan");
ok(els.form.supplier_expires.value === "2026-09-27", `hidden supplier_expires filled (${els.form.supplier_expires.value})`);
ok(String(els.form.total_gb.value) === "512", `hidden total_gb filled (${els.form.total_gb.value})`);
ok(String(els.form.used_gb.value) === "20.28", `hidden used_gb filled (${els.form.used_gb.value})`);
ok(els.form.paid_until.value === "2026-09-27", "paid_until auto-prefilled from detected expiry");
ok(els.form.plan.value === "512GB", "plan auto-prefilled from detected quota");
ok(String(els.form.price.value) === "12", `price auto-filled from catalogue (${els.form.price.value})`);
ok(els.form.currency.value === "RMB", `currency auto-filled (${els.form.currency.value})`);
ok(els.form.billing_cycle.value === "monthly", `billing cycle auto-filled (${els.form.billing_cycle.value})`);

// user fills the rest
els.form.customer.value = "Sim Client";
els.form.account_email.value = "sim.client@gmail.com";

// ---- submit — mint with the detected details ----------------------------------
const before = await (await fetch(BASE + "/admin/dashboard.json")).json();
fire("form", "submit", { target: els.form, preventDefault() {} });
await sleep(900); // mint + reload
ok(els.result.className.includes("ok"), "submit reported success");
ok(els.result.innerHTML.includes("Created ✓"), "submit shows the created message");
ok(els.result.innerHTML.includes("onelink"), "one-link box rendered");
ok(els.result.innerHTML.includes("data-copy="), "copy button rendered next to the link");
ok(els.modal.hidden === false, "modal STAYS OPEN after create (time to copy)");
ok(els.save.disabled === true, "save disabled after create (no double-mint)");
ok(els.cancel.textContent === "Close", "cancel became Close");
const after = await (await fetch(BASE + "/admin/dashboard.json")).json();
ok(after.customers.length === before.customers.length + 1, "customer count grew by 1");
const row = after.customers.find((r) => r.customer === "Sim Client");
ok(!!row, "new customer present in dashboard.json");
ok(row && row.supplier_expires === "2026-09-27", `expiry stored from detect (${row && row.supplier_expires})`);
ok(row && row.total_gb === 512 && row.used_gb === 20.28, `quota stored from detect (${row && row.total_gb}/${row && row.used_gb})`);
ok(row && row.price === 12 && row.currency === "RMB" && row.billing_cycle === "monthly", `catalogue pricing stored (${row && row.price} ${row && row.currency} ${row && row.billing_cycle})`);
ok(row && row.account_email === "sim.client@gmail.com", `panel account email stored (${row && row.account_email})`);
ok(row && row.account_password === "shevinx123", "panel account password stored");
ok(row && row.profit === 8, `per-row profit computed by the API (${row && row.profit})`);
ok(els.stats.innerHTML.includes("profit"), "stats show the profit card");
ok(els.rows.innerHTML.includes("sim.client@gmail.com"), "table shows the panel account email");
ok(els.rows.innerHTML.includes("+8 net"), "table shows the +8 net profit badge");

// ---- health re-check with a customer in the store -------------------------------
{
  fire("healthpill", "click");
  fire("healthre", "click");
  await sleep(2500); // force=1 re-check fetches supplier + converter end-to-end
  ok(els.healthbody.innerHTML.includes("nodes"), "health re-check shows supplier/converter node counts");
  ok(els.healthbody.innerHTML.includes("Converter"), "health detail lists the converter check");
  els.healthclose && fire("healthclose", "click");
  ok(els.healthmodal.hidden === true, "health panel closes");
}
ok(after.stats.expiring30 >= 1, "new row lands in the expiring-30d bucket immediately");

// ---- copy button in the result box --------------------------------------------
{
  let copied = null;
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
  fire("result", "click", { target: { closest: (sel) => sel === "button[data-copy]" ? { dataset: { copy: row && oneLinkText() } } : null } });
  await sleep(150);
  ok(typeof copied === "string" && copied.includes("/all/") && copied.includes("?t="), `copy button put the one-link on the clipboard (${copied})`);
  ok(els.toast.textContent.includes("copied"), "copy confirmed with a toast");
  function oneLinkText() { const m = els.result.innerHTML.match(/data-copy="([^"]+)"/); return m ? m[1].replace(/&amp;/g, "&") : ""; }
}

// ---- bad link: detect fails, form stays usable --------------------------------
fire("add", "click");
els.form.link.value = "http://localhost:9911/?who=nobody";
fire("form.link", "input");
await sleep(2500);
ok(els.peek.textContent.startsWith("✗"), `failed detect shown ("${els.peek.textContent.slice(0, 60)}…")`);
ok(els.form.supplier_expires.value === "", "hidden detail fields cleared on failed detect");
els.modal.hidden = true; // close without saving

// ---- edit modal shows what's on file ------------------------------------------
fire("rows", "click", { target: { closest: () => ({ dataset: { a: "edit", t: row.token } }) } });
ok(els.modal.hidden === false, "edit modal opened");
ok(els.peek.textContent.startsWith("On file:"), `edit shows stored details ("${els.peek.textContent.slice(0, 60)}…")`);
ok(els.form.link.disabled === true, "supplier link read-only in edit mode");
ok(els.form.customer.value === "Sim Client", "edit form prefilled from the row");
ok(els.form.account_email.value === "sim.client@gmail.com", "edit form prefills the panel account email");
ok(els.form.account_password.value === "shevinx123", "edit form prefills the panel password");
els.modal.hidden = true;

// ---- delete button --------------------------------------------------------------
{
  const before = await realFetch(BASE + "/admin/dashboard.json").then((r) => r.json());
  ok(before.customers.some((r) => r.customer === "Sim Client"), "Sim Client exists before delete");
  fire("rows", "click", { target: { closest: () => ({ dataset: { a: "delete", t: row.token } }) } });
  await sleep(500);
  const after = await realFetch(BASE + "/admin/dashboard.json").then((r) => r.json());
  ok(!after.customers.some((r) => r.token === row.token), "Sim Client gone after delete click");
  ok(els.toast.textContent.includes("Deleted"), `delete confirmed with a toast ("${els.toast.textContent}")`);
}

console.log("\n" + "─".repeat(70));
if (failures.length) { console.log(`❌ ${failures.length} checks FAILED`); process.exit(1); }
console.log("🎉 CLIENT-SIM: ALL CHECKS PASSED");
