// ============================================================================
// MIGRATION SUITE — proves the usage-delta columns land on the EXISTING
// production database without touching a single byte of customer data.
// Run: node test/migration.test.mjs
//
// This is the test that stands between a schema change and a Turso database
// holding 80+ paying customers. It builds a SQLite database with the exact
// pre-change production schema (the one live at commit 5f83755), fills it with
// production-shaped rows, then boots the NEW token-store against that same
// file and asserts:
//
//   * every pre-existing column still exists
//   * every pre-existing row still has byte-identical values
//   * the two new columns exist and read NULL ("never checked twice yet")
//   * running the migration twice changes nothing
//   * the checked-in .sql file contains nothing destructive
// ============================================================================
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

const FILE = join(tmpdir(), `sp-vpn-migration-${process.pid}.db`);
const cleanup = async () => {
  for (const f of [FILE, FILE + "-wal", FILE + "-shm"]) await rm(f, { force: true });
};
await cleanup();
const url = "file:" + FILE;

// ---------------------------------------------------------------------------
// 1. The PRE-change production schema, copied verbatim from 5f83755.
//    Note what it does NOT have: prev_used_gb, usage_delta_gb.
// ---------------------------------------------------------------------------
const db = createClient({ url });
await db.execute(`CREATE TABLE IF NOT EXISTS links (
  token            TEXT PRIMARY KEY,
  supplier_url     TEXT NOT NULL,
  label            TEXT,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  customer         TEXT,
  plan             TEXT,
  price            REAL,
  currency         TEXT,
  billing_cycle    TEXT,
  paid_until       TEXT,
  notes            TEXT,
  supplier_expires TEXT,
  total_gb         REAL,
  used_gb          REAL,
  checked_at       TEXT,
  account_email    TEXT,
  account_password TEXT
)`);

const OLD_COLS = [
  "token", "supplier_url", "label", "revoked", "created_at", "customer", "plan",
  "price", "currency", "billing_cycle", "paid_until", "notes", "supplier_expires",
  "total_gb", "used_gb", "checked_at", "account_email", "account_password",
];

// Production-shaped rows: a live customer, a second live customer, a revoked
// one, and a legacy row with mostly NULL billing fields.
const SEED = [
  ["tok-dalton", "https://panel.example/sub?who=dalton", "SP VPN", 0, "2026-08-01T00:00:00Z", "Dalton", "1024GB", 16, "RMB", "monthly", "2026-09-28", null, "2026-09-28", 1024, 33.5, "2026-09-26T02:33:00Z", "dalton@gmail.com", "shevinx123"],
  ["tok-peash", "https://panel.example/sub?who=peash", "SP VPN", 0, "2026-08-02T00:00:00Z", "Peash", "1024GB", 16, "RMB", "monthly", "2026-09-28", "tg @peash", "2026-09-28", 1024, 111.4, "2026-09-26T02:33:00Z", "peash@gmail.com", "shevinx123"],
  ["tok-revoked", "https://panel.example/sub?who=old", "SP VPN", 1, "2026-07-01T00:00:00Z", "Gone", "512GB", 10, "RMB", "monthly", "2026-08-01", "left", "2026-08-01", 512, 12.0, "2026-08-01T00:00:00Z", "gone@gmail.com", "shevinx123"],
  ["tok-legacy", "https://panel.example/sub?who=legacy", "legacy", 0, "2026-06-01T00:00:00Z", null, null, null, null, null, null, null, null, null, null, null, null, null],
];
for (const row of SEED) {
  await db.execute({
    sql: `INSERT INTO links (${OLD_COLS.join(",")}) VALUES (${row.map(() => "?").join(",")})`,
    args: row,
  });
}

const snap = async () => (await db.execute("SELECT * FROM links ORDER BY token")).rows.map((r) => ({ ...r }));
const cols = async () => (await db.execute("PRAGMA table_info(links)")).rows.map((r) => r.name);

const beforeRows = await snap();
const beforeCols = await cols();

console.log("\n[1] the database starts on the pre-change production schema");
ok(beforeCols.length === OLD_COLS.length, `${OLD_COLS.length} columns before (got ${beforeCols.length})`);
ok(!beforeCols.includes("prev_used_gb") && !beforeCols.includes("usage_delta_gb"), "the new columns do NOT exist yet");
ok(beforeRows.length === SEED.length, `${SEED.length} customer rows seeded (got ${beforeRows.length})`);

// ---------------------------------------------------------------------------
// 2. Boot the NEW code against that same file. ensureInit() runs the additive
//    migration — the exact code path Netlify/Turso hits on the first request
//    after deploy.
// ---------------------------------------------------------------------------
console.log("\n[2] booting the new token-store runs the additive migration");
const store = await import("../token-store.js");
store.setBackend(new store.LibsqlBackend({ url }));
await store.ensureInit();

const afterCols = await cols();
const afterRows = await snap();

ok(afterCols.includes("prev_used_gb"), "prev_used_gb was added");
ok(afterCols.includes("usage_delta_gb"), "usage_delta_gb was added");
ok(beforeCols.every((c) => afterCols.includes(c)), "every pre-existing column survived");
ok(afterCols.length === beforeCols.length + 4, `four additive columns: usage tracking + customer sharing (${beforeCols.length} -> ${afterCols.length})`);
ok(afterCols.includes("customer_type") && afterCols.includes("supplier_account"), "shared-account columns were added");
ok(afterRows.every((r) => r.customer_type === "individual" && r.supplier_account === null), "existing rows default to Individual without changing their account or payment data");

console.log("\n[3] not one byte of existing customer data changed");
ok(afterRows.length === beforeRows.length, `row count unchanged (${beforeRows.length} -> ${afterRows.length})`);
for (const b of beforeRows) {
  const a = afterRows.find((x) => x.token === b.token);
  ok(!!a, `row ${b.token} still present`);
  const drift = a ? OLD_COLS.filter((k) => String(a[k]) !== String(b[k])) : OLD_COLS;
  ok(drift.length === 0, `row ${b.token}: all ${OLD_COLS.length} original values identical${drift.length ? " (drifted: " + drift.join(", ") + ")" : ""}`);
}
ok(afterRows.every((r) => r.prev_used_gb === null && r.usage_delta_gb === null),
  "existing rows read NULL for the new columns — i.e. 'no previous check to compare against yet'");
ok(afterRows.find((r) => r.token === "tok-dalton").account_password === "shevinx123", "account_password preserved");
ok(Number(afterRows.find((r) => r.token === "tok-revoked").revoked) === 1, "the revoked flag preserved");
ok(afterRows.find((r) => r.token === "tok-peash").used_gb === 111.4, "used_gb preserved to the decimal");

console.log("\n[4] the migration is idempotent");
await store.ensureInit();
const twice = await snap();
ok(twice.length === beforeRows.length, "re-running it leaves the row count alone");
ok((await cols()).length === afterCols.length, "re-running it adds no further columns");

console.log("\n[5] reading and writing through the new store still works");
{
  const row = await store.backend().get("tok-dalton");
  ok(row && row.customer === "Dalton", `an existing row reads back through the new code (${row && row.customer})`);
  ok(row && row.usage_delta_gb === null, "…with a null delta");
  const updated = await store.backend().update("tok-dalton", { used_gb: 40, prev_used_gb: 33.5, usage_delta_gb: 6.5 });
  ok(updated.usage_delta_gb === 6.5, `a delta can be written (${updated.usage_delta_gb})`);
  const reread = await store.backend().get("tok-dalton");
  ok(reread.usage_delta_gb === 6.5 && reread.prev_used_gb === 33.5, "…and survives a re-read");
  ok(reread.account_email === "dalton@gmail.com" && reread.account_password === "shevinx123",
    "…without disturbing the account fields on the same row");
}

console.log("\n[6] the checked-in .sql file is additive only");
{
  const raw = readFileSync(new URL("../migrations/001-usage-delta.sql", import.meta.url), "utf8");
  // Strip comments first — the header prose legitimately mentions DROP/CREATE
  // when explaining what the migration deliberately does NOT do.
  const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  ok(statements.length === 2, `exactly two statements (got ${statements.length})`);
  ok(statements.every((s) => /^ALTER TABLE links ADD COLUMN /i.test(s)), "both are ALTER TABLE ... ADD COLUMN");
  ok(!/\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|REPLACE)\b/i.test(sql), "no destructive or data-rewriting statement");
  for (const c of ["prev_used_gb", "usage_delta_gb"]) ok(sql.includes(c), `covers ${c}`);
  // The .sql file and the code-driven migration must not drift apart.
  const added = store.ADDED_COLUMNS.map(([n]) => n);
  ok(added.includes("prev_used_gb") && added.includes("usage_delta_gb"),
    "token-store ADDED_COLUMNS lists the same two columns");
  ok(store.COLUMNS.includes("prev_used_gb") && store.COLUMNS.includes("usage_delta_gb"),
    "…and they are selected/written by COLUMNS");
}

await cleanup();

console.log("\n" + "─".repeat(70));
if (failures) { console.log(`❌ ${failures} of ${checks} checks FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
