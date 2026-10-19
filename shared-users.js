// ============================================================================
// SHARED-USERS — read-only discovery of customers backed by the same supplier
// subscription.
//
// This module is PURE: it receives the stored rows and returns plain report
// objects. It performs no fetch, no storage access and no writes, so a scan can
// never renew, revoke, rotate, delete or infer a payment. The worker is the
// only caller that touches the database.
//
// Matching rule: the COMPLETE underlying supplier subscription URL (normalized
// via supplierKey, which keeps account-identifying query parameters and drops
// fragments). Never the hostname, email, label, plan, dates, customer-type
// flag or the customer's outward-facing opaque link.
//
// Older records may store another customer's Hub link in `supplier_url`. Those
// references are followed in memory (with cycle/depth guards) until the
// original supplier source is found. Nothing in the stored rows is rewritten.
// ============================================================================

import { supplierKey, supplierHost } from "./customer-accounts.js";
import { isOpaque } from "./token-store.js";

// A copied chain longer than this is almost certainly a data problem. Bounded
// so a malformed chain can never hang a scan.
export const MAX_HOPS = 8;

// Subscription clients sometimes append a format suffix to /sub/<token>.
const FORMAT_SUFFIX = /\.(?:ya?ml|txt|conf|json)$/i;
const TOKEN_PATH = /^\/(?:q|sub|share)\/([^/]+)$/;
const ONE_LINK_PATH = /^\/(?:all|sr)\/[^/]+$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// The dashboard renders this verbatim so the UI and API never drift apart.
export const SHARED_USERS_NOTE =
  "This finds registered customer records, not live devices. Someone who received a copied link but was never added to this dashboard cannot be identified here.";

export const UNRESOLVED_REASONS = {
  "missing-record": "Points to a Hub link whose original customer record no longer exists.",
  cycle: "The saved link chain loops back to a record it already visited.",
  "too-deep": `The saved link chain is nested deeper than the supported limit of ${MAX_HOPS} hops.`,
  "invalid-link": "The saved supplier link is empty or malformed.",
};

// Anonymous quota-page and seller-tool rows are operational scratch records,
// never customers: they are excluded from member lists, groups and totals.
const isGeneratedRow = (r) => !r.customer && ["quota-page", "seller-tool"].includes(r.label);

// Legacy tokens were base64url(supplier URL). Kept byte-compatible with
// token-store's legacyResolve, but local so this module stays self-contained.
function decodeLegacyToken(token) {
  try {
    const s = String(token).replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (String(token).length % 4)) % 4);
    const decoded = decodeURIComponent(escape(atob(s)));
    if (decoded && SCHEME_URL.test(decoded)) {
      new URL(decoded); // throws on garbage; a decoded non-URL is not a legacy link
      return decoded;
    }
  } catch (e) {}
  return null;
}

/**
 * Decide whether `rawUrl` is a reference to one of THIS service's Hub links.
 * Returns:
 *   { kind: "ref", token }      – a stored customer/link row to follow
 *   { kind: "legacy", url }     – a same-host legacy base64 Hub link
 *   { kind: "missing" }         – a same-host Hub link with no stored record
 *   { kind: "invalid" }         – a same-host Hub link that is malformed
 *   null                        – an ordinary external supplier URL (terminal)
 */
function recognizeHubRef(rawUrl, serviceHost, byToken) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  let sameHost = false;
  try { sameHost = parsed.host === new URL(serviceHost).host; } catch (e) { sameHost = false; }

  let token = null;
  if (ONE_LINK_PATH.test(parsed.pathname)) {
    token = parsed.searchParams.get("t");
    if (!token) return sameHost ? { kind: "invalid" } : null;
  } else {
    const m = parsed.pathname.match(TOKEN_PATH);
    if (!m) return null; // genuine external supplier URL, e.g. supplier.example/sub/<id>
    token = m[1].replace(FORMAT_SUFFIX, "");
    if (!token) return sameHost ? { kind: "invalid" } : null;
  }

  if (byToken.has(token)) return { kind: "ref", token };
  if (!sameHost) return null; // external /sub/<id> must never be treated as ours

  // A link on this service's own host with no matching stored row.
  if (isOpaque(token)) return { kind: "missing" };
  const legacy = decodeLegacyToken(token);
  if (legacy) return { kind: "legacy", url: legacy };
  return { kind: "missing" };
}

/**
 * Follow a single customer's saved link chain in memory until the original
 * supplier subscription URL is reached. Never throws: every failure mode
 * resolves to a safe "needs review" reason instead of hanging or inventing an
 * independent subscription.
 */
function resolveRow(row, byToken, serviceHost) {
  const initial = typeof row.supplier_url === "string" ? row.supplier_url.trim() : "";
  if (!initial) return { ok: false, reason: "invalid-link" };

  let current = initial;
  const visited = new Set();

  for (let hops = 0; hops <= MAX_HOPS; hops++) {
    let parsed = null;
    try { parsed = new URL(current); } catch (e) {
      // Unparseable saved value: a "direct:" node list is a legitimate terminal
      // source (supplierKey keeps it as-is); anything else is malformed.
      if (/^direct:/i.test(current)) return { ok: true, key: supplierKey(current), host: supplierHost(current) };
      return { ok: false, reason: "invalid-link" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: true, key: supplierKey(current), host: supplierHost(current) };
    }

    const ref = recognizeHubRef(current, serviceHost, byToken);
    if (ref === null) {
      return { ok: true, key: supplierKey(current), host: supplierHost(current) };
    }
    if (ref.kind === "legacy") {
      try {
        const u = new URL(ref.url);
        return { ok: true, key: supplierKey(ref.url), host: u.host || "direct-node-list" };
      } catch (e) {
        return { ok: false, reason: "invalid-link" };
      }
    }
    if (ref.kind === "missing") return { ok: false, reason: "missing-record" };
    if (ref.kind === "invalid") return { ok: false, reason: "invalid-link" };

    if (visited.has(ref.token)) return { ok: false, reason: "cycle" };
    visited.add(ref.token);
    const target = byToken.get(ref.token);
    if (!target) return { ok: false, reason: "missing-record" };
    const next = typeof target.supplier_url === "string" ? target.supplier_url.trim() : "";
    if (!next) return { ok: false, reason: "invalid-link" };
    current = next;
  }
  return { ok: false, reason: "too-deep" };
}

const dayKey = (d) => {
  const t = Date.parse(String(d || "").slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(t) ? null : t;
};

function paymentState(paidUntil, nowMs) {
  const t = dayKey(paidUntil);
  if (t === null) return "unpaid";
  const today = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00Z");
  return t >= today ? "paid" : "unpaid";
}

const displayName = (r) => r.customer || r.label || "Unnamed customer";

// Safe member projection. Deliberately omits supplier_url, account_password,
// raw matching keys and every encoded form of them.
function memberOf(row, nowMs, selectedToken) {
  return {
    token: row.token,
    name: displayName(row),
    plan: row.plan || null,
    customer_type: row.customer_type === "shared" ? "shared" : "individual",
    paid_state: paymentState(row.paid_until, nowMs),
    paid_until: row.paid_until || null,
    supplier_expires: row.supplier_expires || null,
    revoked: !!row.revoked,
    selected: row.token === selectedToken || false,
  };
}

// Safe account description for a resolved group, mirroring the ownership
// preference used elsewhere (earliest individual record, then earliest row).
function accountOf(members, host) {
  const ordered = members.slice().sort((a, b) =>
    String(a.row.created_at || "").localeCompare(String(b.row.created_at || "")) ||
    String(a.row.token || "").localeCompare(String(b.row.token || "")));
  const owner = ordered.find((m) => m.row.customer_type !== "shared")?.row || ordered[0].row;
  const named = ordered.map((m) => m.row).find((r) => r.supplier_account || r.account_email) || owner;
  const name = owner.supplier_account ||
    (!["seller-tool", "quota-page", "legacy"].includes(owner.label) && owner.label) ||
    named.supplier_account || named.account_email ||
    ("Account " + String(owner.token || "").slice(0, 8));
  return {
    id: owner.token,
    name: name || "Account " + String(owner.token || "").slice(0, 8),
    email: owner.account_email || named.account_email || null,
    host: host || "direct-node-list",
  };
}

function buildGroups(rows, serviceHost, nowMs, selectedToken = null) {
  const byToken = new Map(rows.map((r) => [r.token, r]));
  const customers = rows.filter((r) => !isGeneratedRow(r));
  const groups = new Map(); // internal matching key -> bucket (key is never emitted)
  const unresolved = [];

  for (const row of customers) {
    const result = resolveRow(row, byToken, serviceHost);
    if (!result.ok) {
      unresolved.push({
        token: row.token,
        name: displayName(row),
        revoked: !!row.revoked,
        reason: result.reason,
        reason_detail: UNRESOLVED_REASONS[result.reason] || UNRESOLVED_REASONS["invalid-link"],
        selected: row.token === selectedToken,
      });
      continue;
    }
    if (!groups.has(result.key)) groups.set(result.key, { host: result.host, active: [], revoked: [] });
    const bucket = groups.get(result.key);
    if (row.revoked) bucket.revoked.push({ row });
    else bucket.active.push({ row });
  }

  const reports = [...groups.values()].map((bucket) => {
    const all = [...bucket.active, ...bucket.revoked];
    const account = accountOf(all, bucket.host);
    const sortMembers = (list) => list.slice().sort((a, b) =>
      String(a.row.created_at || "").localeCompare(String(b.row.created_at || "")) ||
      String(a.row.token || "").localeCompare(String(b.row.token || "")));
    const active = sortMembers(bucket.active).map((m) => memberOf(m.row, nowMs, selectedToken));
    const revoked = sortMembers(bucket.revoked).map((m) => memberOf(m.row, nowMs, selectedToken));
    return {
      group_id: account.id,
      account,
      active_count: active.length,
      revoked_count: revoked.length,
      member_count: active.length + revoked.length,
      active,
      revoked,
    };
  });

  return { reports, unresolved, customers };
}

const warningsOf = (unresolved) => unresolved.map((u) =>
  `Needs review — ${u.name}: ${u.reason_detail}`);

/** Global scan: only groups backed by two or more ACTIVE customer records. */
export function sharedUsersReport(rows, serviceHost, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const { reports, unresolved } = buildGroups(rows, serviceHost, nowMs);
  const groups = reports
    .filter((g) => g.active_count >= 2)
    .sort((a, b) => (b.active_count - a.active_count) || a.account.name.localeCompare(b.account.name));
  return {
    scope: "all",
    generated: new Date(nowMs).toISOString(),
    groups,
    group_count: groups.length,
    shared_customer_count: groups.reduce((n, g) => n + g.active_count, 0),
    unresolved_count: unresolved.length,
    unresolved,
    warnings: warningsOf(unresolved),
    note: SHARED_USERS_NOTE,
  };
}

/**
 * Inspect one customer's group. Returns null when the token is unknown or
 * belongs to a non-customer (system-generated) record, so the worker can answer
 * 404. Unique, revoked and unresolved customers still get a full 200 report.
 */
export function sharedUsersForToken(rows, serviceHost, token, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const byToken = new Map(rows.map((r) => [r.token, r]));
  const selected = byToken.get(String(token || ""));
  if (!selected || isGeneratedRow(selected)) return null;

  const { reports, unresolved } = buildGroups(rows, serviceHost, nowMs, String(token));
  const selectedUnresolved = unresolved.find((u) => u.token === selected.token) || null;
  const group = reports.find((g) =>
    g.active.some((m) => m.token === selected.token) || g.revoked.some((m) => m.token === selected.token)) || null;
  const otherActiveCount = group
    ? group.active.filter((m) => m.token !== selected.token).length
    : 0;

  return {
    scope: "customer",
    generated: new Date(nowMs).toISOString(),
    selected: {
      token: selected.token,
      name: displayName(selected),
      revoked: !!selected.revoked,
      resolved: !selectedUnresolved,
      reason: selectedUnresolved ? selectedUnresolved.reason : null,
      reason_detail: selectedUnresolved ? selectedUnresolved.reason_detail : null,
    },
    group,
    other_active_count: otherActiveCount,
    unresolved: selectedUnresolved ? [selectedUnresolved] : [],
    warnings: selectedUnresolved ? warningsOf([selectedUnresolved]) : [],
    note: SHARED_USERS_NOTE,
  };
}
