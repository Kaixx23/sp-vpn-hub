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
for (const id of ["q", "filter", "sort", "refresh", "add", "rows", "stats", "meta", "modal", "result", "mtitle", "toast", "peek", "save", "cancel"])
  els[id] = el(id);
els.form = el("form", {
  reset: () => { for (const f of FORM_FIELDS) els.form[f].value = ""; },
});
const FORM_FIELDS = ["token", "supplier_expires", "total_gb", "used_gb", "link", "customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "label"];
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
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => realFetch(url.startsWith("/") ? BASE + url : url, opts);
const fire = (id, ev, arg) => { for (const fn of listeners[id + ":" + ev] || []) fn(arg || { target: els[id], preventDefault() {} }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- load the real CLIENT script from the real rendered page ------------------
const html = dashboardPage(BASE);
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
new Function(js)(); // executes: wires listeners + load()

await sleep(300); // let load() finish
ok(els.rows.innerHTML.includes("of ") || els.rows.innerHTML.length > 0, "load() rendered rows into #rows");
ok(els.stats.innerHTML.length > 0, "renderStats() filled #stats");

// ---- open the Add-customer modal ---------------------------------------------
fire("add", "click");
ok(els.modal.hidden === false, "Add-customer modal opened");
ok(els.mtitle.textContent === "Add customer", "modal title set");
ok(els.form.link.disabled === false, "supplier link editable in add mode");

// ---- paste a link, wait for the debounced auto-detect -------------------------
els.form.link.value = "http://localhost:9911/?who=ali";
fire("form.link", "input");
ok(els.peek.hidden === true || els.peek.textContent === "", "peek quiet before debounce fires");
await sleep(2600); // debounce 700ms + supplier fetch
const peekText = els.peek.textContent;
ok(els.peek.hidden === false, "peek line became visible after detect");
ok(peekText.includes("200 GB total") && peekText.includes("53.6 GB used"), `peek shows quota ("${peekText}")`);
ok(peekText.includes("expires 2026-10-19"), "peek shows expiry");
ok(peekText.includes("4 nodes"), "peek shows node count");
ok(els.form.supplier_expires.value === "2026-10-19", `hidden supplier_expires filled (${els.form.supplier_expires.value})`);
ok(String(els.form.total_gb.value) === "200", `hidden total_gb filled (${els.form.total_gb.value})`);
ok(String(els.form.used_gb.value) === "53.6", `hidden used_gb filled (${els.form.used_gb.value})`);
ok(els.form.paid_until.value === "2026-10-19", "paid_until auto-prefilled from detected expiry");
ok(els.form.plan.value === "200GB", "plan auto-prefilled from detected quota");

// user fills the rest
els.form.customer.value = "Sim Client";
els.form.price.value = "12";

// ---- submit — mint with the detected details ----------------------------------
const before = await (await fetch(BASE + "/admin/dashboard.json")).json();
fire("form", "submit", { target: els.form, preventDefault() {} });
await sleep(900); // mint + reload
ok(els.result.className.includes("ok"), "submit reported success");
ok(els.result.textContent.includes("Created"), "submit shows the one-link message");
const after = await (await fetch(BASE + "/admin/dashboard.json")).json();
ok(after.customers.length === before.customers.length + 1, "customer count grew by 1");
const row = after.customers.find((r) => r.customer === "Sim Client");
ok(!!row, "new customer present in dashboard.json");
ok(row && row.supplier_expires === "2026-10-19", `expiry stored from detect (${row && row.supplier_expires})`);
ok(row && row.total_gb === 200 && row.used_gb === 53.6, `quota stored from detect (${row && row.total_gb}/${row && row.used_gb})`);
ok(after.stats.expiring30 >= 1, "new row lands in the expiring-30d bucket immediately");

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

console.log("\n" + "─".repeat(70));
if (failures.length) { console.log(`❌ ${failures.length} checks FAILED`); process.exit(1); }
console.log("🎉 CLIENT-SIM: ALL CHECKS PASSED");
