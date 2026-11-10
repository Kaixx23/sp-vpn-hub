// ============================================================================
// CLIENT-MATRIX SUITE — every app a student actually uses, against a supplier
// payload built to be as hostile as a real airport panel.
//
// The question this answers, per client: does the converted link do everything
// the raw supplier link does (and nothing worse)? Checked on three axes:
//
//   format   — the client is handed something it can parse (mihomo = YAML,
//              everything else = base64 share list)
//   parity   — no node, no parameter and no quota is lost versus the supplier
//   safety   — the profile parses under mihomo's own rules, and nothing an app
//              sends (brand in the URL path, ?brand=) can corrupt it
//
// Run: node test/client-matrix.test.mjs
// ============================================================================
import worker, { checkProfile, safeBrand } from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import yaml from "js-yaml";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};
const sect = (t) => console.log("\n[" + t + "]");

const enc = encodeURIComponent;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const V = (uuid, host, name, q = "") => `vless://${uuid}@${host}:443?${q}#${enc(name)}`;

// ---------------------------------------------------------------------------
// Fixture supplier — 吹雪云-shaped: CRLF, BOM, uppercase scheme, quota
// placeholders, names that collide in English, quotes/commas in names, a
// CDN-fronted ws family, grpc, trojan over ws with allowInsecure, vmess with
// aid 64, an IPv6 target, an empty name, and two node types Clash cannot use.
const SUPPLIER = "https://xn--9kqs1lo79d.cc/api/v1/chuixue?token=SUPERSECRET";
const REALITY = "encryption=none&security=reality&flow=xtls-rprx-vision&fp=safari&sni=updates.cdn-apple.com&pbk=70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4&sid=3191b53b&type=tcp";
const SUPPLIER_LINES = [
  "\uFEFFSTATUS=🚀↑:0GB,↓:0.01GB,TOT:512GB💡Expires:2026-12-10",
  V("U1", "chuixuevl1.example.cc", "剩余流量：511.99 GB", REALITY),
  V("U1", "chuixuevl1.example.cc", "套餐到期：2026-12-10", REALITY),
  V("U1", "chuixuevl1.example.cc", "🇯🇵日本•移联01", REALITY),
  V("U1", "chuixuevl2.example.cc", "🇺🇸美国•移联01", REALITY),
  V("U1", "chuixuevl3.example.cc", "🇺🇸美国•移动01", REALITY),           // collides with the line above
  `VLESS://U2@chuixuecf.example.cc:443?type=ws&host=vipjp1.front.example&path=${enc("/chuixue/jp1")}&security=tls&fp=ios&sni=vipjp1.front.example#${enc("🇯🇵日本•电信01")}`,
  V("U3", "chuixuecf.example.cc", "🇩🇪德国•电信01", `type=grpc&serviceName=${enc("grpc,de1")}&security=tls&sni=vipde1.front.example`),
  `trojan://PW@de1.example.com:443?type=ws&host=tls-de.example.com&path=${enc("/de")}&sni=tls-de.example.com&allowInsecure=1#${enc("德国•联通01")}`,
  `vmess://${b64({ v: "2", ps: "🇰🇷韩国•联通01", add: "kr.example.com", port: "443", id: "VM1", aid: "64", scy: "auto", net: "ws", host: "kr-ws.example.com", path: "/kr", tls: "tls", sni: "kr-ws.example.com" })}`,
  V("U4", "chuixuevl9.example.cc", '🇭🇰香港•"引号"节点', REALITY),
  V("U5", "chuixuevl10.example.cc", "🇹🇼台湾•移联,01", REALITY),
  V("U6", "[2001:db8::1]", "", `type=tcp&security=reality&pbk=ZZZ&sid=1`),  // IPv6 + empty name
  `hysteria2://HYPASS@hy1.example.com:443?sni=hy.example.com&insecure=1#${enc("🇸🇬新加坡•Hysteria2")}`,
  `tuic://T1:P1@tuic.example.com:443?uuid=T2&password=P2&congestion_control=cubic&udp_relay_mode=native#${enc("🇯🇵日本•TUIC")}`,
];
const SUPPLIER_BODY = SUPPLIER_LINES.join("\r\n") + "\r\n";
// The lines a share-list client is entitled to: every link the supplier sent.
const SUPPLIER_NODES = SUPPLIER_LINES.slice(1).filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l));

const realFetch = globalThis.fetch;
let fetchedWith = [];
globalThis.fetch = async (u, o) => {
  if (String(u).startsWith(SUPPLIER)) {
    fetchedWith.push(o && o.headers && o.headers["User-Agent"]);
    return new Response(SUPPLIER_BODY, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return realFetch(u, o);
};
store.setBackend(new store.MemoryBackend());
await store.ensureInit();
const HOST = "https://sp-vpn.test";
const token = await store.mint(SUPPLIER, "matrix");
const get = (path, ua = "", accept = "") =>
  worker.fetch(new Request(HOST + path, { headers: { ...(ua ? { "User-Agent": ua } : {}), ...(accept ? { Accept: accept } : {}) } }), {}, {});
const sub = (q = "") => `/all/SP%20VPN?t=${token}${q}`;

const NODE = (n) => SUPPLIER_NODES.filter((l) => !/^(hysteria2|tuic):/i.test(l)).length;

// The five the reseller named, plus the neighbours that share their core.
const CLIENTS = [
  ["Clash Meta",     "clash.meta/1.19.17",              "yaml",  "MetaCubeX/mihomo"],
  ["Clash Verge",    "ClashVerge/1.3.5",                "yaml",  null],
  ["Clash Verge Rev","ClashVergeRev/2.3.0",             "yaml",  null],
  ["Karing",         "Karing/1.2.26.2905 CFNetwork/1492 Darwin/23.0.0", "yaml", null],
  ["Clash Mi",       "ClashMi/1.0.29",                  "yaml",  null],
  ["FlClash",        "FlClash/0.8.90",                  "yaml",  null],
  ["Stash",          "Stash/2.9.0",                     "yaml",  null],
  ["Shadowrocket",   "Shadowrocket/2.2.32 CFNetwork/1492", "b64", null],
  ["v2rayNG",        "v2rayNG/1.10.5",                  "b64",   null],
  ["NekoBox",        "NekoBox/Android/1.2.8",           "b64",   null],
  ["Hiddify",        "HiddifyNext/0.22.0",              "b64",   null],
  ["curl",           "curl/8.5.0",                      "b64",   null],
  ["no UA at all",   "",                                "b64",   null],
];

// ------------------------------------------------------------------- format
sect("1. each client is handed a format it can parse");
const yamlDocs = {};
for (const [name, ua, want] of CLIENTS) {
  const res = await get(sub(), ua);
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  const got = /yaml/.test(ct) ? "yaml" : "b64";
  ok(got === want, `${name.padEnd(16)} → ${want === "yaml" ? "mihomo YAML" : "base64 share list"}`);
  if (got === "yaml") {
    let d = null, err = "";
    try { d = yaml.load(text); } catch (e) { err = e.message.slice(0, 60); }
    ok(!!d, `${name.padEnd(16)} YAML parses${err ? " — ❌ " + err : ""}`);
    if (d) {
      const g = checkProfile(text, {});
      ok(g.ok, `${name.padEnd(16)} passes the profile guard${g.ok ? "" : " — " + g.problems.map((p) => p.code).join(",")}`);
      ok(text.split("\n").some((l) => /^\s*-\s*MATCH,🚀 /.test(l)), `${name.padEnd(16)} final MATCH rule intact`);
    }
    yamlDocs[name] = { text, doc: d };
  } else {
    const dec = Buffer.from(text.trim(), "base64").toString("utf8");
    const nodes = dec.split(/\r?\n/).filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l));
    ok(nodes.length === SUPPLIER_NODES.length, `${name.padEnd(16)} keeps all ${SUPPLIER_NODES.length} supplier links (${nodes.length})`);
    ok(!/SUPERSECRET|xn--9kqs1lo79d/.test(text), `${name.padEnd(16)} leaks no supplier URL`);
  }
  ok(res.headers.get("x-spvpn-profile") !== null, `${name.padEnd(16)} states its profile policy (stale-deploy signal)`);
}

// ------------------------------------------------------------------- parity
sect("2. nothing is lost versus the supplier link");
const { text: vy, doc } = yamlDocs["Clash Meta"];
const names = doc.proxies.map((p) => p.name);
ok(doc.proxies.length === NODE(), `${doc.proxies.length} Clash-usable proxies = every vless/vmess/trojan node`);
const find = (re) => doc.proxies.find((p) => re.test(p.name));
const r = find(/Japan•Mobile01/);
ok(r["reality-opts"]["public-key"] === "70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4" && r["reality-opts"]["short-id"] === "3191b53b",
  "Reality key + short-id survive the rebuild byte-for-byte");
ok(r.flow === "xtls-rprx-vision" && r["client-fingerprint"] === "safari" && r.servername === "updates.cdn-apple.com",
  "vision flow, uTLS fingerprint and SNI survive (any one wrong = handshake fails)");
const w = find(/Japan•Telecom01/);
ok(w.network === "ws" && w["ws-opts"].headers.Host === "vipjp1.front.example" && w["ws-opts"].path === "/chuixue/jp1",
  "CDN-front Host + ws path survive (drop these and the node is dead)");
const gr = find(/Germany•Telecom01/);
ok(gr.network === "grpc" && gr["grpc-opts"]["grpc-service-name"] === "grpc,de1", "grpc service name survives, comma and all");
const tj = doc.proxies.find((p) => p.type === "trojan");
ok(tj && tj.network === "ws" && tj["skip-cert-verify"] === true, "trojan keeps ws transport + allowInsecure");
const vm = doc.proxies.find((p) => p.type === "vmess");
ok(vm && vm.alterId === 64 && vm.cipher === "auto", "vmess keeps aid=64 (some panels require it)");
ok(doc.proxies.some((p) => p.server === "2001:db8::1"), "IPv6 target kept without brackets");
const tq = find(/引号/);
ok(tq && /"/.test(tq.name), "a quote in a node name does not break the YAML");
ok(find(/Taiwan•Mobile,01/), "a comma in a node name survives (names are quoted, unlike rules)");
ok(doc.proxies.filter((p) => /USA•Mobile01/.test(p.name)).length === 2,
  "美国•移联01 + 美国•移动01 collide in English → both kept as distinct names");
ok(names.length === new Set(names).size, "…and no duplicate names (mihomo rejects the whole file for those)");
// Quota must reach the app even though it is not in the node list.
const res = await get(sub(), "clash.meta/1.19.17");
const ui = res.headers.get("subscription-userinfo") || "";
ok(/upload=0/.test(ui) && /total=549755813888/.test(ui), `quota in subscription-userinfo header (${ui.slice(0, 46)}…)`);
ok(res.headers.get("profile-update-interval") === "6", "profile auto-updates every 6h");
ok((res.headers.get("profile-web-page-url") || "").includes("/q/"), "quota page linked from the profile");

// ------------------------------------------------------- unsupported nodes
sect("3. what Clash cannot use is announced, never hidden");
ok(/not Clash-compatible/.test(vy), "the profile itself says nodes were left out");
ok(/🇸🇬新加坡•Hysteria2|Singapore•Hysteria2/.test(vy), "…naming the Hysteria2 node");
ok(/🇯🇵日本•TUIC|Japan•TUIC/.test(vy), "…naming the TUIC node");
ok(!doc.proxies.some((p) => /Hysteria2|TUIC/.test(p.name)), "and they really are absent (not half-built)");
const b64res = await get(sub(), "Shadowrocket/2.2.32");
const b64nodes = Buffer.from((await b64res.text()).trim(), "base64").toString("utf8").split(/\r?\n/).filter(Boolean);
ok(b64nodes.some((l) => /^hysteria2:\/\//i.test(l)), "…while Shadowrocket still gets the Hysteria2 node");
const diag = await (await get(`/diag?t=${token}&fmt=yaml`, "clash.meta/1.19.17")).json();
ok(diag.nodes.unsupported === 2, `/diag counts them (${diag.nodes.shareLinks} links, ${diag.nodes.clashUsable} Clash-usable, ${diag.nodes.unsupported} unsupported)`);
ok(diag.ok === true, "…without failing the link");

// ----------------------------------------------------------- brand attacks
sect("4. a brand cannot break the profile it is written into");
const ATTACKS = ["SP,VPN", 'SP"VPN', "SP: VPN", "吹雪，VPN", "SP#VPN", "SP\nvpn", "SP VPN: 学生", "", "x".repeat(80)];
for (const brand of ATTACKS) {
  const t = await (await get(`/all/${enc(brand)}?t=${token}&fmt=yaml`, "clash.meta/1.19.17")).text();
  let d = null;
  try { d = yaml.load(t); } catch (e) { /* reported below */ }
  const ruleLine = (t.match(/^\s*-\s+MATCH.*$/m) || [""])[0].trim();
  const fields = ruleLine.replace(/^-\s*/, "").split(",");
  const groups = d ? new Set((d["proxy-groups"] || []).map((g) => g.name)) : new Set();
  const target = fields.slice(1).join(",");
  const rules = d && Array.isArray(d.rules) ? d.rules : [];
  const safe = d && typeof rules.at(-1) === "string" && fields.length === 2 && groups.has(target);
  ok(!!d && safe, `brand ${JSON.stringify(brand).slice(0, 22).padEnd(24)} → YAML scalar rule, group "${(d && d["proxy-groups"] ? d["proxy-groups"][0].name : "?").slice(0, 22)}" resolves`);
}
ok(safeBrand("SP,VPN") === "SP VPN" && safeBrand("吹雪 VPN: 学生") === "吹雪 VPN 学生", "safeBrand strips , \" # and \": \"");
ok(safeBrand("").length > 0 && safeBrand("").length === "SP VPN".length, "an empty brand still yields a valid group");
ok(safeBrand("x".repeat(80)).length === 40, "a long brand is clipped to the form's own 40-char limit");
const q = await get(`/q/${token}?brand=${enc('<img src=x onerror=alert(1)>')}`);
const qhtml = await q.text();
ok(!/<img src=x onerror/.test(qhtml) && /&lt;img/.test(qhtml), "brand on the quota page is escaped, not injected");

// ------------------------------------------------------------ overrides ----
sect("5. the escape hatches behave for every client");
const forced = await get("/all/SP%20VPN.yaml?t=" + token);
ok(/yaml/.test(forced.headers.get("content-type") || ""), "a Shadowrocket UA can still be forced to YAML by the .yaml suffix");
const forcedB64 = await get(sub("&fmt=sr"), "clash.meta/1.19.17");
ok(/text\/plain/.test(forcedB64.headers.get("content-type") || ""), "a Clash UA can still be forced back to base64 with &fmt=sr");
const cn = await (await get(sub("&fmt=yaml&cn=1"), "Karing/1.2.26")).text();
ok(/223\.5\.5\.5/.test(cn) && /GEOIP,CN,DIRECT/.test(cn), "&cn=1 restores CN resolvers + GEOIP rules for students on a Chinese ISP");
ok(checkProfile(cn, { cn: true }).ok, "…and that profile passes the guard in cn mode");
const rem = await (await get(sub("&fmt=yaml&remember=1"), "Karing/1.2.26")).text();
ok(/store-selected: true/.test(rem), "&remember=1 opts back into a sticky manual pick");
const excl = await (await get(sub("&fmt=yaml&exclude=hysteria|tuic"), "clash.meta/1.19.17"));
ok(excl.status === 200 && !/not Clash-compatible/.test(await excl.text()), "&exclude= can strip the unusable nodes");
const only = await (await get(sub("&fmt=yaml&include=Japan"), "clash.meta/1.19.17"));
const onlyDoc = yaml.load(await only.text());
ok(onlyDoc.proxies.every((p) => /Japan/.test(p.name)), `&include=Japan filters (${onlyDoc.proxies.length} proxies)`);
const killed = await get(sub("&fmt=yaml&exclude=.*"), "clash.meta/1.19.17");
ok(killed.status === 400, "filtering everything out is a clean 400, not an empty profile");
const badrx = await get(sub("&fmt=yaml&exclude=([unclosed"), "clash.meta/1.19.17");
ok(badrx.status === 200, "an invalid regex is ignored rather than breaking the customer's link");

// ------------------------------------------------------------- resilience --
sect("6. supplier-side failures degrade, they do not cascade");
ok(fetchedWith.length > 0 && /Shadowrocket/.test(fetchedWith[0]),
  "the supplier is asked as Shadowrocket first — that is what earns the STATUS= quota line");
const noNodes = new Response("no nodes here", { status: 200 });
globalThis.fetch = async (u) => (String(u).startsWith(SUPPLIER) ? noNodes : realFetch(u));
const t2 = await store.mint(SUPPLIER, "empty");
const bad = await get(`/all/SP%20VPN?t=${t2}`, "clash.meta/1.19.17");
ok(bad.status >= 500 && /text\/plain/.test(bad.headers.get("content-type") || ""),
  "an empty supplier response returns a plain 5xx, so the app shows the reason instead of a parse error");
globalThis.fetch = async (u, o) => (String(u).startsWith(SUPPLIER) ? new Response(SUPPLIER_BODY) : realFetch(u, o));
await store.updateRow(t2, { revoked: true });
ok(!(await store.resolve(t2)), "revocation is honoured on the next request (store level)");

console.log("\n" + "─".repeat(62));
if (failures) { console.log(`💥 ${failures}/${checks} FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
