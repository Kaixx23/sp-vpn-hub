// A supplier account may serve several customer records. Match the complete
// supplier URL, never just the hostname: one panel can host many accounts.
// Only the safe account description is returned to the dashboard.
export const customerType = (row) => row.customer_type === "shared" ? "shared" : "individual";
export const validCustomerType = (value) => value === "individual" || value === "shared";

export function supplierKey(link) {
  try {
    const url = new URL(link);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      return url.href;
    }
  } catch {}
  return link;
}

export function supplierHost(link) {
  try { return new URL(link).host || "direct-node-list"; }
  catch { return "direct-node-list"; }
}

export function supplierAccounts(rows) {
  const groups = new Map();
  // Keep the original account's identity even when its link has been rotated.
  const ordered = [...rows].sort((a, b) =>
    String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.token.localeCompare(b.token));
  for (const row of ordered) {
    const key = supplierKey(row.supplier_url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return new Map([...groups].map(([key, members]) => {
    const owner = members.find((r) => customerType(r) === "individual") || members[0];
    const named = [owner, ...members].find((r) => r.supplier_account);
    const label = owner.customer || (!["seller-tool", "quota-page", "legacy"].includes(owner.label) && owner.label);
    return [key, {
      id: owner.token,
      name: named?.supplier_account || label || "Account " + owner.token.slice(0, 8),
      host: supplierHost(owner.supplier_url),
      customers: members.filter((r) => !r.revoked).length,
    }];
  }));
}

const inputError = (message, status = 400) => Object.assign(new Error(message), { status });

/** Resolve an existing customer's one-link without fetching our own service. */
export function resolveCustomerLink(input, host, rows, type = "individual") {
  const link = String(input || "").trim();
  if (!/^[a-z0-9+.-]+:\/\//i.test(link)) {
    throw inputError("Paste a valid supplier URL or an existing customer's link.");
  }
  let parsed;
  try { parsed = new URL(link); }
  catch { throw inputError("That link is not a valid URL."); }

  let supplierUrl = link;
  let source = null;
  const isWeb = /^https?:$/.test(parsed.protocol);
  const tokenPath = parsed.pathname.match(/^\/(?:q|sub|share)\/([^/]+)$/);
  const isOneLink = /^\/(?:all|sr)\/[^/]+$/.test(parsed.pathname);
  const token = tokenPath?.[1] || (isOneLink ? parsed.searchParams.get("t") : null);
  source = token ? rows.find((r) => r.token === token) : null;
  // A real supplier can also use /sub/<id>. Treat it as a Hub route only
  // when the token is ours or the URL points at this service.
  if (isWeb && (source || ((tokenPath || isOneLink) && parsed.host === new URL(host).host))) {
    if (!source) throw inputError("This customer link is not registered here. Paste a current link from this dashboard.", 404);
    if (source.revoked) throw inputError("This customer link is revoked. Use an active customer's link.");
    if (type !== "shared") throw inputError("Choose Shared link to reuse an existing customer's link.");
    supplierUrl = source.supplier_url;
  } else if (isWeb && parsed.host === new URL(host).host) {
    throw inputError("Paste a customer's VPN link, not a dashboard page.");
  } else if (!isWeb) {
    if (type === "shared") throw inputError("Paste the original customer's VPN link or registered supplier URL.");
    supplierUrl = "direct:" + link;
  }

  const key = supplierKey(supplierUrl);
  const account = supplierAccounts(rows).get(key) || null;
  if (type === "shared" && (!account || !rows.some((r) => !r.revoked && supplierKey(r.supplier_url) === key))) {
    throw inputError("No active customer uses this link yet. Add the original customer and supplier account first.");
  }
  return { supplierUrl, account };
}

/** Pay records a deliberate paid-through date, never a supplier-derived flag. */
export function validPaidUntil(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value &&
    value >= now.toISOString().slice(0, 10);
}
