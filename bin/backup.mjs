// Back up / restore the customer registry as plain JSON.
//
// Why this exists: moving to a new repo, a new Netlify site or a new Turso
// database should never be a leap of faith. Dump first, deploy second.
//
//   # dump the live database to a file
//   TOKEN_STORE_URL=libsql://old.turso.io TOKEN_STORE_AUTH_TOKEN=... \
//     npm run backup > customers.json
//
//   # load it into a brand-new database
//   TOKEN_STORE_URL=libsql://new.turso.io TOKEN_STORE_AUTH_TOKEN=... \
//     node bin/backup.mjs --restore customers.json
//
// Restore is additive and idempotent: it INSERTs rows that are missing and
// UPDATEs rows whose token already exists. It never drops or empties a table.
//
// ⚠ The dump contains supplier_url and account_password in clear text — it is
// the single most sensitive file this project can produce. Keep it out of git
// (.gitignore covers *.backup.json) and off shared drives.
import { readFileSync } from "node:fs";
import * as store from "../token-store.js";

const args = process.argv.slice(2);
const restoreAt = args.indexOf("--restore");
const url = process.env.TOKEN_STORE_URL;

if (!url) {
  console.error("TOKEN_STORE_URL is not set — there is nothing to back up.");
  console.error('  example: TOKEN_STORE_URL="libsql://your-db.turso.io" TOKEN_STORE_AUTH_TOKEN="…" npm run backup');
  process.exit(1);
}

store.setBackend(new store.LibsqlBackend({ url, authToken: process.env.TOKEN_STORE_AUTH_TOKEN }));
await store.ensureInit();

if (restoreAt === -1) {
  // ---- dump -----------------------------------------------------------
  const rows = await store.listAll();
  process.stdout.write(JSON.stringify({
    exported_at: new Date().toISOString(),
    store: store.backend().name,
    columns: store.COLUMNS,
    count: rows.length,
    links: rows,
  }, null, 2) + "\n");
  console.error(`✅ dumped ${rows.length} customers from ${store.backend().name}`);
} else {
  // ---- restore --------------------------------------------------------
  const file = args[restoreAt + 1];
  if (!file) { console.error("usage: node bin/backup.mjs --restore <file.json>"); process.exit(1); }

  const data = JSON.parse(readFileSync(file, "utf8"));
  const links = Array.isArray(data) ? data : data.links;
  if (!Array.isArray(links)) { console.error("that file has no `links` array"); process.exit(1); }

  const backend = store.backend();
  let inserted = 0, updated = 0;
  for (const row of links) {
    if (!row || !row.token) continue;
    const existing = await backend.get(row.token);
    if (existing) { await backend.update(row.token, row); updated++; }
    else { await backend.put({ ...row, revoked: row.revoked ? 1 : 0 }); inserted++; }
  }
  const total = (await store.listAll()).length;
  console.error(`✅ restored into ${backend.name}: ${inserted} inserted, ${updated} updated — ${total} customers now present`);
}
