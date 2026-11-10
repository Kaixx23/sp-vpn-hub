// ============================================================================
// RENEWAL — re-check ONE customer's supplier subscription.
//
// The reseller renews a customer's plan on the supplier panel by hand. This
// module is the other half of that: it re-reads that single customer's saved
// supplier subscription, persists whatever the supplier now reports (expiry,
// total quota, used quota, checked-at) and reports two things in plain words:
//
//   1. did the expiry move?          -> "Renewed: expiry updated to <date>"
//                                       "Checked: expiry remains <date>"
//   2. how did usage move since the
//      previous SUCCESSFUL check?    -> "+5.0 GB used since last check"
//                                       "No new usage since last check"
//                                       "Usage reset by 190.0 GB"
//
// It NEVER buys or renews anything. It is a read of the supplier plus a write
// to our own row — nothing more.
//
// Design notes that matter:
//
//  * FAILURE IS A NO-OP. If the supplier cannot be reached, or replies without
//    a parsable STATUS line, nothing is written. The row keeps its previous
//    expiry, quota, used_gb and usage_delta_gb, so a flaky panel can never
//    destroy the last known-good numbers or the delta the dashboard is showing.
//
//  * THE PREVIOUS VALUE IS THE ROW ITSELF. Because a failed check writes
//    nothing, `row.used_gb` is by definition the used-GB of the immediately
//    previous *successful* check. `prev_used_gb` is persisted alongside the
//    delta purely so the number stays auditable after the fact.
//
//  * NO SUPPLIER URL EVER LEAVES. Errors are scrubbed of the URL and its host
//    before they are returned, because these strings are rendered straight
//    into the admin dashboard.
//
//  * ONE CODE PATH. The per-customer "Renew / Check" button, the global
//    "Refresh data" button and the reminder cron all call checkCustomerRow(),
//    so the usage delta is calculated and persisted identically by all three.
// ============================================================================

/**
 * Usage moves below this many GB count as "no new usage". Supplier panels
 * report to 2 decimals, so anything under half of the last digit is noise.
 */
export const USAGE_EPSILON = 0.005;

const round2 = (n) => Math.round(n * 100) / 100;

const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Classify a persisted delta.
 *   "first"    — no previous successful check, so there is nothing to compare
 *   "same"     — usage did not move
 *   "increase" — the customer used more data
 *   "reset"    — the supplier reset the counter (typical right after a renewal)
 */
export function usageKind(deltaGb) {
  const d = numOrNull(deltaGb);
  if (d === null) return "first";
  if (Math.abs(d) < USAGE_EPSILON) return "same";
  return d > 0 ? "increase" : "reset";
}

/**
 * The sentence the dashboard shows under "Data usage".
 * `null` on the very first successful check — there is no previous value, so
 * claiming "no new usage" would be a lie.
 */
export function usageMessage(deltaGb) {
  const kind = usageKind(deltaGb);
  if (kind === "first") return null;
  if (kind === "same") return "No new usage since last check";
  const d = Number(deltaGb);
  if (kind === "increase") return "+" + d.toFixed(1) + " GB used since last check";
  return "Usage reset by " + Math.abs(d).toFixed(1) + " GB";
}

/** The sentence the dashboard shows after a Renew / Check. */
export function renewalMessage(expiryChanged, expiry) {
  if (!expiry) {
    return expiryChanged
      ? "Renewed: expiry updated (the supplier did not report a date)"
      : "Checked: the supplier still reports no expiry date";
  }
  return expiryChanged
    ? "Renewed: expiry updated to " + expiry
    : "Checked: expiry remains " + expiry;
}

/**
 * Strip the supplier URL (and its host) out of anything we are about to hand
 * back to the dashboard. The whole point of the opaque-token design is that
 * the supplier URL never leaves the server — an error string is not an excuse.
 */
export function scrubSupplier(text, supplierUrl) {
  let out = String(text ?? "");
  const url = String(supplierUrl || "");
  if (url) {
    out = out.split(url).join("the supplier subscription");
    let host = "";
    try { host = new URL(url).host; } catch (e) { host = ""; }
    if (host) out = out.split(host).join("the supplier");
  }
  // Belt and braces: no scheme-prefixed URL of any kind survives.
  return out.replace(/[a-z0-9+.-]+:\/\/\S+/gi, "<link>").slice(0, 300);
}

// Is this URL one of the links THIS converter hands to customers? Host alone is
// not enough: the owner serves the supplier's own panel through a branded domain
// too (live evidence 2026-11-10: `throttle_hosts: ["xn--9kqs1lo79d.cc ×3"]` — real
// supplier reads, same host as our links). So the route AND our token shape must
// match, which is what separates `/sub/1f5210…adb7a` (ours) from
// `/sub/account-one?token=…` (a panel's own path).
const OUR_ROUTES = /^\/(all|sub|sr|share)(\/|$)/i;
// Returns our token when the URL is shaped like a link this converter minted,
// else null. Shape alone is not proof (a panel could use /sub/<hash> too), so the
// caller still has to confirm it — by host, or by finding the token in the book.
function ourLinkToken(u) {
  if (!OUR_ROUTES.test(u.pathname)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const maybe = seg[0] === "sub" ? seg[1] : u.searchParams.get("t");
  const t = String(maybe || "").toLowerCase();
  return /^[0-9a-f]{48}$/.test(t) ? t : null;
}

/**
 * Re-check ONE row against its supplier and persist the result.
 *
 * @param row   the full store row (must carry token + supplier_url)
 * @param deps  { fetchSubscription, quotaSummary, updateRow, now? }
 * @returns on success
 *   { ok: true, row, previous, expiryChanged, usageDeltaGb, usageKind,
 *     message, usageMessage }
 * on failure (nothing was written)
 *   { ok: false, code, error }
 */

// A supplier renewal is never evidence of an individual customer's payment.
// Keep the old export for callers, but it can no longer infer a payment.
export function paidThroughOnRenewal() { return null; }

export async function checkCustomerRow(row, deps) {
  const { fetchSubscription, quotaSummary, updateRow } = deps;
  const now = deps.now || (() => new Date());

  if (!row || !row.token) {
    return { ok: false, code: 404, error: "unknown customer" };
  }
  if (row.revoked) {
    return {
      ok: false,
      code: 409,
      error: "this link is revoked — nothing was checked. Rotate or re-create it first.",
    };
  }

  const supplierUrl = String(row.supplier_url || "");
  if (!supplierUrl) {
    return { ok: false, code: 422, error: "no supplier subscription is saved for this customer" };
  }
  // Two shapes are not checkable, and both are normal: a "direct:" blob of
  // pasted nodes, and a bare node link (vless://, trojan://, vmess://) minted
  // straight from /admin/mint. Neither has a supplier panel behind it, so
  // there is no expiry or quota to read — say so instead of failing obscurely.
  if (supplierUrl.startsWith("direct:") || !/^https?:\/\//i.test(supplierUrl)) {
    return {
      ok: false,
      code: 422,
      error: "this customer holds a direct node list, not a supplier subscription — there is nothing to check",
    };
  }

  const selfHost = (() => {
    const h = deps.selfHost;
    if (!h) return null;
    try { return new URL(String(h), "http://_.invalid").host; }
    catch (e) { return String(h).replace(/^[a-z]+:\/\//i, "").split("/")[0]; }
  })();
  // A link our OWN converter serves, saved as if it were the supplier's. It does
  // answer — 200, with our quota comment on top and zero node links below — so the
  // old behaviour was a baffling "supplier returned no nodes", plus a request that
  // re-entered this same worker. Two independent proofs, either one is enough:
  //   · the URL is on the host serving this request (or any netlify.app host) and
  //     is shaped like one of our links;
  //   · the token in it belongs to a row of the book — then it IS a customer's own
  //     link, whatever domain the owner pasted it from (they run at least three:
  //     sp-vpn, sp-connect, and the branded one, and the branded one also proxies
  //     the panel, so host alone proves nothing there).
  // Real panels live under exactly these path names too — `https://panel.example/
  // sub/account-one?token=…` is an ordinary supplier URL, and a first cut matching
  // only the path silenced the whole reminder pass (test/customer-accounts.test.mjs
  // caught it). No proof matched means we fetch it like any other subscription.
  const tokens = deps.knownTokens instanceof Map ? deps.knownTokens : null;
  try {
    const u = new URL(supplierUrl);
    const t = ourLinkToken(u);
    if (t) {
      const owner = tokens ? tokens.get(t) : undefined;
      const sameHost = (selfHost && u.host === selfHost) || /\.netlify\.app$/i.test(u.host);
      if (owner !== undefined || sameHost) {
        return {
          ok: false,
          code: 422,
          self_referential: true,
          points_at: owner && owner.customer ? owner.customer : null,
          error: "the saved supplier link is one of our own customer links (" + u.pathname +
            (owner && owner.customer ? ", it belongs to " + owner.customer : "") +
            ") — it points back at this converter, so there is nothing upstream to read. " +
            "Edit this customer and paste the link the SUPPLIER gave you.",
        };
      }
    }
  } catch (e) { /* not an absolute URL — the direct-link branch above already handled that */ }

  let summary = null;
  try {
    const { status } = await fetchSubscription(supplierUrl);
    summary = quotaSummary(status);
  } catch (e) {
    // A rate limit is the panel protecting itself from US, and it is the single
    // most common reason a whole-book refresh used to look like an outage. It gets
    // its own words, its own 503, and its own flag — the sweep backs off on it.
    const throttled = !!(e && e.throttled);
    return {
      ok: false,
      code: throttled ? 503 : 502,
      throttled,
      error: throttled
        ? "the supplier's panel is shielding itself from us right now (bot check / rate limit) — nothing was changed. Wait a minute before trying again."
        : "could not check the supplier subscription: " +
          scrubSupplier(e && e.message ? e.message : e, supplierUrl),
    };
  }
  if (!summary) {
    return {
      ok: false,
      code: 502,
      error: "the supplier replied but reported no quota or expiry — nothing was changed",
    };
  }

  const previousUsed = numOrNull(row.used_gb);
  const previousExpiry = row.supplier_expires || null;
  const previousTotal = numOrNull(row.total_gb);

  const used = round2(summary.up + summary.down);
  // null on the first successful check: there is genuinely nothing to compare.
  const delta = previousUsed === null ? null : round2(used - previousUsed);
  const checkedAt = now().toISOString();

  const patch = {
    supplier_expires: summary.exp || null,
    total_gb: summary.tot,
    used_gb: used,
    prev_used_gb: previousUsed,
    usage_delta_gb: delta,
    checked_at: checkedAt,
  };

  // Only supplier data belongs in this patch. Several customers can share
  // this subscription, and each payment must be confirmed separately with Pay.

  let updated;
  try {
    updated = await updateRow(row.token, patch);
  } catch (e) {
    return {
      ok: false,
      code: 500,
      error: "the supplier was read but the result could not be saved: " +
        scrubSupplier(e && e.message ? e.message : e, supplierUrl),
    };
  }
  if (!updated) return { ok: false, code: 404, error: "unknown customer" };

  const expiryChanged = (previousExpiry || null) !== (patch.supplier_expires || null);

  return {
    ok: true,
    row: updated,
    previous: {
      supplier_expires: previousExpiry,
      used_gb: previousUsed,
      total_gb: previousTotal,
      paid_until: row.paid_until || null,
    },
    expiryChanged,
    markedPaid: false,
    paidUntil: updated.paid_until ?? null,
    usageDeltaGb: delta,
    usageKind: usageKind(delta),
    message: renewalMessage(expiryChanged, patch.supplier_expires),
    usageMessage: usageMessage(delta),
  };
}
