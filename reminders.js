// ============================================================================
// REMINDERS — the part that actually protects revenue.
//
// A reseller doesn't lose customers to bad VPNs. They lose them to a
// subscription that quietly expired, a student who didn't know why it stopped,
// and a message that arrived two weeks late.
//
// Design constraints that shaped this file:
//
//  1. IDEMPOTENT. Reminders fire from a cron. A cron that runs every hour must
//     not send the same "7 days left" message 168 times. State is persisted per
//     (token, kind, date), so a reminder fires once per kind per day.
//
//  2. NO CUSTOMER PII REQUIRED. The channel is *yours* (your Telegram, your
//     webhook). Student contact details never need to be stored — you message
//     them yourself. Optional per-customer webhooks are supported for later.
//
//  3. CHANNELS ARE SWAPPABLE AND TESTABLE. `console` and `webhook` need no
//     credentials, so the whole path is covered by tests.
//
//  4. ONE FAILURE ≠ EVERYTHING STOPS. A dead Telegram token must not prevent
//     the rest of the reminders from being recorded and delivered.
// ============================================================================

export const DEFAULT_THRESHOLDS = [30, 14, 7, 3, 1];

const DAY_MS = 86400000;

/** Whole days from today (UTC midnight) to an expiry date. null if unknown. */
export function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const t = Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(t)) return null;
  const today = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.round((t - today) / DAY_MS);
}

/**
 * Build a channel from config. `config` comes from env or an explicit override.
 *   channel=telegram  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   channel=webhook   WEBHOOK_URL            (POST JSON: {text, meta})
 *   channel=console   logs; no credentials needed
 */
export function makeChannel(config = {}) {
  const kind = (config.channel || "console").toLowerCase();

  if (kind === "telegram") {
    const token = config.telegramBotToken, chat = config.telegramChatId;
    if (!token || !chat) throw new Error("telegram channel needs token + chat id");
    return {
      name: "telegram",
      async send(text) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        });
        if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      },
    };
  }

  if (kind === "webhook") {
    const url = config.webhookUrl;
    if (!url) throw new Error("webhook channel needs WEBHOOK_URL");
    return {
      name: "webhook",
      async send(text, meta) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...meta }),
        });
        if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      },
    };
  }

  return {
    name: "console",
    async send(text) {
      console.log("\n[reminder]\n" + text.split("\n").map((l) => "  " + l).join("\n") + "\n");
    },
  };
}

const money = (r) => (r.price == null ? "" : `${r.currency || ""} ${Number(r.price).toFixed(2)}`.trim());

/** Who is this about — prefer the real name, fall back to label, then token. */
const who = (r) => r.customer || r.label || `${r.token.slice(0, 10)}…`;

/**
 * The message text for one reminder. Exported so tests can assert on wording
 * and so a future customer-facing channel can reuse it.
 */
export function messageFor(kind, row, days) {
  const id = who(row);
  const tail = row.paid_until ? `\nPaid until: ${row.paid_until}` : "";
  const quota = row.total_gb ? `\nQuota: ${Math.max(0, row.total_gb - (row.used_gb || 0)).toFixed(1)} / ${row.total_gb} GB left` : "";

  switch (kind) {
    case "expired":
      return `🔴 ${id} — subscription EXPIRED ${-days} day${-days === 1 ? "" : "s"} ago (${row.supplier_expires}).
Their VPN is down right now. Renew with the supplier and send a fresh link.
Plan: ${row.plan || "—"} · ${money(row) || "no price set"}${quota}${tail}`;
    case "unpaid":
      return `💸 ${id} — payment overdue since ${row.paid_until} (${-days} day${-days === 1 ? "" : "s"}).
Plan: ${row.plan || "—"} · ${money(row) || "no price set"}${tail}`;
    case "unknown":
      return `❔ ${id} — no expiry on record.
Open the dashboard and run ⟳ Refresh quota, or set it by hand. An unknown expiry can hide a renewal.`;
    case "legacy":
      return `🔓 ${id} — still on a LEGACY link (base64 token).
It cannot be revoked and it still encodes your supplier URL. Rotate it to an opaque link.`;
    default: {
      // expiry_<N>
      return `⏳ ${id} — expires in ${days} day${days === 1 ? "" : "s"} (${row.supplier_expires}).
Plan: ${row.plan || "—"} · ${money(row) || "no price set"}${quota}${tail}`;
    }
  }
}

/**
 * Decide what needs saying. Pure function — no I/O, no sending.
 * Returns [{ token, kind, days, text }].
 */
export function dueReminders(rows, { thresholds = DEFAULT_THRESHOLDS, includeLegacy = true } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.revoked) continue;

    const d = daysUntil(r.supplier_expires);
    if (d === null) {
      out.push({ token: r.token, kind: "unknown", days: null, text: messageFor("unknown", r, null) });
    } else if (d < 0) {
      out.push({ token: r.token, kind: "expired", days: d, text: messageFor("expired", r, d) });
    } else {
      // Pick the tightest threshold this row has crossed, so a link that jumps
      // from 20 days to 5 days between runs still fires exactly one reminder.
      const hit = [...thresholds].sort((a, b) => a - b).filter((t) => d <= t)[0];
      if (hit !== undefined) {
        out.push({ token: r.token, kind: `expiry_${hit}`, days: d, text: messageFor(`expiry_${hit}`, r, d) });
      }
    }

    const p = daysUntil(r.paid_until);
    if (p !== null && p < 0) {
      out.push({ token: r.token, kind: "unpaid", days: p, text: messageFor("unpaid", r, p) });
    }

    if (includeLegacy && r.legacy) {
      out.push({ token: r.token, kind: "legacy", days: null, text: messageFor("legacy", r, null) });
    }
  }
  return out;
}

/**
 * Run a full pass: refresh quota, decide what's due, send what hasn't been
 * sent, record it.
 *
 * `deps` is injected so tests can run the real logic with fake channels and a
 * fake store:
 *   listAll, updateRow, hasBeenSent, markSent  — from the token store
 *   fetchSubscription, quotaSummary            — from the worker
 *   channel                                    — from makeChannel()
 */
export async function runReminders(deps, opts = {}) {
  const {
    listAll, updateRow, hasBeenSent, markSent,
    fetchSubscription, quotaSummary, channel,
    refresh = true, concurrency = 6,
    thresholds = DEFAULT_THRESHOLDS,
    now = new Date(),
  } = deps;

  const dateKey = now.toISOString().slice(0, 10);
  const result = { refreshed: 0, refreshFailed: 0, sent: [], skipped: [], failed: [] };

  let rows = (await listAll()).filter((r) => !r.revoked);

  // 1. Pull live expiry + quota from the supplier. Bounded concurrency: the
  //    supplier panel must not see a burst just because the cron fired.
  if (refresh) {
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      await Promise.all(batch.map(async (r) => {
        try {
          const { status } = await fetchSubscription(r.supplier_url);
          const s = quotaSummary(status);
          if (!s) { result.refreshFailed++; return; }
          await updateRow(r.token, {
            supplier_expires: s.exp,
            total_gb: s.tot,
            used_gb: Math.round((s.up + s.down) * 100) / 100,
            checked_at: new Date().toISOString(),
          });
          result.refreshed++;
        } catch (e) {
          result.refreshFailed++;
        }
      }));
    }
    rows = (await listAll()).filter((r) => !r.revoked);
  }

  // 2. Decide, then send only what is new.
  for (const due of dueReminders(rows, { thresholds })) {
    if (await hasBeenSent(due.token, due.kind, dateKey)) {
      result.skipped.push({ token: due.token, kind: due.kind, reason: "already sent today" });
      continue;
    }
    try {
      await channel.send(due.text, { token: due.token, kind: due.kind, days: due.days, date: dateKey });
      await markSent(due.token, due.kind, dateKey, due.text);
      result.sent.push({ token: due.token, kind: due.kind, days: due.days });
    } catch (e) {
      // Do NOT mark it sent — the next run retries. But do not abort the pass
      // either: one bad channel must not hide the other customers' renewals.
      result.failed.push({ token: due.token, kind: due.kind, error: String(e.message || e).slice(0, 200) });
    }
  }

  return result;
}


/**
 * Convenience wiring for a runtime that provides `env` (Workers cron, a
 * serverless handler). Builds the backend + channel from env and runs a pass.
 *
 *   REMINDER_CHANNEL=telegram|webhook|console     (default console)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   WEBHOOK_URL
 *   REMINDER_THRESHOLDS="30,14,7,3,1"
 *   REMINDER_INCLUDE_LEGACY=1                     (default on)
 */
export async function runRemindersFromEnv(env, store, worker) {
  const cfg = {
    channel: env.REMINDER_CHANNEL || "console",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    webhookUrl: env.WEBHOOK_URL,
  };
  const thresholds = (env.REMINDER_THRESHOLDS || "")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return runReminders({
    listAll: store.listAll,
    updateRow: store.updateRow,
    hasBeenSent: store.hasBeenSent,
    markSent: store.markSent,
    fetchSubscription: worker.fetchSubscription,
    quotaSummary: worker.quotaSummary,
    channel: makeChannel(cfg),
    thresholds: thresholds.length ? thresholds : DEFAULT_THRESHOLDS,
    refresh: env.REMINDER_REFRESH !== "0",
  }, {});
}
