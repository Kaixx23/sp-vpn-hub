// Run the additive schema migration against whatever TOKEN_STORE_URL points at
// (Turso, a local SQLite file, or nothing at all -> in-memory).
//
//   TOKEN_STORE_URL=libsql://your-db.turso.io \
//   TOKEN_STORE_AUTH_TOKEN=... \
//   npm run migrate
//
// This is the SAME code path the worker runs on boot, so running it by hand is
// optional — it just lets you migrate Turso before the new build goes live and
// see the result instead of trusting it happened.
//
// Additive only: CREATE TABLE IF NOT EXISTS + ALTER TABLE ... ADD COLUMN for
// anything missing. No table is dropped or recreated and no row is rewritten.
import * as store from "../token-store.js";

const url = process.env.TOKEN_STORE_URL;
if (!url) {
  console.error("TOKEN_STORE_URL is not set — refusing to 'migrate' an in-memory store.");
  console.error('  example: TOKEN_STORE_URL="libsql://your-db.turso.io" TOKEN_STORE_AUTH_TOKEN="…" npm run migrate');
  process.exit(1);
}

store.setBackend(new store.LibsqlBackend({ url, authToken: process.env.TOKEN_STORE_AUTH_TOKEN }));
await store.ensureInit();

const db = store.backend().db;
const info = await db.execute("PRAGMA table_info(links)");
const have = new Set(info.rows.map((r) => r.name));
const missing = store.COLUMNS.filter((c) => !have.has(c));

const count = await db.execute("SELECT COUNT(*) AS n FROM links");

console.log(`store    : ${store.backend().name}`);
console.log(`columns  : ${[...have].join(", ")}`);
console.log(`customers: ${count.rows[0].n} (untouched)`);

if (missing.length) {
  console.error(`\n❌ still missing after migrate: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("\n✅ schema is up to date — prev_used_gb and usage_delta_gb are present, no data was modified.");
