// ============================================================================
// PROFILE-GUARD SUITE — pins the 2026-11-10 "Clash users time out, the raw
// supplier link works" incident.
//
// Root cause was NOT in the repo: the deployed build predated the profile fix
// and was still emitting China-only DNS + GeoIP rules to every client. The
// local suite passed while customers were broken, because nothing at runtime
// asserted the properties the profile generator promises. So this file pins
// them in four places:
//
//   1. buildYaml output        — the properties themselves
//   2. checkProfile            — the guard catches each regression
//   3. /healthz + header       — the deployment can be audited remotely
//   4. real customer data      — the 吹雪云 payload shape from the incident
//
// Run: node test/profile-guard.test.mjs
// ============================================================================
import worker, { checkProfile, profileFingerprint, profileHeader } from "../sp-vpn-worker.js";
import * as store from "../token-store.js";
import yaml from "js-yaml";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};
const sect = (t) => console.log("\n[" + t + "]");

// ---------------------------------------------------------------------------
// Fixture: the shape that actually broke. 吹雪云 (xn--9kqs1lo79d.cc) serves a
// STATUS line to Shadowrocket UAs, two quota pseudo-nodes, CRLF endings, Reality
// tcp nodes plus a CDN-fronted ws family, and 移联/移动 names that collide in
// English. That collision and those info nodes are what the guard must handle.
const enc = encodeURIComponent;
const U = "b06658de-1b44-4fad-8a2c-c1c7ca29f112";
const reality = (host, sni, fp, pbk, sid, name) =>
  `vless://${U}@${host}:443?type=tcp&encryption=none&security=reality&flow=xtls-rprx-vision&fp=${fp}&insecure=0&pcs=&sni=${sni}&pbk=${pbk}&sid=${sid}#${enc(name)}`;
const fronted = (sni, name) =>
  `vless://${U}@chuixuecf.example.cc:443?type=ws&encryption=none&host=${sni}&path=${enc("/chuixue/x")}&security=tls&fp=ios&insecure=0&sni=${sni}#${enc(name)}`;

const CUSTOMER_BODY = [
  "STATUS=🚀↑:0GB,↓:0.01GB,TOT:512GB💡Expires:2026-12-10",
  reality("chuixuevl1.example.cc", "updates.cdn-apple.com", "safari", "70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4", "3191b53b", "剩余流量：511.99 GB"),
  reality("chuixuevl1.example.cc", "updates.cdn-apple.com", "safari", "70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4", "3191b53b", "套餐到期：2026-12-10"),
  reality("chuixuevl1.example.cc", "updates.cdn-apple.com", "safari", "70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4", "3191b53b", "🇯🇵日本•移联01"),
  reality("chuixuevl2.example.cc", "updates.cdn-apple.com", "ios", "XKNiiKGcjlO5JmFjfXAyWj3utWzrVJRRmoiCF_pVPDQ", "471edb92", "🇭🇰香港•移联01"),
  fronted("vipjp1.example.top", "🇯🇵日本•电信01"),
  reality("chuixuevl21.example.cc", "cdn-dynmedia-1.microsoft.com", "chrome", "AAAA", "aabbccdd", "🇺🇸美国•移联01"),
  reality("chuixuevl23.example.cc", "cdn-dynmedia-1.microsoft.com", "chrome", "BBBB", "eeff0011", "🇺🇸美国•移动01"),
].join("\r\n") + "\r\n";

const SUPPLIER = "https://xn--9kqs1lo79d.cc/api/v1/chuixue?token=b1a1cdaf628827722776573ffd8f5e6e";
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) =>
  String(u).startsWith(SUPPLIER)
    ? new Response(CUSTOMER_BODY, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    : realFetch(u, o);

store.setBackend(new store.MemoryBackend());
await store.ensureInit();
const HOST = "https://sp-vpn.test";
const get = (path, ua) =>
  worker.fetch(new Request(HOST + path, { headers: ua ? { "User-Agent": ua } : {} }), {}, {});
const token = await store.mint(SUPPLIER, "chuixue");
const sub = (q = "") => `/all/SP%20VPN?t=${token}${q}`;

// The profile a real Clash client receives from THIS repo.
const y = await (await get(sub("&fmt=yaml"), "clash-verge/v1.7.7")).text();
const doc = yaml.load(y);

// ---------------------------------------------------------------- 1. profile
sect("1. the served profile is safe outside China");
ok(!/GEOIP/.test(y), "no GEOIP rules — a fresh import needs no geodata download");
ok(!/geoip:\s*true/.test(y), "no dns.fallback-filter.geoip");
ok(!/223\.5\.5\.5|119\.29\.29\.29/.test(y), "no China-only resolvers in the global profile");
ok(/^  nameserver: \[1\.1\.1\.1, 8\.8\.8\.8, 9\.9\.9\.9\]$/m.test(y), "global resolvers that work from anywhere");
ok(/^  proxy-server-nameserver: \[1\.1\.1\.1, 8\.8\.8\.8\]$/m.test(y),
  "proxy-server-nameserver set — without it node hostnames resolve via the wrong path");
ok(/^  store-selected: false$/m.test(y), "store-selected:false — Auto Speed re-armed on every update");
ok(/^ipv6: false$/m.test(y), "ipv6:false — no v6 lookups against v4-only nodes");
ok(/^tcp-concurrent: true$/m.test(y), "tcp-concurrent:true — happy-eyeballs for dual-stack node hosts");
const top = doc["proxy-groups"].find((g) => g.name.startsWith("🚀"));
ok(top.proxies[0] === "⚡ Auto Speed", "⚡ Auto Speed is the first member of the top group (mihomo default)");
const auto = doc["proxy-groups"].find((g) => g.name === "⚡ Auto Speed");
// This used to read `auto["expected-status"] === 204` and call it a feature. It
// was the bug: a node is only "alive" if the probe answer matches, and Google
// answers a datacenter exit with a redirect / rate limit routinely — so the node
// shows no latency and url-test refuses to select it, while carrying traffic
// fine. That is the whole of "only a few of my countries work in Clash".
ok(auto["lazy"] === true, "url-test is lazy — no background dialling of every node");
ok(auto["expected-status"] === undefined, "…and no forced status, so ANY reply from the node counts as alive");
ok(/^  url: https:\/\/\S+generate_204$/m.test(y), "health probe is https (http:// on port 80 is dropped by some exits)");
ok(!/^  url: http:\/\//m.test(y), "no plain-http probe anywhere in the profile");
ok(auto["tolerance"] === 80, "url-test tolerance 80 — auto selection does not flap");
const failover = doc["proxy-groups"].find((g) => g.name === "🔁 Failover");
ok(failover["max-failed-times"] === 3, "fallback has max-failed-times:3");

// ------------------------------------------------------- 2. quota placeholders
sect("2. quota info links are display-only, not servers");
const infoNames = doc.proxies.map((p) => p.name).filter((n) => /^(Remaining|Expires)/.test(n));
ok(infoNames.length === 2, `both quota placeholders survive translation (${infoNames.join(", ")})`);
ok(top.proxies.some((n) => /^Remaining/.test(n)), "kept visible in the top selector");
ok(!auto.proxies.some((n) => /^Remaining|^Expires/.test(n)), "NOT in ⚡ Auto Speed — they are not servers");
ok(!failover.proxies.some((n) => /^Remaining|^Expires/.test(n)), "NOT in 🔁 Failover");
ok(auto.proxies.length === 5, `Auto Speed tests only real nodes (${auto.proxies.length})`);
const counted = y.match(/^# (\d+) nodes(?: \+ (\d+) quota info link\(s\))?/m);
ok(counted && Number(counted[1]) === 5, `header counts real nodes, not placeholders (says "${counted && counted[0].slice(2)}")`);
ok(counted && Number(counted[2]) === 2, "…and reports the placeholders separately");

// ----------------------------------------------------- 3. name-collision hardening
sect("3. translation collisions cannot kill the import");
const names = doc.proxies.map((p) => p.name);
ok(names.length === new Set(names).size, `no duplicate proxy names (${names.length} unique)`);
ok(names.includes("🇺🇸USA•Mobile01") && names.includes("🇺🇸USA•Mobile01 2"),
  "美国•移联01 and 美国•移动01 both translate to USA•Mobile01 — second is de-duplicated");
const known = new Set([...names, ...doc["proxy-groups"].map((g) => g.name), "DIRECT", "REJECT"]);
const dangling = doc["proxy-groups"].flatMap((g) => g.proxies || []).filter((n) => !known.has(n));
ok(dangling.length === 0, `every group member resolves${dangling.length ? " — got " + dangling.join(", ") : ""}`);

// ---------------------------------------------------- 4. Reality/CDN params kept
sect("4. node parameters survive the rebuild");
const r = doc.proxies.find((p) => p.name === "🇯🇵Japan•Mobile01");
ok(r.type === "vless" && r.network === "tcp" && r.flow === "xtls-rprx-vision", "vless + vision flow preserved");
ok(r["reality-opts"]["public-key"] === "70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4", "Reality public key preserved byte-for-byte");
ok(r["reality-opts"]["short-id"] === "3191b53b", "Reality short-id preserved");
ok(r.servername === "updates.cdn-apple.com" && r["client-fingerprint"] === "safari", "SNI + fingerprint preserved (wrong fp = failed handshake)");
ok(r.udp === true, "udp:true — otherwise DNS/QUIC breaks under fake-ip");
const w = doc.proxies.find((p) => p.name === "🇯🇵Japan•Telecom01");
ok(w.network === "ws" && w["ws-opts"].headers.Host === "vipjp1.example.top", "CDN-front Host header preserved");
ok(w["ws-opts"].path === "/chuixue/x", "ws path preserved");

// ------------------------------------------------------------ 5. the cn escape hatch
sect("5. ?cn=1 still opts into the China-tuned profile");
const yc = await (await get(sub("&fmt=yaml&cn=1"), "clash-verge/v1.7.7")).text();
ok(/GEOIP,CN,DIRECT/.test(yc), "GEOIP,CN,DIRECT rules return");
ok(/223\.5\.5\.5/.test(yc), "CN resolvers return");
ok(/proxy-server-nameserver: \[223\.5\.5\.5/.test(yc), "…with proxy-server-nameserver too (a bug here breaks CN users silently)");
ok(/geo-auto-update: true/.test(yc), "geodata refreshes in the background, not blocking first connect");
ok(checkProfile(yc, { cn: true }).ok, "the cn profile passes the guard in cn mode");
// Mode is not cosmetic — in cn mode the CN rules/resolvers are REQUIRED, so a
// profile that silently fell back to global while claiming cn must not pass.
const wrongMode = checkProfile(y, { cn: true });
ok(!wrongMode.ok && wrongMode.problems.some((p) => p.code === "cn-missing-geoip"),
  "the guard is mode-aware: a global profile evaluated as cn mode is flagged, not excused");

// ------------------------------------------------------------- 6. the guard bites
sect("6. checkProfile catches each regression that broke customers");
const regressions = {
  "needs-geoip": "rules:\n  - GEOIP,CN,DIRECT\n  - MATCH,🚀 SP VPN\nproxies:\n- name: \"a\"\n  udp: true\n",
  "cn-dns": "dns:\n  nameserver: [223.5.5.5, 119.29.29.29]\n  proxy-server-nameserver: [1.1.1.1]\nproxies:\n- name: \"a\"\n  udp: true\n",
  "no-proxy-nameserver": "dns:\n  nameserver: [1.1.1.1]\nproxies:\n- name: \"a\"\n  udp: true\n",
  "sticky-selection": "profile:\n  store-selected: true\nproxies:\n- name: \"a\"\n  udp: true\n",
  "duplicate-names": "proxies:\n- name: \"a\"\n  udp: true\n- name: \"a\"\n  udp: true\n",
  "no-udp": "proxies:\n- name: \"a\"\n  type: vless\n",
  "dangling-group": "proxy-groups:\n- name: \"g\"\n  type: select\n  proxies:\n  - \"nope\"\nproxies:\n- name: \"a\"\n  udp: true\n",
};
for (const [code, sample] of Object.entries(regressions)) {
  const g = checkProfile(sample, {});
  ok(g.problems.some((p) => p.code === code), `detects ${code}`);
}
ok(checkProfile(y, {}).ok, "the real profile passes clean");

// ------------------------------------------- 7. the deployed build is auditable
sect("7. a stale deploy is detectable from outside");
const fp = profileFingerprint();
ok(fp.ok, "fingerprint: this build's profile policy is sound");
ok(fp.needsGeoipDownload === false && fp.cnOnlyDns === false, "fingerprint reports the two incident properties");
ok(fp.autoSpeedFirst && fp.storeSelectedOff && fp.proxyServerNameserver, "fingerprint reports the four positive properties");
ok(profileHeader() === "geo-free;global-dns;auto-speed;re-armed", `header string (${profileHeader()})`);
const hres = await get("/healthz");
ok(hres.status === 200, "/healthz returns 200 when the policy is intact");
const hj = await hres.json();
ok(hj.ok === true, "/healthz says ok");
const hjf = await (await get("/healthz?full=1")).json();
ok(hjf.profile === profileHeader() && Array.isArray(hjf.problems), "/healthz?full=1 exposes the fingerprint the verifier reads");
// The header must ride on both payload formats — that is what makes a stale
// build visible from a phone.
for (const [label, path, ua] of [["YAML", sub("&fmt=yaml"), "clash-verge/v1.7.7"], ["base64", sub(""), "Shadowrocket/2.2.32"]]) {
  const res = await get(path, ua);
  ok(res.headers.get("x-spvpn-profile") === profileHeader(), `${label} response carries X-SPVPN-Profile`);
}
const dq = await (await get(`/diag?t=${token}&fmt=yaml`, "ClashMi/1.0")).json();
ok(dq.ok === true, "/diag reports ok for a healthy link");
ok(dq.deployment && dq.deployment.ok === true, "/diag exposes the deployment fingerprint");
ok(dq.yaml.guard.ok === true, "/diag guards the exact bytes this client would get");

// -------------------------------------------------- 8. the incident's own failure
sect("8. the pre-fix profile that was live on 2026-11-10 fails loudly");
const STALE = `# SP VPN — generated for your account (live quota below)
mixed-port: 7890
mode: rule
profile:
  store-selected: true
dns:
  enhanced-mode: fake-ip
  nameserver: [223.5.5.5, 119.29.29.29]
  fallback-filter:
    geoip: true
proxy-groups:
- name: "🚀 SP VPN"
  type: select
  proxies:
  - "Remaining 511.99 GB"
  - "🇯🇵Japan•Mobile01"
- name: "⚡ Auto Speed"
  type: url-test
  proxies:
  - "Remaining 511.99 GB"
  - "🇯🇵Japan•Mobile01"
rules:
  - GEOIP,PRIVATE,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🚀 SP VPN
proxies:
- name: "🇯🇵Japan•Mobile01"
  type: vless
  udp: true
- name: "Remaining 511.99 GB"
  type: vless
  udp: true
`;
const stale = checkProfile(STALE, {});
const codes = stale.problems.map((p) => p.code).sort();
ok(stale.ok === false, "guard rejects it");
ok(codes.includes("needs-geoip") && codes.includes("cn-dns") && codes.includes("no-proxy-nameserver")
  && codes.includes("sticky-selection") && codes.includes("info-in-test"),
  `names all five causes (${codes.join(", ")})`);
// A build old enough to predate the guard is itself a failure signal.
const noGuard = checkProfile("proxies:\n- name: \"a\"\n  udp: true\n", { cn: true });
ok(noGuard.problems.some((p) => p.code === "cn-missing-geoip"), "a profile claiming cn mode without CN rules is flagged");

// ------------------------------------------------ 8. the latency probe itself
// Two independent ways a node can be healthy and still look dead, both of which
// the old profile had, both invisible to any check that only parses the YAML.
sect("8. health probe — the difference between \u201cnode dead\u201d and \u201cprobe blocked\u201d");
{
  const u = (g) => doc["proxy-groups"].find((x) => x.name === g).url;
  ok(u("⚡ Auto Speed") === u("🔁 Failover"), "both auto groups probe the same URL (a split makes selection unexplainable)");
  ok(/^https:\/\/www\.gstatic\.com\/generate_204$/.test(u("⚡ Auto Speed")), `default probe: ${u("⚡ Auto Speed")}`);

  const strict = await (await get(sub("&fmt=yaml&expect=204"), "clash-verge/v1.7.7")).text();
  ok(/expected-status: "204"/.test(strict), "&expect=204 opts back into the strict check (still quoted, so YAML cannot misread it)");
  const ranges = await (await get(sub("&fmt=yaml&expect=2xx,301"), "clash-verge/v1.7.7")).text();
  ok(/expected-status: "2xx,301"/.test(ranges), "&expect accepts mihomo's range syntax");
  const junk = await (await get(sub("&fmt=yaml&expect=42,drop-tables"), "clash-verge/v1.7.7")).text();
  ok(!/expected-status/.test(junk), "a status list mihomo cannot parse is ignored, not embedded");
  const inj = await (await get(sub('&fmt=yaml&expect=204"\n  x: "y'), "clash-verge/v1.7.7")).text();
  ok(!/x:/.test(inj), "…and it cannot break out of the YAML scalar");

  const other = await (await get(sub("&fmt=yaml&health=https://www.google.com/generate_204"), "clash-verge/v1.7.7")).text();
  ok(/url: https:\/\/www\.google\.com\/generate_204/.test(other), "&health= lets a reseller point the probe at something their exits reach");
  const bad = await (await get(sub('&fmt=yaml&health=https://x" y#z'), "clash-verge/v1.7.7")).text();
  ok(/url: https:\/\/www\.gstatic\.com\/generate_204/.test(bad), "a URL that would corrupt the profile falls back to the default");
  const over = await (await get(sub("&fmt=yaml&health=" + "a".repeat(400)), "clash-verge/v1.7.7")).text();
  ok(/url: https:\/\/www\.gstatic\.com\/generate_204/.test(over), "an absurdly long probe URL is rejected, not truncated into the file");

  // The guard knows about it, so a future "optimisation" back to http:// or to a
  // forced status is loud instead of arriving as a customer complaint.
  const httpProbe = checkProfile(y.replace("url: https://www.gstatic.com/generate_204", "url: http://www.gstatic.com/generate_204"), {});
  ok(httpProbe.problems.some((x) => x.code === "insecure-health-url"), "an http:// probe is reported as a profile problem");
  const strictProbe = checkProfile(y + '\n  expected-status: "204"\n', {});
  ok(!strictProbe.problems.some((x) => x.code === "insecure-health-url"), "…and adding a status back is not itself an error");
}

console.log("\n" + "─".repeat(62));
if (failures) { console.log(`💥 ${failures}/${checks} FAILED`); process.exit(1); }
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
