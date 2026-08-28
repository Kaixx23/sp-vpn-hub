// ============================================================================
// PLANS — the reseller's plan catalogue: prices, costs and profit in ONE place.
//
//   512GB:  cost 4 RMB  ->  sell 12 RMB  ->  8 RMB profit / month
//   1024GB: cost 6 RMB  ->  sell 16 RMB  ->  10 RMB profit / month
//
// The key is the quota in GB exactly as the supplier reports it (TOT:512GB).
// /admin/inspect uses this to auto-fill pricing in the Add-customer form;
// summarise()/redact() use it to compute profit for the dashboard.
//
// Profit is derived at read time (price the customer pays minus the catalogue
// cost of their plan), so every existing row shows profit immediately with no
// migration, and selling a plan at a custom price still computes correctly.
// Change prices/costs here when your supplier's prices change.
// ============================================================================

export const PLAN_CATALOG = {
  512: { price: 12, cost: 4, currency: "RMB", billing_cycle: "monthly" },
  1024: { price: 16, cost: 6, currency: "RMB", billing_cycle: "monthly" },
};

// The shared password the reseller uses for the supplier-panel accounts they
// create per customer. Pre-filled in the Add-customer form; change it here if
// the scheme ever changes.
export const PANEL_PASSWORD_DEFAULT = "shevinx123";

/** The catalogue entry for a quota in GB (as the supplier reports it), or null. */
export function planFor(quotaGb) {
  if (quotaGb == null || quotaGb === "") return null;
  const q = Number(quotaGb);
  return PLAN_CATALOG[q] || null;
}

/**
 * Per-cycle profit for a customer row: what they pay minus the catalogue cost
 * of their plan. Only computed when the row's quota matches a catalogue plan
 * AND the currency + billing cycle line up — anything else is unknown (null),
 * never a wrong number. Revoked rows are filtered by the caller.
 */
export function profitOf(row) {
  const plan = planFor(row && row.total_gb);
  if (!plan || row.price == null) return null;
  if (row.currency && row.currency !== plan.currency) return null;
  if (row.billing_cycle && row.billing_cycle !== plan.billing_cycle) return null;
  const p = Number(row.price) - plan.cost;
  return Number.isFinite(p) ? Math.round(p * 100) / 100 : null;
}
