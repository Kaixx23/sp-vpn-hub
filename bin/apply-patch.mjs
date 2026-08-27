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
const POST_ADMIN = `        if (path === "/admin/mint") {
          const link = (data.link || "").trim();
          const label = (data.label || "").trim().slice(0, 200) || null;
          if (!/^(https?:\\/\\/|[a-z0-9+.-]+:\\/\\/)/i.test(link)) {
            return json({ error: "link must be a subscription URL or node link" }, 400);
          }
          const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));
          const txt = (v) => (v ? String(v).trim().slice(0, 200) : null);
          const token = await storeMint(link, label, {
            customer: txt(data.customer),
            plan: txt(data.plan),
            price: num(data.price),
            currency: txt(data.currency),
            billing_cycle: txt(data.billing_cycle),
            paid_until: txt(data.paid_until),
            notes: txt(data.notes),
          });
          return json({ token, oneLink: \`\${host}/all/\${encodeURIComponent(brand)}?t=\${token}\` });
        }
        if (path === "/admin/customer") {
          const patchObj = {};
          for (const k of ["customer", "plan", "currency", "billing_cycle", "paid_until", "notes", "label"]) {
            if (data[k] !== undefined) patchObj[k] = data[k] ? String(data[k]).trim().slice(0, 200) : null;
          }
          if (data.price !== undefined) patchObj.price = data.price === "" ? null : Number(data.price);
          if (data.revoked !== undefined) patchObj.revoked = data.revoked === "1";
          const updated = await storeUpdate(data.token || "", patchObj);
          return updated ? json(redact(updated)) : json({ error: "unknown token" }, 404);
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
        return json({ generated: new Date().toISOString(), stats: summarise(rows), customers: rows.map(redact) });
      }
      if (path === "/admin/refresh") {
        const rows = (await storeList()).filter((r) => !r.revoked);
        // Bounded parallelism: the supplier panel must not see a burst of 50
        // concurrent fetches just because you opened the dashboard.
        const CONC = 6;
        let updated = 0, failed = 0;
        for (let i = 0; i < rows.length; i += CONC) {
          const batch = rows.slice(i, i + CONC);
          await Promise.all(batch.map(async (r) => {
            try {
              const { status } = await fetchSubscription(r.supplier_url);
              const s = quotaSummary(status);
              if (!s) { failed++; return; }
              await storeUpdate(r.token, {
                supplier_expires: s.exp,
                total_gb: s.tot,
                used_gb: Math.round((s.up + s.down) * 100) / 100,
                checked_at: new Date().toISOString(),
              });
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
        if (action === "rotate") {
          const cur = (await storeList()).find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          // Carry the customer's details onto the new link, but never its
          // identity: token / created_at / revoked belong to the new row.
          const carry = {};
          for (const k of ["customer", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "supplier_expires", "total_gb", "used_gb", "checked_at"]) {
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
        return json({ error: "action must be rotate | revoke | delete" }, 400);
      }
      if (path === "/admin/links") {
        const rows = await storeList();
        return json({ count: rows.length, links: rows.map(redact) });
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
} from "./token-store.js";
import { dashboardPage, summarise } from "./dashboard.js";
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
  "POST /admin/mint + /admin/customer",
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
    await storeInit().catch(() => {}); // a backend hiccup must not 500 every route
    // m0 is declared here rather than down with the route variables: the admin
    // routes use it, and a let-declaration further down would be hoisted into
    // a temporal dead zone.
    let url, path, m0;`,
);

// 7 ------------------------------------------------- json() + redact() ----
patch(
  "json() + redact() helpers",
  `function subHeaders(status, pageUrl) {`,
  `const json = (obj, code = 200) =>
  new Response(JSON.stringify(obj, null, 2) + "\\n", {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
// The admin output must never hand back a supplier URL in full — that is the
// exact secret this whole change exists to protect. Host only.
const redact = (r) => ({
  token: r.token,
  label: r.label,
  customer: r.customer || null,
  plan: r.plan || null,
  price: r.price ?? null,
  currency: r.currency || null,
  billing_cycle: r.billing_cycle || null,
  paid_until: r.paid_until || null,
  notes: r.notes || null,
  supplier_expires: r.supplier_expires || null,
  total_gb: r.total_gb ?? null,
  used_gb: r.used_gb ?? null,
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
    await storeInit().catch(() => {});
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
