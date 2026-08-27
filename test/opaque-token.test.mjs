// ============================================================================
// OPAQUE-TOKEN SUITE — proves the supplier-leak fix, and proves migration is
// safe for links already in students' hands.
//
// Run: node test/opaque-token.test.mjs
// ============================================================================
import worker from "../sp-vpn-worker.js";
import * as store from "../token-store.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

// ---- fixtures: a supplier panel we control ----
const SUPPLIER_URL = "https://airport-panel.example.com/api/v1/client/subscribe?token=SUPER-SECRET-abc123";
const enc = encodeURIComponent;
const SUPPLIER_BODY = [
  "STATUS=↑:1.23GB,↓:45.67GB,TOT:200GB Expires:2027-01-01",
  "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联01"),
  "vless://22222222-2222-4222-8222-222222222222@hk2.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#" + enc("新加坡•电信01"),
].join("\n");
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) =>
  String(u).startsWith("https://airport-panel.example.com") ? new Response(SUPPLIER_BODY) : realFetch(u, o);

store.setBackend(new store.MemoryBackend());
await store.ensureInit();

const HOST = "https://sp.example.com";
const get = (path, ua) =>
  worker.fetch(new Request(HOST + path, { headers: ua ? { "User-Agent": ua } : {} }), {}, {});
const post = (path, form) =>
  worker.fetch(new Request(HOST + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  }), {}, {});

const b64e = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
};

console.log("\n[1] /tool now issues OPAQUE tokens");
{
  const r = await post("/tool", { brand: "SP VPN", links: SUPPLIER_URL });
  const html = await r.text();
  ok(r.status === 200, `/tool returned 200 (got ${r.status})`);
  const tok = (html.match(/\?t=([0-9a-f]{48})/i) || [])[1];
  ok(!!tok, "one-link contains a 48-hex opaque token");
  ok(store.isOpaque(tok), "token passes isOpaque()");
  ok(!html.includes("airport-panel.example.com"), "supplier host does NOT appear anywhere in the seller page");
  ok(!html.includes("SUPER-SECRET-abc123"), "supplier secret does NOT appear anywhere in the seller page");

  console.log("\n[2] A student CANNOT recover the supplier URL");
  ok(!tok.includes("aHR0"), "token has no base64 'http' signature");
  let decoded = null, threw = false;
  try { decoded = b64d(tok); } catch (e) { threw = true; }
  ok(threw || decoded !== SUPPLIER_URL, "base64-decoding the token does NOT yield the supplier URL");
  ok(threw || !decoded.includes("airport-panel.example.com"), "decoded garbage contains no supplier host");
  console.log(`     atob(token) -> ${threw ? "throws (not valid base64 of anything)" : JSON.stringify(decoded.slice(0, 40)) + "…"}`);
  ok(decoded === null || !/https?:\/\//.test(decoded), "no URL of any kind survives in the token");

  console.log("\n[3] The opaque one-link still works for real clients");
  const clash = await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7");
  const cy = await clash.text();
  ok(clash.status === 200, `Clash gets 200 YAML (got ${clash.status})`);
  ok(cy.includes("hk1.example.com"), "YAML contains the real node (hk1.example.com)");
  ok(cy.includes("proxies:"), "YAML is a valid mihomo profile");
  const sr = await get(`/all/SP%20VPN?t=${tok}`, "Shadowrocket/2.2.32");
  const srBody = Buffer.from(await sr.text(), "base64").toString("utf8");
  ok(sr.status === 200, `Shadowrocket gets 200 (got ${sr.status})`);
  ok(srBody.includes("vless://"), "SR payload contains vless nodes");
  const quota = await get(`/q/${tok}`, null);
  const qhtml = await quota.text();
  ok(quota.status === 200, `/q/ quota page 200 (got ${quota.status})`);
  ok(qhtml.includes("GB left"), "quota page renders live GB");
  ok(!qhtml.includes("airport-panel.example.com"), "quota page does not leak the supplier host");
}

console.log("\n[4] MIGRATION SAFETY — legacy base64 links still work");
{
  const LEGACY = b64e(SUPPLIER_URL);
  ok(!store.isOpaque(LEGACY), "legacy token is not mistaken for an opaque one");
  const resolved = await store.resolve(LEGACY);
  ok(resolved === SUPPLIER_URL, "store.resolve() maps legacy token -> exact supplier URL");
  const r = await get(`/all/SP%20VPN?t=${LEGACY}`, "clash-verge/1.7.7");
  ok(r.status === 200, `legacy one-link still returns 200 (got ${r.status}) — existing students unaffected`);
  const q = await get(`/q/${LEGACY}`, null);
  ok(q.status === 200, `legacy /q/ page still 200 (got ${q.status})`);
}

console.log("\n[5] REVOCATION — the capability base64 tokens never had");
{
  const tok = await store.mint(SUPPLIER_URL, "student-to-revoke");
  ok((await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7")).status === 200, "fresh token works before revocation");
  await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7"); // warm the worker cache
  await store.updateRow(tok, { revoked: true });
  const after = await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7");
  const afterBody = await after.text();
  ok(after.status !== 200, `revoked token stops serving nodes IMMEDIATELY, despite a warm cache (got ${after.status})`);
  ok(afterBody.includes("revoked"), "error explains it was revoked");

  // Honest limitation, documented on purpose: a legacy base64 token carries its
  // own URL, so there is nothing to look up and nothing to revoke. This is the
  // reason to migrate students onto opaque tokens at renewal time.
  const LEGACY = b64e(SUPPLIER_URL);
  const legacyAfter = await get(`/all/SP%20VPN?t=${LEGACY}`, "clash-verge/1.7.7");
  ok(legacyAfter.status === 200, "legacy tokens CANNOT be revoked (by design) — migrate them");
}

console.log("\n[6] ROTATION — old link dies, new one works");
{
  const old = await store.mint(SUPPLIER_URL, "student-to-rotate");
  const rot = await get("/admin/link/" + old + "?action=rotate", null); // GET route
  const j = JSON.parse(await rot.text());
  ok(rot.status === 200 && !!j.newToken, "rotate returns a new token");
  ok(j.newToken !== old, "new token differs from old");
  ok((await get(`/all/SP%20VPN?t=${old}`, "clash-verge/1.7.7")).status !== 200, "OLD link is dead");
  ok((await get(`/all/SP%20VPN?t=${j.newToken}`, "clash-verge/1.7.7")).status === 200, "NEW link works");
}

console.log("\n[7] ADMIN API");
{
  const minted = await post("/admin/mint", { link: SUPPLIER_URL, label: "Ali — 3mo plan" });
  const jm = JSON.parse(await minted.text());
  ok(minted.status === 200 && store.isOpaque(jm.token), "POST /admin/mint returns an opaque token");
  ok(jm.oneLink.includes(jm.token), "mint returns a ready-to-send one-link");

  const list = await get("/admin/links", null);
  const jl = JSON.parse(await list.text());
  ok(list.status === 200, `GET /admin/links 200 (got ${list.status})`);
  ok(jl.count > 0, `admin list reports ${jl.count} stored links`);
  ok(jl.links.every((r) => !("supplier_url" in r)), "admin list NEVER exposes supplier_url");
  ok(jl.links.every((r) => !JSON.stringify(r).includes("SUPER-SECRET")), "no supplier secret anywhere in admin output");
  ok(jl.links.some((r) => r.supplier_host === "airport-panel.example.com"), "shows supplier HOST only (enough to identify, not to reuse)");
  ok(jl.links.some((r) => r.label === "Ali — 3mo plan"), "label persisted");

  const bad = await post("/admin/mint", { link: "not a link" });
  ok(bad.status === 400, `rejects a non-link with 400 (got ${bad.status})`);

  const unknown = await get(`/admin/link/${"0".repeat(48)}?action=revoke`, null);
  ok(unknown.status === 404, `unknown token -> 404 (got ${unknown.status})`);
}

console.log("\n[8] CACHE RESILIENCE — DB outage must not kill students");
{
  const tok = await store.mint(SUPPLIER_URL, "cache-test");
  await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7"); // warm the cache
  // simulate the backend going away entirely
  const broken = new store.MemoryBackend();
  broken.get = async () => { throw new Error("simulated DB outage"); };
  broken.init = async () => {};
  store.setBackend(broken);
  const r = await get(`/all/SP%20VPN?t=${tok}`, "clash-verge/1.7.7");
  ok(r.status === 200, `stale-cache fallback served the student through a DB outage (got ${r.status})`);
  store.setBackend(new store.MemoryBackend());
}

console.log("\n" + "─".repeat(70));
if (failures) {
  console.log(`❌ ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
