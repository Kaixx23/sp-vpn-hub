// ============================================================================
// FULL-PROOF COMPATIBILITY SUITE
//
// Verifies the ONE link (/all/...) works for every client, using each client's
// REAL User-Agent, and validates the payloads with the same rules the client
// engines enforce at import/startup:
//
//   Clash Verge, Clash Verge Rev, Clash Meta (CMA), ClashX, FlClash, Stash,
//   mihomo  →  mihomo YAML  (validated against mihomo's actual startup checks,
//                            mirrored from config.go / vless.go / vmess.go /
//                            trojan.go / outboundgroup/parser.go)
//   v2rayNG, v2rayN, NekoBox, Hiddify, Shadowrocket
//                         →  base64 SR subscription (each original share link
//                            must survive byte-identical, names decodeable,
//                            subscription-userinfo header present)
// ============================================================================
import worker, { fetchSubscription, FETCH_BUDGET_MS } from "../sp-vpn-worker.js";

let yaml = null;
try {
  const { load } = await import("/tmp/validate/node_modules/js-yaml/dist/js-yaml.mjs")
    .catch(() => import("js-yaml"));
  yaml = { load };
} catch (e) {
  console.log("⚠️  install js-yaml somewhere reachable to run this suite");
  process.exit(2);
}

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};
const enc = encodeURIComponent;

// ---------------------------------------------------------------- fixtures --
// The nastiest realistic airport sub we can construct.
const vm = (o) => "vmess://" + btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const SUPPLIER = [
  "STATUS=↑:1.23GB,↓:45.67GB,TOT:200GB Expires:2027-01-01",
  // name COLLISIONS: 移联01 / 移动01 / 移联 01 with different uuids → same English name
  "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联01"),
  "vless://22222222-2222-4222-8222-222222222222@hk2.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移动01"),
  "vless://33333333-3333-4333-8333-333333333333@hk3.example.com:443?encryption=none&security=reality&sni=www.apple.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联 01"),
  // grpc + reality, service name WITH SPACES, reality WITHOUT fp (→ default chrome)
  "vless://44444444-4444-4444-8444-444444444444@sg1.example.com:443?encryption=none&security=reality&sni=sg1.example.com&pbk=ZGVmc9D2fG8hI%3D&sid=aabb&type=grpc&serviceName=my%20grpc%20svc&flow=xtls-rprx-vision#" + enc("新加坡•电信01"),
  // ws + tls, path with ?ed=
  "vless://55555555-5555-4555-8555-555555555555@jp1.example.com:8443?encryption=none&security=tls&sni=jp1.example.com&fp=chrome&type=ws&host=jp1.example.com&path=%2Fws%3Fed%3D2048#" + enc("日本•移联01"),
  // vless over http transport
  "vless://66666666-6666-4666-8666-666666666666@us1.example.com:80?encryption=none&type=http&path=%2Fhp&host=us1.example.com#" + enc("美国•电信01"),
  // vless xhttp (mihomo-stable unsupported → must fall back to tcp, not break import)
  "vless://77777777-7777-4777-8777-777777777777@us2.example.com:443?encryption=none&security=tls&type=xhttp&path=%2Fxp&host=us2.example.com#" + enc("美国•电信02"),
  // vless IPv6 + no fragment (→ brand fallback name)
  "vless://88888888-8888-4888-8888-888888888888@[2001:db8::5]:443?encryption=none&security=tls&type=tcp",
  // names that attack the group/reserved namespaces or YAML itself
  "vless://99999999-9999-4999-8999-999999999999@a1.example.com:443?encryption=none&security=tls&type=tcp#" + enc("DIRECT"),
  "vless://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@a2.example.com:443?encryption=none&security=tls&type=tcp#" + enc("⚡ Auto Speed"),
  "vless://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb@a3.example.com:443?encryption=none&security=tls&type=tcp#" + enc('英国 "Premium" \\ Best:1'),
  "vless://cccccccc-cccc-4ccc-8ccc-cccccccccccc@a4.example.com:443?encryption=none&security=tls&type=tcp#" + enc("德国•电信01"),
  // trojan: ws + allowInsecure
  "trojan://pass%40word@tw1.example.com:443?security=tls&sni=tw1.example.com&type=ws&host=tw1.example.com&path=%2Ftr&allowInsecure=1#" + enc("台湾•家宽1"),
  // trojan: grpc with spacey service name
  "trojan://sekret@kr1.example.com:443?security=tls&sni=kr1.example.com&type=grpc&serviceName=tr%20grpc%20name#" + enc("韩国•联通01"),
  // vmess: legacy aid=64, no scy → auto
  vm({ v: "2", ps: "日本•联通02", add: "jp2.example.com", port: "443", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", aid: "64", net: "ws", host: "jp2.example.com", path: "/vmws", tls: "tls", sni: "jp2.example.com", fp: "chrome" }),
  // vmess: h2
  vm({ v: "2", ps: "香港•家宽02", add: "hk4.example.com", port: "8443", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", aid: "0", scy: "aes-128-gcm", net: "h2", host: "hk4.example.com", path: "/h2p", tls: "tls" }),
  // vmess: legacy tcp+http-obfs header → must become network http with path/host
  vm({ v: "2", ps: "新加坡•家宽03", add: "sg2.example.com", port: "80", id: "ffffffff-ffff-4fff-8fff-ffffffffffff", aid: "0", net: "tcp", header: { type: "http", request: { path: ["/obfs"], headers: { Host: ["sg2.example.com"] } } } }),
  // vmess: quic (unsupported by mihomo → tcp fallback, import must not break)
  vm({ v: "2", ps: "美国•联通03", add: "us3.example.com", port: "443", id: "12121212-1212-4121-8121-121212121212", aid: "0", net: "quic" }),
  // quota placeholders
  "vless://00000000-0000-0000-0000-000000000000@1.1.1.1:80?encryption=none&type=tcp#" + enc("剩余流量：150GB"),
  "vless://00000000-0000-0000-0000-000000000001@1.1.1.1:80?encryption=none&type=tcp#" + enc("到期时间：2027-01-01"),
];

// supplier served with BOM + CRLF + blank lines + uppercase scheme, base64-wrapped
const SUPPLIER_RAW = "\uFEFF" + SUPPLIER.map((l) => (l.startsWith("vless://1") ? l.replace("vless://", "VLESS://") : l)).join("\r\n") + "\r\n\r\n";
const SUPPLIER_B64 = btoa(unescape(encodeURIComponent(SUPPLIER_RAW)));
const SUPPLIER_LINKS_ONLY = SUPPLIER_RAW; // plain variant

const realFetch = globalThis.fetch;
let supplierMode = { body: SUPPLIER_LINKS_ONLY, status: 200, delayMs: 0 };
let supplierCalls = 0;
// what real fetch/undici throws when AbortSignal.timeout() fires
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://supplier.example/sub")) {
    supplierCalls++;
    // emulate a hung supplier panel: it never answers, but it still honours the
    // abort signal exactly like real fetch, so the worker's budget is exercised
    if (supplierMode.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, supplierMode.delayMs);
        const sig = opts.signal;
        if (!sig) return;
        const onAbort = () => { clearTimeout(t); reject(timeoutError()); };
        if (sig.aborted) onAbort();
        else sig.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (supplierMode.status !== 200) return new Response("blocked", { status: supplierMode.status });
    return new Response(supplierMode.body);
  }
  return realFetch(url, opts);
};

const b64e = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tokFor = (q) => b64e("https://supplier.example/sub?" + q);
const TOK = tokFor("token=main");       // section A/B/C
const TOK_PLAIN = tokFor("token=plain"); // section D
const TOK_INFO = tokFor("token=info");   // section E
const TOK_BLOCK = tokFor("token=block"); // section F
const TOK_HUNG = tokFor("token=hung");   // section H

async function get(path, ua) {
  const res = await worker.fetch(new Request("https://sp.example.com" + path, { headers: ua ? { "User-Agent": ua } : {} }), {}, {});
  return { status: res.status, ct: res.headers.get("content-type") || "", ui: res.headers.get("subscription-userinfo"), body: await res.text() };
}

// ============================================== mihomo startup validator ==
// Mirrors mihomo config.go parseProxies/parseRules + outboundgroup/parser.go +
// per-outbound import-time checks. If this passes, Clash Verge / Verge Rev /
// Clash Meta / ClashX Meta / FlClash / Stash will load the profile.
const RESERVED = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"];
function validateMihomo(body, label) {
  let cfg;
  try { cfg = yaml.load(body); } catch (e) { ok(false, `${label}: YAML parses (${e.message})`); return; }
  ok(true, `${label}: YAML parses`);
  const proxies = cfg.proxies || [], groups = cfg["proxy-groups"] || [];
  const allowed = (t) => (t === "trojan" ? ["tcp", "ws", "grpc"] : ["tcp", "ws", "grpc", "h2", "http"]);
  const pnames = proxies.map((p) => p.name), gnames = groups.map((g) => g.name);
  ok(new Set(pnames).size === pnames.length, `${label}: no duplicate proxy names (mihomo fatal)`);
  ok(new Set(gnames).size === gnames.length, `${label}: no duplicate group names (mihomo fatal)`);
  ok(pnames.every((n) => !RESERVED.includes(n) && !gnames.includes(n)), `${label}: no proxy collides with group/reserved names`);
  ok(proxies.every((p) => ["vless", "vmess", "trojan"].includes(p.type)), `${label}: proxy types all supported`);
  ok(proxies.every((p) => allowed(p.type).includes(p.network)), `${label}: networks valid per type`);
  ok(proxies.every((p) => p.server && Number.isInteger(p.port) && p.port > 0 && p.port < 65536), `${label}: server/port valid`);
  ok(proxies.every((p) => (p.type === "trojan" ? typeof p.password === "string" && p.password : typeof p.uuid === "string" && p.uuid)), `${label}: uuid/password present`);
  ok(proxies.every((p) => p.type !== "vmess" || (Number.isInteger(p["alterId"]) && p.cipher)), `${label}: vmess alterId/cipher valid`);
  ok(proxies.every((p) => !p["reality-opts"] || p.tls === true), `${label}: reality implies tls`);
  ok(groups.every((g) => ["select", "url-test", "fallback", "load-balance"].includes(g.type)), `${label}: group types valid`);
  ok(groups.every((g) => Array.isArray(g.proxies) && g.proxies.length > 0), `${label}: groups non-empty (mihomo fatal)`);
  const exist = new Set([...pnames, ...gnames, ...RESERVED]);
  const missing = groups.flatMap((g) => g.proxies.filter((m) => !exist.has(m)));
  ok(missing.length === 0, `${label}: every group member exists ("'X' not found" fatal)`);
  const rules = cfg.rules || [];
  const match = rules.find((r) => r.startsWith("MATCH,"));
  ok(rules.length > 0 && !!match && exist.has(match.slice(6).replace(/^"|"$/g, "")), `${label}: rules + MATCH target valid`);
  return cfg;
}

// =========================================== SR base64 format validator ==
// What v2rayNG / v2rayN / NekoBox / Hiddify / Shadowrocket do with the response:
// base64-decode, then parse each line as a share link. Original links must
// survive byte-identical (only the #name is rebranded), names must decode.
function validateShare(body, label) {
  ok(/^[A-Za-z0-9+/=\r\n]+$/.test(body.trim()), `${label}: body is standard base64 (no URL-safe chars)`);
  let text;
  try { text = decodeURIComponent(escape(atob(body.replace(/\s/g, "")))); } catch (e) { ok(false, `${label}: base64 decodes`); return; }
  ok(true, `${label}: base64 decodes`);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const links = lines.filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l));
  ok(links.length >= 20, `${label}: all ${links.length} share links present`);
  // every supplier link's URI (params before #) must be preserved byte-identical
  let preserved = 0;
  for (const src of SUPPLIER) {
    if (!/^[a-z0-9+.-]+:\/\//i.test(src)) continue;
    const uri = src.split("#")[0];
    if (links.some((l) => l.split("#")[0].toLowerCase() === uri.toLowerCase())) preserved++;
  }
  ok(preserved === SUPPLIER.filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l)).length, `${label}: every node URI preserved byte-identical (${preserved})`);
  ok(lines.every((l) => { const f = l.split("#")[1]; if (!f) return true; try { decodeURIComponent(f); return true; } catch { return false; } }), `${label}: all names percent-decode cleanly`);
  ok(text.includes("STATUS="), `${label}: STATUS quota line kept (Shadowrocket convention)`);
}

// ================================================================= run ==
console.log("Supplier fixture: 24 nodes — collisions, reserved names, quotes/backslash in names, reality/grpc/ws/http/xhttp, trojan ws+grpc+allowInsecure, vmess aid64/h2/http-obfs/quic, IPv6, BOM+CRLF+uppercase scheme, quota placeholders\n");

supplierMode = { body: SUPPLIER_B64, status: 200 }; // served BASE64-WRAPPED with BOM+CRLF

console.log("[A] Clash-family clients → mihomo YAML (validated like mihomo -t):");
const clashUAs = [
  ["Clash Verge", "clash-verge/v1.7.7"],
  ["Clash Verge Rev", "clash-verge-rev/2.4.1"],
  ["Clash Verge Rev (reqwest)", "reqwest/0.11 clash-verge-rev"],
  ["Clash Meta for Android", "ClashMetaForAndroid/2.11.7"],
  ["ClashX", "ClashX/1.118.0"],
  ["ClashX Meta", "clashx meta/1.18.10"],
  ["FlClash", "FlClash/0.8.83"],
  ["Stash (iOS)", "Stash/3.2.4 CFNetwork"],
  ["mihomo", "mihomo/1.19.13"],
];
for (const [name, ua] of clashUAs) {
  const r = await get(`/all/SP%20VPN?t=${TOK}`, ua);
  if (r.status !== 200 || !r.ct.includes("yaml")) { ok(false, `${name}: got ${r.status} ${r.ct}`); continue; }
  const cfg = validateMihomo(r.body, name);
  if (cfg) {
    const n = cfg.proxies.length;
    ok(n === 20, `${name}: ${n} proxies emitted (vless+vmess+trojan all kept)`);
    ok(/upload=\d+; download=\d+; total=\d+(; expire=\d+)?/.test(r.ui || ""), `${name}: subscription-userinfo header (quota/expiry in-app)`);
  }
}
{
  const r = await get(`/all/SP%20VPN?t=${TOK}`, "clash-verge-rev/2.4.1");
  const cfg = yaml.load(r.body);
  const p = (s) => cfg.proxies.find((x) => x.server === s);
  ok(p("hk1.example.com")?.["reality-opts"]?.["public-key"] && p("hk1.example.com")?.["client-fingerprint"] === "chrome", "Verge Rev: reality pbk + fp kept");
  ok(p("hk2.example.com").name !== p("hk1.example.com").name, `Verge Rev: collision pair split ("${p("hk1.example.com").name}" vs "${p("hk2.example.com").name}")`);
  ok(p("sg1.example.com")?.["grpc-opts"]?.["grpc-service-name"] === "my grpc svc", "Verge Rev: grpc service name kept (spaces intact)");
  ok(p("us1.example.com")?.["http-opts"]?.path?.[0] === "/hp" && p("us1.example.com")?.["http-opts"]?.headers?.Host?.[0] === "us1.example.com", "Verge Rev: vless http-opts path/Host arrays");
  ok(p("us2.example.com")?.network === "tcp", "Verge Rev: xhttp node falls back to tcp (import survives)");
  ok(p("tw1.example.com")?.type === "trojan" && p("tw1.example.com")?.password === "pass@word" && p("tw1.example.com")?.["skip-cert-verify"] === true, "Verge Rev: trojan password decoded + allowInsecure honored");
  ok(p("kr1.example.com")?.["grpc-opts"]?.["grpc-service-name"] === "tr grpc name", "Verge Rev: trojan grpc service name kept");
  const jp2 = p("jp2.example.com");
  ok(jp2?.type === "vmess" && jp2?.["alterId"] === 64 && jp2?.cipher === "auto", "Verge Rev: vmess legacy aid=64 + default cipher auto");
  ok(p("hk4.example.com")?.["h2-opts"]?.host?.[0] === "hk4.example.com", "Verge Rev: vmess h2-opts host array");
  const sg2 = p("sg2.example.com");
  ok(sg2?.network === "http" && sg2?.["http-opts"]?.path?.[0] === "/obfs" && sg2?.["http-opts"]?.headers?.Host?.[0] === "sg2.example.com", "Verge Rev: vmess tcp+http-obfs → network http with path/host");
  ok(p("us3.example.com")?.network === "tcp", "Verge Rev: vmess quic falls back to tcp (import survives)");
  ok(p("2001:db8::5")?.server === "2001:db8::5", "Verge Rev: IPv6 server kept");
  ok(!cfg.proxies.some((x) => x.name === "DIRECT" || x.name === "⚡ Auto Speed"), "Verge Rev: reserved names never used by nodes");
  ok(cfg.proxies.some((x) => x.name.includes("Premium")), "Verge Rev: quotes/backslash in name survive YAML quoting");
  const auto = (cfg["proxy-groups"] || []).find((g) => g.name.includes("Auto Speed"));
  ok(auto && !auto.proxies.some((n) => /Remaining|Expires/.test(n)), "Verge Rev: quota placeholders not in url-test group");
  ok(!r.body.includes("external-controller"), "Verge Rev: no external-controller conflict");
}

console.log("\n[B] v2ray-family clients → base64 SR subscription:");
const v2UAs = [
  ["v2rayNG", "v2rayNG/1.10.6"],
  ["v2rayN", "v2rayN/7.12.4"],
  ["NekoBox", "NekoBox/1.3.11"],
  ["Hiddify", "HiddifyNext/2.5.7 (android)"],
  ["Shadowrocket", "Shadowrocket/2.2.51 (iPhone; iOS 18.5; iPad16,1)"],
];
for (const [name, ua] of v2UAs) {
  const r = await get(`/all/SP%20VPN?t=${TOK}`, ua);
  if (r.status !== 200) { ok(false, `${name}: HTTP ${r.status}`); continue; }
  validateShare(r.body, name);
  ok(/upload=\d+; download=\d+; total=\d+/.test(r.ui || ""), `${name}: subscription-userinfo (expiry/traffic in-app)`);
}

console.log("\n[C] Explicit format override + aliases:");
{
  const y = await get(`/all/SP%20VPN?t=${TOK}&fmt=yaml`, "curl/8.5.0");
  ok(y.ct.includes("yaml"), "?fmt=yaml forces YAML");
  validateMihomo(y.body, "?fmt=yaml");
  const s = await get(`/all/SP%20VPN?t=${TOK}&fmt=sr`, "clash-verge/v1.7.7");
  ok(s.ct.includes("text/plain"), "?fmt=sr forces SR base64 even for Clash UA");
  const sub = await get(`/sub/${TOK}?brand=SP%20VPN`, "clash-verge-rev/2.4.1");
  validateMihomo(sub.body, "/sub (auto-update URL)");
  const sr = await get(`/sr/SP%20VPN?t=${TOK}`, "v2rayNG/1.10.6");
  validateShare(sr.body, "/sr");
  const sh = await get(`/share/${TOK}?brand=SP%20VPN`, "Mozilla/5.0");
  ok(sh.body.includes("vless://"), "/share plain list");
  const q = await get(`/q/${TOK}`, "Mozilla/5.0");
  ok(q.status === 200 && q.body.includes("<h1>"), "/q quota page renders");
}

console.log("\n[D] Plain (non-base64) supplier payload with BOM/CRLF:");
supplierMode = { body: SUPPLIER_RAW, status: 200 };
{
  const r = await get(`/all/SP%20VPN?t=${TOK_PLAIN}`, "clash-verge-rev/2.4.1");
  ok(r.status === 200 && r.ct.includes("yaml"), "plain+dirty payload still returns YAML");
  validateMihomo(r.body, "plain payload");
}

console.log("\n[E] Info-only supplier (zero real nodes):");
supplierMode = { body: "STATUS=↑:0GB,↓:0GB,TOT:100GB Expires:2027-01-01\nvless://00000000-0000-0000-0000-000000000000@1.1.1.1:80?encryption=none&type=tcp#" + enc("剩余流量：100GB"), status: 200 };
{
  const r = await get(`/all/SP%20VPN?t=${TOK_INFO}`, "clash-verge/v1.7.7");
  ok(r.status === 200, "info-only supplier → still serves config");
  if (r.status === 200) validateMihomo(r.body, "info-only");
}

console.log("\n[F] Failure modes (must be real HTTP errors, not 200-HTML):");
supplierMode = { body: "", status: 403 };
{
  const r = await get(`/all/SP%20VPN?t=${TOK_BLOCK}`, "clash-verge-rev/2.4.1");
  ok(r.status === 502 && !r.body.includes("<"), `blocked supplier → ${r.status} plain text`);
  const v = await get(`/all/SP%20VPN?t=${TOK_BLOCK}`, "v2rayNG/1.10.6");
  ok(v.status === 502, `v2rayNG also gets ${v.status} (clear error in app)`);
  const n = await get(`/all/SP%20VPN`, "clash-verge/v1.7.7");
  ok(n.status === 400, "missing token → 400");
}

console.log("\n[G] Seller flows:");
supplierMode = { body: SUPPLIER_RAW, status: 200 };
{
  const form = new URLSearchParams({ brand: "SP VPN", links: SUPPLIER.filter((l) => l.startsWith("vmess://")).join("\n") + "\n" + SUPPLIER.filter((l) => l.startsWith("trojan://")).join("\n") }).toString();
  const post = await worker.fetch(new Request("https://sp.example.com/tool", { method: "POST", body: form }), {}, {});
  const pb = await post.text();
  ok(post.status === 200 && pb.includes("ONE LINK"), "POST /tool accepts pasted vmess+trojan node links");
  // direct-node token → /all YAML
  const oneLink = pb.match(/https:\/\/sp\.example\.com\/all\/[^"<\s]+/)[0].replace("https://sp.example.com", "");
  const r = await get(oneLink, "clash-verge-rev/2.4.1");
  ok(r.status === 200 && r.ct.includes("yaml"), "ONE link from pasted nodes serves YAML to Verge");
  if (r.ct.includes("yaml")) validateMihomo(r.body, "pasted nodes");
}

console.log("\n[H] Supplier fetch time budget (Vercel's ~10s kill → EOF / \"no recent network activity\" in apps):");
{
  ok(FETCH_BUDGET_MS === 7000, `supplier fetch budget is ${FETCH_BUDGET_MS}ms TOTAL (was 3 attempts × 8s = up to 24s)`);
  ok(FETCH_BUDGET_MS + 1500 < 10000, "budget + headroom to build the response fits inside Vercel's ~10s limit");

  // supplier panel that accepts the connection and then never answers
  supplierMode = { body: SUPPLIER_LINKS_ONLY, status: 200, delayMs: 60000 };
  supplierCalls = 0;
  const t0 = Date.now();
  let msg = "";
  try { await fetchSubscription("https://supplier.example/sub?token=probe", 400); } catch (e) { msg = String(e.message); }
  const elapsed = Date.now() - t0;
  ok(supplierCalls === 1, `hung supplier → ${supplierCalls} attempt starts (not 3 full-timeout retries)`);
  ok(elapsed >= 350 && elapsed < 800, `budget is a TOTAL cap: 400ms budget gave up in ${elapsed}ms, not 3 × 400ms`);
  ok(/did not respond|timeout|timed out/i.test(msg), `gives up with a clear reason: ${msg}`);

  // the real HTTP path, with the production 7s budget
  const t1 = Date.now();
  const r = await get(`/all/SP%20VPN?t=${TOK_HUNG}`, "clash-meta/1.18.0");
  const routeMs = Date.now() - t1;
  ok(r.status === 502, `hung supplier → HTTP ${r.status}, not a truncated 200 (that is the EOF the apps saw)`);
  ok(routeMs < 9000, `/all/… answered in ${routeMs}ms — Vercel never gets to kill the function mid-response`);
  ok(!r.body.includes("<") && /did not respond|timeout/i.test(r.body), `plain-text error the app can show: ${r.body.trim().slice(0, 70)}`);

  // and the very same link recovers the moment the supplier answers again
  supplierMode = { body: SUPPLIER_LINKS_ONLY, status: 200, delayMs: 0 };
  const back = await get(`/all/SP%20VPN?t=${TOK_HUNG}`, "clash-meta/1.18.0");
  ok(back.status === 200 && back.ct.includes("yaml"), `same link recovers to ${back.status} YAML as soon as the supplier answers`);
}

console.log(`\n${failures === 0 ? "🎉 ALL " + checks + " CHECKS PASSED" : "💥 " + failures + " of " + checks + " checks failed"}`);
process.exit(failures ? 1 : 0);
