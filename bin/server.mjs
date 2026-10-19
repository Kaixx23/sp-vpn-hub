// Local dev server: `npm run dev`, then open http://localhost:8787/tool
// Uses a SQLite file so data survives restarts. In production use Turso or D1.
import { createServer } from "node:http";
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";

process.env.TOKEN_STORE_URL ||= "file:tokens.db";
store.setBackend(new store.LibsqlBackend({ url: process.env.TOKEN_STORE_URL, authToken: process.env.TOKEN_STORE_AUTH_TOKEN }));
await store.ensureInit();
console.log(`token store: ${store.backend().name} (${process.env.TOKEN_STORE_URL})`);

const PORT = Number(process.env.PORT || 8787);
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
  // Preserve the browser-facing host so copied/shared links also work through
  // a preview proxy. localhost here would point at the user's own computer.
  const headers = new Headers(req.headers);
  const proto = (headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (headers.get("x-forwarded-host") || headers.get("host") || `localhost:${PORT}`).split(",")[0].trim();
  const url = `${proto}://${host}${req.url}`;
  headers.set("x-forwarded-proto", proto);
  const r = await worker.fetch(new Request(url, { method: req.method, headers, body }), {}, {});
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await r.text());
}).listen(PORT, "0.0.0.0", () => {
  console.log(`\n  seller tool   http://localhost:${PORT}/tool`);
  console.log(`  admin list    http://localhost:${PORT}/admin/links`);
  console.log(`  mint a link   curl -d "link=https://YOUR-SUPPLIER&label=Ali" http://localhost:${PORT}/admin/mint\n`);
});
