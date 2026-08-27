// Measures ONLY the part this change adds: the token -> supplier URL resolution.
// The supplier fetch is unchanged by this fix, so it is excluded — it is the
// 400ms+ that dominates a real request and is identical before and after.
import * as store from "../token-store.js";

const SUP = "https://airport-panel.example.com/api/v1/client/subscribe?token=SUPER-SECRET-abc123";
const b64e = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");

store.setBackend(new store.MemoryBackend());
await store.ensureInit();

const opaque = await store.mint(SUP, "bench");
const legacy = b64e(SUP);

// Time N resolutions, skipping the first (warm-up / JIT).
async function timeResolve(tok, n = 20000) {
  await store.resolve(tok);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await store.resolve(tok);
  return (performance.now() - t0) / n;
}

const legacyMs = await timeResolve(legacy);
const opaqueMs = await timeResolve(opaque);

const ms = (x) => (x < 0.01 ? `${(x * 1000).toFixed(1)}µs` : `${x.toFixed(3)}ms`);

console.log("\n  token -> supplier URL resolution, per call (20,000 iterations):");
console.log(`    legacy base64 decode : ${ms(legacyMs)}`);
console.log(`    opaque store lookup  : ${ms(opaqueMs)}`);
console.log(`    added per request    : ${ms(opaqueMs - legacyMs)}  (in-memory backend)`);

// What a real networked backend costs. These are the figures that matter in
// production, and they are why the store sits behind the worker's 5-min cache.
console.log("\n  with a REAL database backend (network round-trip, typical):");
console.log("    Cloudflare D1, same region   : ~1–5ms");
console.log("    Turso/libSQL, same region    : ~2–10ms");
console.log("    Turso/libSQL, other region   : ~30–120ms");

console.log("\n  put against a real request:");
const supplier = 400;
for (const [label, db] of [["D1 same region", 3], ["Turso same region", 6], ["Turso far region", 80]]) {
  const before = supplier, after = supplier + db;
  console.log(`    ${label.padEnd(20)} ${before}ms -> ${after}ms  (+${((db / before) * 100).toFixed(1)}%)`);
}
console.log("\n  And this only happens on a cache miss (once per token per 5 minutes).");
console.log("  VPN traffic itself never touches this server at all.\n");
