#!/usr/bin/env node
// Applies the opaque-token + dashboard change to the vendored copy of
// sp-vpn-worker.js. Every replacement is asserted: if the upstream source
// drifts, this fails loudly instead of producing a silently un-patched worker.
//
// Rebuild from scratch with:
//   cp ../sp-global/sp-vpn-worker.js . && node bin/apply-patch.mjs
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../sp-vpn-worker.js", import.meta.url).pathname;
let src = readFileSync(FILE, "utf8");

const edits = [];
function patch(label, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`[FAIL] ${label}: expected exactly 1 match, found ${n}`);
  src = src.replace(from, to);
  edits.push(label);
}

// Routes that need the POST body. They MUST live inside the POST branch,
// because `data` is declared there — putting them in the GET section means
// they are never reached.
const POST_ADMIN = `        if (path === "/admin/shared-link") {
          try {
            const source = resolveCustomerLink(data.link, host, await storeList(), "shared");
            return json({ account: source.account });
          } catch (e) {
            return json({ error: e.status ? e.message : "Could not look up the supplier account." }, e.status || 500);
          }
        }
        if (path === "/admin/mint") {
          const type = data.customer_type || "individual";
          if (!validCustomerType(type)) return json({ error: "customer_type must be individual or shared" }, 400);
          if (data.paid_until) return json({ error: "Create the customer first, then use Pay to record their payment." }, 400);
          const label = (data.label || "").trim().slice(0, 200) || null;
          let source;
          try { source = resolveCustomerLink(data.link, host, await storeList(), type); }
          catch (e) { return json({ error: e.status ? e.message : "Could not look up the supplier account." }, e.status || 500); }
          const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));
          const txt = (v) => (v ? String(v).trim().slice(0, 200) || null : null);
          const token = await storeMint(source.supplierUrl, label, {
            customer: txt(data.customer),
            customer_type: type,
            supplier_account: type === "shared" ? source.account.name : txt(data.supplier_account) || source.account?.name || null,
            plan: txt(data.plan),
            price: num(data.price),
            currency: txt(data.currency),
            billing_cycle: txt(data.billing_cycle),
            notes: txt(data.notes),
          });
          return json({ token, oneLink: \`\${host}/all/\${encodeURIComponent(brand)}?t=\${token}\` });
        }
        if ((m0 = path.match(/^\\/admin\\/link\\/([^/]+)$/)) && url.searchParams.get("action") === "pay") {
          const t = m0[1];
          const rows = await storeList();
          const cur = rows.find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          if (cur.revoked) return json({ error: "cannot record payment for a revoked customer" }, 400);
          const paidUntil = (data.paid_until || "").trim();
          if (!validPaidUntil(paidUntil)) return json({ error: "Choose a valid paid-until date (today or later)." }, 400);
          // Deliberately update ONE customer by token, not everyone on the
          // supplier URL. Do not fetch the supplier or infer that they paid.
          const updated = await storeUpdate(t, { paid_until: paidUntil });
          return updated ? json(redact(updated, supplierAccounts(rows))) : json({ error: "unknown token" }, 404);
        }
        if (path === "/admin/customer") {
          if (data.paid_until !== undefined) return json({ error: "Use Pay to record a customer's payment." }, 400);
          if (data.customer_type !== undefined && !validCustomerType(data.customer_type)) {
            return json({ error: "customer_type must be individual or shared" }, 400);
          }
          const rows = await storeList();
          const cur = rows.find((r) => r.token === data.token);
          if (!cur) return json({ error: "unknown token" }, 404);
          const patchObj = {};
          for (const k of ["customer", "customer_type", "plan", "currency", "billing_cycle", "notes", "label"]) {
            if (data[k] !== undefined) patchObj[k] = data[k] ? String(data[k]).trim().slice(0, 200) : null;
          }
          if (data.price !== undefined) patchObj.price = data.price === "" ? null : Number(data.price);
          if (data.revoked !== undefined) patchObj.revoked = data.revoked === "1";
          // An account name belongs to the supplier link. Renaming it on the
          // original customer also updates its shared customers, not billing.
          if (data.supplier_account !== undefined && (data.customer_type || customerType(cur)) === "individual") {
            const name = String(data.supplier_account).trim().slice(0, 200) || null;
            for (const row of rows.filter((r) => supplierKey(r.supplier_url) === supplierKey(cur.supplier_url))) {
              await storeUpdate(row.token, { supplier_account: name });
            }
          }
          const updated = await storeUpdate(cur.token, patchObj);
          return updated ? json(redact(updated, supplierAccounts(await storeList()))) : json({ error: "unknown token" }, 404);
        }
`;

// Routes that only read the URL. These live in the GET section.
const GET_ADMIN = `      // ---- dashboard ----
      if (path === "/admin" || path === "/admin/dashboard") {
        return new Response(dashboardPage(host), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/admin/dashboard.json") {
        const rows = await storeList();
        const accounts = supplierAccounts(rows);
        return json({ generated: new Date().toISOString(), stats: summarise(rows), customers: rows.map((r) => redact(r, accounts)) });
      }
      if (path === "/admin/refresh") {
        const all = await storeList();
        const rows = all.filter((r) => !r.revoked);
        const accounts = supplierAccounts(all);
        // Bounded parallelism: the supplier panel must not see a burst of 50
        // concurrent fetches just because you opened the dashboard.
        const CONC = 6;
        let updated = 0, failed = 0;
        for (let i = 0; i < rows.length; i += CONC) {
          const batch = rows.slice(i, i + CONC);
          await Promise.all(batch.map(async (r) => {
            try {
              await refreshCustomer(r, accounts);
              updated++;
            } catch (e) {
              failed++;
            }
          }));
        }
        return json({ checked: rows.length, updated, failed });
      }

      // ---- link lifecycle ----
      if ((m0 = path.match(/^\\/admin\\/link\\/([^/]+)$/))) {
        const t = m0[1];
        const action = url.searchParams.get("action");
        if (action === "pay") return json({ error: "Use POST to record a payment." }, 405, { Allow: "POST" });
        if (action === "check" || action === "renew") {
          const rows = await storeList();
          const cur = rows.find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          if (cur.revoked) return json({ error: "cannot check a revoked customer" }, 400);
          try {
            return json(await refreshCustomer(cur, supplierAccounts(rows)));
          } catch (e) {
            return json({ error: e.message || "supplier check failed" }, 502);
          }
        }
        if (action === "rotate") {
          const cur = (await storeList()).find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          // Carry the customer's details onto the new link, but never its
          // identity: token / created_at / revoked belong to the new row.
          const carry = {};
          for (const k of ["customer", "customer_type", "supplier_account", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "supplier_expires", "total_gb", "used_gb", "usage_delta_gb", "checked_at"]) {
            if (cur[k] != null) carry[k] = cur[k];
          }
          const fresh = await storeMint(cur.supplier_url, cur.label, carry);
          await storeUpdate(t, { revoked: true });
          return json({ oldToken: t, newToken: fresh, note: "old link is now dead — send the new one" });
        }
        if (action === "revoke") {
          const r = await storeUpdate(t, { revoked: true });
          return r ? json({ token: t, revoked: true }) : json({ error: "unknown token" }, 404);
        }
        if (action === "delete") {
          const gone = await storeRemove(t);
          return gone ? json({ token: t, deleted: true }) : json({ error: "unknown token" }, 404);
        }
        return json({ error: "action must be check | pay (POST) | renew | rotate | revoke | delete" }, 400);
      }
      if (path === "/admin/links") {
        const rows = await storeList();
        const accounts = supplierAccounts(rows);
        return json({ count: rows.length, links: rows.map((r) => redact(r, accounts)) });
      }

`;

// 1 --------------------------------------------------------------- import --
patch(
  "import the token store and dashboard",
  `// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste this file → Deploy.`,
  `// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste this file → Deploy.
//
// MODIFIED: tokens are now opaque (see token-store.js) and there is a customer
// registry + dashboard (see dashboard.js). The supplier URL is no longer
// base64-encoded into the customer's link.
import {
  mint as storeMint,
  resolve as storeResolve,
  updateRow as storeUpdate,
  listAll as storeList,
  removeRow as storeRemove,
  ensureInit as storeInit,
  setBackend as storeSetBackend,
  backend as storeBackend,
} from "./token-store.js";
import { dashboardPage, summarise } from "./dashboard.js";
import { customerType, validCustomerType, supplierKey, supplierAccounts, resolveCustomerLink, validPaidUntil } from "./customer-accounts.js";
import { runRemindersFromEnv } from "./reminders.js";
import {
  hasBeenSent as storeHasBeenSent,
  markSent as storeMarkSent,
  listReminders as storeListReminders,
} from "./token-store.js";`,
);

// 2 ------------------------------------------------- collectRows: minting --
patch(
  "collectRows mints opaque tokens",
  `    const isNodeLink = !/^https?:\\/\\//i.test(link);
    const key = isNodeLink ? "direct:" + link : link;
    const tok = b64e(key);`,
  `    const isNodeLink = !/^https?:\\/\\//i.test(link);
    const key = isNodeLink ? "direct:" + link : link;
    // Opaque token — the supplier link is stored server-side, never in the URL.
    const tok = await storeMint(key, "seller-tool");`,
);

// 3 -------------------------------------- POST /: customer quota flow -----
patch(
  "POST / mints an opaque token",
  `          return new Response(null, { status: 302, headers: { Location: "/q/" + b64e(link) } });`,
  `          const qtok = await storeMint(link, "quota-page");
          return new Response(null, { status: 302, headers: { Location: "/q/" + qtok } });`,
);

// 4 ------------------------------- POST admin routes (need the POST body) --
patch(
  "POST customer creation, shared-account lookup, payment and editing",
  `        if (path === "/") {
          const link = (data.link || "").trim();`,
  `${POST_ADMIN}        if (path === "/") {
          const link = (data.link || "").trim();`,
);

// 5 ------------------------------------------------- getDecoded: resolve --
patch(
  "getDecoded resolves via the store",
  `async function getDecoded(tok) {
  const hit = _cache.get(tok);
  if (hit && Date.now() - hit.t < TTL) return hit.d;
  let d;
  const url = b64d(tok);
  if (url.startsWith("direct:")) {`,
  `async function getDecoded(tok) {
  // Token state is resolved on EVERY request so revocation takes effect
  // immediately; only the expensive supplier fetch is memoised below.
  let url = null;
  try {
    url = await storeResolve(tok);
  } catch (e) {
    // Store unreachable: serve a cached payload rather than killing every
    // student's VPN because the database had a blip.
    const stale = _cache.get(tok);
    if (stale && Date.now() - stale.t < TTL) return stale.d;
    throw e;
  }
  if (!url) throw new Error("unknown or revoked link");

  const hit = _cache.get(tok);
  if (hit && Date.now() - hit.t < TTL) return hit.d;
  let d;
  if (url.startsWith("direct:")) {`,
);

// 6 ----------------------------------------------------- admin: env hook --
patch(
  "fetch() wires the env-provided backend",
  `export default {
  async fetch(request, env, ctx) {
    let url, path;`,
  `export default {
  async fetch(request, env, ctx) {
    if (env && (env.DB || env.TOKEN_STORE_URL)) storeSetBackend(null);
    await storeInit(env).catch(() => {}); // a backend hiccup must not 500 every route
    // m0 is declared here rather than down with the route variables: the admin
    // routes use it, and a let-declaration further down would be hoisted into
    // a temporal dead zone.
    let url, path, m0;`,
);

// 7 ------------------------------------------------- json() + redact() ----
patch(
  "json() + redact() helpers",
  `function subHeaders(status, pageUrl) {`,
  `const json = (obj, code = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2) + "\\n", {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
// The admin output must never hand back a supplier URL in full — that is the
// exact secret this whole change exists to protect. Host only.
// Recheck one saved supplier subscription and persist its latest renewal and
// quota state ONLY. Supplier renewal is never proof of a customer payment,
// especially when several customers share the same supplier account.
// The delta compares this check with the immediately previous check.
async function refreshCustomer(row, accounts) {
  const previousExpiry = row.supplier_expires || null;
  const previousUsed = row.used_gb == null ? null : Number(row.used_gb);
  const { status } = await fetchSubscription(row.supplier_url);
  const s = quotaSummary(status);
  if (!s) throw new Error("supplier did not return quota or expiry information");
  const used = Math.round((s.up + s.down) * 100) / 100;
  const usageDelta = previousUsed == null ? null : Math.round((used - previousUsed) * 100) / 100;
  const updated = await storeUpdate(row.token, {
    supplier_expires: s.exp,
    total_gb: s.tot,
    used_gb: used,
    usage_delta_gb: usageDelta,
    checked_at: new Date().toISOString(),
  });
  return {
    customer: redact(updated, accounts),
    previousExpiry,
    expiry: s.exp,
    expiryChanged: previousExpiry !== null && previousExpiry !== s.exp,
    previousUsedGb: previousUsed,
    usedGb: used,
    usageDeltaGb: usageDelta,
  };
}

const redact = (r, accounts = supplierAccounts([r])) => ({
  token: r.token,
  label: r.label,
  customer: r.customer || null,
  customer_type: customerType(r),
  supplier_account: accounts.get(supplierKey(r.supplier_url)) || null,
  plan: r.plan || null,
  price: r.price ?? null,
  currency: r.currency || null,
  billing_cycle: r.billing_cycle || null,
  paid_until: r.paid_until || null,
  notes: r.notes || null,
  supplier_expires: r.supplier_expires || null,
  total_gb: r.total_gb ?? null,
  used_gb: r.used_gb ?? null,
  usage_delta_gb: r.usage_delta_gb ?? null,
  checked_at: r.checked_at || null,
  revoked: !!r.revoked,
  created_at: r.created_at,
  supplier_host: (() => {
    try { return new URL(r.supplier_url).host; } catch (e) { return "direct-node-list"; }
  })(),
  legacy: r.label === "legacy",
});

function subHeaders(status, pageUrl) {`,
);

// 8 ------------------------------------------------------- admin routes ---
patch(
  "GET admin + dashboard routes",
  `      // GET
      if (path === "/healthz") return plain("ok");`,
  `      // GET
      if (path === "/healthz") return plain("ok");

${GET_ADMIN}`,
);

// 9 ------------------------------------------ expose quotaSummary ---------
patch(
  "export quotaSummary so /admin/refresh can reuse it",
  `function quotaSummary(status) {`,
  `export function quotaSummary(status) {`,
);

// 10 ---------------------------------------------- reminders: routes ----
patch(
  "GET /admin/reminders (history) and POST /admin/reminders (run now)",
  `      if (path === "/admin/links") {`,
  `      if (path === "/admin/reminders/run") {
        // GET so a platform cron can hit it directly (Vercel/Netlify crons
        // issue GETs). On Cloudflare prefer the scheduled() handler instead.
        const out = await runRemindersFromEnv(env || {}, {
          listAll: storeList, updateRow: storeUpdate,
          hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
        }, { fetchSubscription, quotaSummary });
        return json(out);
      }
      if (path === "/admin/reminders") {
        const rows = await storeListReminders(Number(url.searchParams.get("limit")) || 100);
        return json({ count: rows.length, reminders: rows });
      }
      if (path === "/admin/links") {`,
);

patch(
  "POST /admin/reminders triggers a pass immediately",
  `        if (path === "/admin/customer") {`,
  `        if (path === "/admin/reminders") {
          const out = await runRemindersFromEnv(env || {}, {
            listAll: storeList, updateRow: storeUpdate,
            hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
          }, { fetchSubscription, quotaSummary });
          return json(out);
        }
        if (path === "/admin/customer") {`,
);

// 11 ---------------------------------------------- reminders: cron -------
patch(
  "Workers cron handler (Cloudflare scheduled triggers)",
  `    }
  },
};`,
  `    }
  },

  // Cloudflare scheduled trigger. Add to wrangler.toml:
  //   [triggers]
  //   crons = ["0 * * * *"]
  // On Vercel/Netlify use a cron job hitting POST /admin/reminders instead —
  // see README → Scheduling.
  async scheduled(event, env, ctx) {
    if (env && (env.DB || env.TOKEN_STORE_URL)) storeSetBackend(null);
    await storeInit(env).catch(() => {});
    await runRemindersFromEnv(env || {}, {
      listAll: storeList, updateRow: storeUpdate,
      hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
    }, { fetchSubscription, quotaSummary });
  },
};`,
);

writeFileSync(FILE, src);
console.log(`✅ applied ${edits.length} edits to sp-vpn-worker.js`);
edits.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
