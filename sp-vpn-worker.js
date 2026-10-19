// SP VPN — Cloudflare Worker
// Your SP VPN one-link generator, hosted on Cloudflare (reachable from China).
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste this file → Deploy.
//
// MODIFIED: tokens are now opaque (see token-store.js) and there is a customer
// registry + dashboard (see dashboard.js). The supplier URL is no longer
// base64-encoded into the customer's link.
import {
  mint as storeMint,
  resolve as storeResolve,
  updateRow as storeUpdate,
  listAll as storeList,
  removeRow as storeRemove,
  ensureInit as storeInit,
  setBackend as storeSetBackend,
  backend as storeBackend,
} from "./token-store.js";
import { dashboardPage, summarise, isSystemGeneratedRow } from "./dashboard.js";
import { customerType, validCustomerType, supplierKey, supplierAccounts, resolveCustomerLink, validPaidUntil } from "./customer-accounts.js";
import { sharedUsersReport, sharedUsersForToken } from "./shared-users.js";
import { PLAN_CATALOG, profitOf } from "./plans.js";
import { checkCustomerRow, usageKind, usageMessage } from "./renewal.js";
import { runRemindersFromEnv } from "./reminders.js";
import {
  hasBeenSent as storeHasBeenSent,
  markSent as storeMarkSent,
  listReminders as storeListReminders,
} from "./token-store.js";
import { generateQrSvg, qrMakerPage } from "./qr.js";

// ---------------- translation ----------------
const INFO_PREFIX = [
  ["距离下次重置剩余", "Reset in"],
  ["剩余流量", "Remaining"],
  ["套餐到期", "Expires"],
  ["到期时间", "Expires"],
  ["流量到期", "Expires"],
  ["剩余", "Remaining"],
  ["到期", "Expires"],
];
const COUNTRY = {
  "日本": "Japan", "新加坡": "Singapore", "香港": "Hong Kong", "台湾": "Taiwan",
  "韩国": "Korea", "美国": "USA", "英国": "UK", "德国": "Germany", "法国": "France",
  "加拿大": "Canada", "澳大利亚": "Australia", "中国": "China", "泰国": "Thailand",
  "越南": "Vietnam", "印度": "India", "俄罗斯": "Russia", "荷兰": "Netherlands",
  "瑞典": "Sweden", "芬兰": "Finland", "挪威": "Norway", "意大利": "Italy",
  "西班牙": "Spain", "瑞士": "Switzerland", "奥地利": "Austria", "葡萄牙": "Portugal",
  "迪拜": "Dubai", "土耳其": "Turkey", "巴西": "Brazil", "墨西哥": "Mexico",
};
const CARRIER = {
  "移联": "Mobile", "移动": "Mobile", "联通": "Unicom", "电信": "Telecom",
  "家宽": "Home", "机房": "IDC", "广电": "Cable", "教育网": "Edu", "三线": "Tri-line", "原生": "Native",
};

// CN latency order (measured from a real mainland-China phone, 2026-08-26).
// Used to sort the node list so Chinese clients' apps default to the fastest node.
const CN_ORDER = [
  ["日本•移联01", 97], ["韩国•移联01", 104], ["香港•移联02", 112], ["日本•移联02", 113],
  ["香港•移联01", 121], ["新加坡•移联01", 131], ["台湾•移联01", 154],
  ["日本•电信01", 182], ["德国•电信01", 187], ["新加坡•移联02", 190],
  ["香港•电信01", 192], ["英国•电信01", 198], ["德国•移联01", 203],
  ["美国•电信01", 228], ["英国•移联01", 229], ["新加坡•电信02", 232],
  ["台湾•电信01", 233], ["韩国•电信01", 234], ["香港•电信02", 235],
  ["美国•移联01", 288], ["日本•电信02", 290],
];
function cnSortKey(originalName) {
  for (const [key, ms] of CN_ORDER) if (originalName.includes(key)) return ms;
  return 9999;
}
function isInfoLink(originalName) {
  return /^(剩余流量|距离下次重置|套餐到期|到期|流量)/.test(originalName);
}
function sortForCN(links) {
  // info/quota nodes first (as in the original), then CN-fastest-first (stable)
  // NOTE: safeDecode — a stray "%" in a node name must not crash the whole request
  // (it used to throw URIError, which returned an HTML error page to every VPN app).
  return [...links].sort((a, b) => {
    const an = safeDecode(a.split("#").pop() || "");
    const bn = safeDecode(b.split("#").pop() || "");
    const ai = isInfoLink(an) ? 0 : 1, bi = isInfoLink(bn) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return cnSortKey(an) - cnSortKey(bn);
  });
}

function translateName(name) {
  let n = name;
  for (const [zh, en] of INFO_PREFIX) {
    if (n.startsWith(zh)) {
      n = en + " " + n.slice(zh.length).replace(/^[：:\s]+/, "").trim();
      break;
    }
  }
  for (const [zh, en] of Object.entries(COUNTRY)) n = n.split(zh).join(en);
  for (const [zh, en] of Object.entries(CARRIER)) n = n.split(zh).join(en);
  n = n.split("天").join(" days").split("小时").join(" hours").split("分钟").join(" min");
  return n.replace(/\s{2,}/g, " ").trim();
}

function carrierOf(name) {
  if (name.includes("电信")) return "Telecom";
  if (name.includes("联通")) return "Unicom";
  if (name.includes("移动") || name.includes("移联")) return "Mobile";
  return null;
}

// ---------------- base64url tokens ----------------
function b64e(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64d(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function encName(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// ---------------- subscription fetch ----------------
function tryDecodeB64(s) {
  try {
    const t = decodeURIComponent(escape(atob(s.replace(/\s/g, ""))));
    if (t.includes("://") || t.includes("STATUS=")) return t;
  } catch (e) {}
  return s;
}

// Vercel's serverless limit is ~10s. The old code allowed 8s *per attempt*
// across 3 User-Agents, so a hung supplier panel could run 24s: Vercel killed
// the function mid-response and Clash Meta / NekoBox / v2rayNG saw a truncated
// body ("EOF" / "no recent network activity") instead of an error.
// FETCH_BUDGET_MS is therefore a TOTAL cap shared by every attempt — headers
// and body — so we always answer with real data or a clean 502 inside the
// platform limit, leaving headroom to build and stream the response.
export const FETCH_BUDGET_MS = 7000;

export async function fetchSubscription(url, budgetMs = FETCH_BUDGET_MS) {
  const uas = [
    "Shadowrocket/2.2.32",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "curl/8.5.0",
  ];
  const deadline = Date.now() + budgetMs;
  let last = "no response";
  let attempts = 0;
  for (const ua of uas) {
    // Whatever is left of the *total* budget — never a fresh 8s per attempt.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    attempts++;
    try {
      // The signal covers the body read too, so a supplier that sends headers
      // and then stalls still gets cut off inside the budget.
      const res = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(remaining) });
      // strip a UTF-8 BOM (some panels prepend it — it used to break the first line)
      const rawText = (await res.text()).replace(/^\uFEFF/, "").trim();
      const text = tryDecodeB64(rawText);
      // tolerate CRLF, lone CR, and blank lines
      const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
      const links = lines.filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l));
      if (links.length) {
        return { status: lines.find((l) => l.startsWith("STATUS=")) || "", links };
      }
      last = "provider returned HTTP " + res.status + " with no nodes - content starts: " + rawText.slice(0, 100).replace(/\s+/g, " ");
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      const secs = budgetMs % 1000 === 0 ? String(budgetMs / 1000) : (budgetMs / 1000).toFixed(1);
      last = timedOut
        ? "supplier did not respond within " + secs + "s (timeout)"
        : "fetch failed: " + e.message;
      // A timeout already consumed the whole budget — retrying another UA would
      // be the exact retry storm that used to outlive the Vercel limit.
      if (timedOut || Date.now() >= deadline) break;
    }
  }
  if (!attempts) last = "supplier fetch budget exhausted before any attempt";
  throw new Error(last);
}

// ---------------- node parsing / building ----------------
// mihomo/Clash needs a client-fingerprint for REALITY handshakes; xray links
// almost always carry fp=, but default to chrome when missing.
const stripBrackets = (s) => String(s).replace(/^\[/, "").replace(/\]$/, "");

function parseVless(link) {
  const i = link.indexOf("#");
  const uri = i >= 0 ? link.slice(0, i) : link;
  const frag = i >= 0 ? link.slice(i + 1) : "";
  // server may be a bare IPv6 in [brackets] (brackets are stripped; port is outside them)
  const m = uri.match(/^vless:\/\/([^@]+)@(\[[^\]]+\]|[^:@]+):(\d+)(?:\?(.*))?$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[4] || "");
  const g = (k) => q.get(k) || "";
  return {
    proto: "vless",
    name: safeDecode(frag), uuid: m[1], server: stripBrackets(m[2]), port: parseInt(m[3], 10),
    net: g("type") || "tcp", security: g("security"), sni: g("sni"), fp: g("fp"),
    pbk: g("pbk"), sid: g("sid"), flow: g("flow"), path: g("path"), ws_host: g("host"),
    serviceName: g("serviceName") || g("servicename"),
    insecure: g("allowInsecure") === "1" || g("insecure") === "1",
  };
}

function parseTrojan(link) {
  const i = link.indexOf("#");
  const uri = i >= 0 ? link.slice(0, i) : link;
  const frag = i >= 0 ? link.slice(i + 1) : "";
  const m = uri.match(/^trojan:\/\/([^@]+)@(\[[^\]]+\]|[^:@]+):(\d+)(?:\?(.*))?$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[4] || "");
  const g = (k) => q.get(k) || "";
  return {
    proto: "trojan",
    name: safeDecode(frag), password: safeDecode(m[1]), server: stripBrackets(m[2]), port: parseInt(m[3], 10),
    net: g("type") || "tcp", security: "tls", sni: g("sni") || g("peer"), fp: g("fp"),
    pbk: g("pbk"), sid: g("sid"), flow: "", path: g("path"), ws_host: g("host"),
    serviceName: g("serviceName") || g("servicename"),
    insecure: g("allowInsecure") === "1" || g("insecure") === "1",
  };
}

function parseVmess(link) {
  // vmess://<base64 JSON> — v2rayN/sing-box style
  let j;
  try {
    let b = link.slice(8).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    j = JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch (e) { return null; }
  if (!j || !j.add || !j.id) return null;
  const port = parseInt(j.port, 10);
  if (!port) return null;
  // legacy "tcp + http obfs" links carry the real path/host in j.header
  let net = String(j.net || "tcp").toLowerCase();
  let path = String(j.path || "");
  let ws_host = Array.isArray(j.host) ? String(j.host[0] || "") : String(j.host || "");
  if (net === "tcp" && j.header && String(j.header.type || "").toLowerCase() === "http") {
    net = "http";
    const req = j.header.request || {};
    path = String((Array.isArray(req.path) ? req.path[0] : req.path) || "/");
    const h = req.headers && req.headers.Host;
    ws_host = String((Array.isArray(h) ? h[0] : h) || ws_host);
  }
  return {
    proto: "vmess",
    name: String(j.ps || j.remarks || ""), uuid: String(j.id), server: String(j.add), port,
    alterId: parseInt(j.aid ?? j.alterId ?? 0, 10) || 0, cipher: String(j.scy || "auto"),
    net, security: String(j.tls || "").toLowerCase() === "tls" ? "tls" : "",
    sni: String(j.sni || ""), fp: String(j.fp || ""), flow: "",
    path, ws_host, serviceName: String(j.serviceName || ""),
    insecure: String(j.insecure || j.allowInsecure || "") === "1",
  };
}

// parse any supported share link: vless://, trojan://, vmess://
function parseNode(link) {
  if (/^vless:\/\//i.test(link)) return parseVless(link);
  if (/^trojan:\/\//i.test(link)) return parseTrojan(link);
  if (/^vmess:\/\//i.test(link)) return parseVmess(link);
  return null;
}

function rebrandLink(link, brand) {
  const i = link.indexOf("#");
  const base = i >= 0 ? link.slice(0, i) : link;
  const frag = i >= 0 ? link.slice(i + 1) : "";
  const en = translateName(safeDecode(frag)) || brand;
  return base + "#" + encName(en);
}

function buildShare(status, links, brand) {
  const out = [];
  if (status) out.push(status);
  for (const l of sortForCN(links)) out.push(rebrandLink(l, brand));
  return out.join("\n") + "\n";
}

const yq = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// Networks mihomo supports at import time; anything else falls back to tcp.
// Stable mihomo (v1.19.x, what Verge/Verge Rev/ClashX Meta/FlClash bundle) supports
// tcp/ws/http/h2/grpc for vless+vmess, but only tcp/ws/grpc for trojan.
function normNet(n, proto) {
  const v = String(n || "tcp").toLowerCase();
  const ok = proto === "trojan" ? ["tcp", "ws", "grpc"] : ["tcp", "ws", "grpc", "h2", "http"];
  return ok.includes(v) ? v : "tcp";
}

function buildYaml(status, proxies, brand) {
  const AUTO = "⚡ Auto Speed", FAIL = "🔁 Failover", DIRECT = "🇨🇳 Direct", TOP = "🚀 " + brand;
  const CI = { Telecom: "📡", Unicom: "📶", Mobile: "📱" };
  const CN = { Telecom: "电信", Unicom: "联通", Mobile: "移动" };
  const cgroup = (c) => `${CI[c] || ""} ${CN[c] || c}专线`;

  const sorted = [...proxies].sort((a, b) => {
    const ai = isInfoLink(a.name) ? 0 : 1, bi = isInfoLink(b.name) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return cnSortKey(a.name) - cnSortKey(b.name);
  });

  // --- CRITICAL: mihomo (Clash Verge / Clash Meta / ClashX) FATALLY rejects the whole
  // config when two proxies share a name ("proxy X is the duplicate name"). Chinese
  // names often collide after translation (香港•移联01 and 香港•移动01 both become
  // "Hong Kong•Mobile01"), so every display name must be made unique.
  const reserved = new Set([
    "DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL",
    AUTO, FAIL, DIRECT, TOP,
  ]);
  Object.keys({ Telecom: 1, Unicom: 1, Mobile: 1 }).forEach((c) => reserved.add(cgroup(c)));
  const used = new Set(reserved);
  const branded = [];
  for (const p of sorted) {
    let disp = translateName(p.name) || brand + " " + (branded.length + 1);
    if (used.has(disp)) {
      let k = 2;
      while (used.has(disp + " " + k)) k++;
      disp = disp + " " + k;
    }
    used.add(disp);
    branded.push({ ...p, disp });
  }

  // Quota/info placeholder nodes stay visible in the top selector, but must NOT
  // join speed-test / failover / carrier groups (they are fake servers).
  const isInfo = (p) => isInfoLink(p.name);
  const realNodes = branded.filter((p) => !isInfo(p));
  const names = realNodes.map((p) => p.disp);
  const carrierNodes = {};
  realNodes.forEach((p) => {
    const c = carrierOf(p.name);
    if (c) (carrierNodes[c] = carrierNodes[c] || []).push(p.disp);
  });
  const hasAuto = names.length > 0;

  const L = [];
  L.push(`# ${brand} — generated for your account (live quota below)`);
  if (status) L.push("# " + status);
  L.push(`# ${branded.length} nodes · CN-optimized: auto speed-test, fallback, carrier lines, CN-direct rules`);
  L.push(`# refreshed ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
  L.push("mixed-port: 7890");
  L.push("allow-lan: false");
  L.push("mode: rule");
  L.push("log-level: info");
  L.push("unified-delay: true");
  L.push("dns:");
  L.push("  enable: true");
  L.push("  enhanced-mode: fake-ip");
  L.push("  fake-ip-range: 198.18.0.1/16");
  L.push("  default-nameserver: [223.5.5.5, 119.29.29.29]");
  L.push("  nameserver: [223.5.5.5, 119.29.29.29]");
  L.push("  fallback: [tls://8.8.8.8:853, tls://1.1.1.1:853]");
  L.push("  fallback-filter:");
  L.push("    geoip: true");
  L.push("    geoip-code: CN");
  L.push("proxy-groups:");
  const topMembers = [
    ...(hasAuto ? [AUTO, FAIL] : []),
    DIRECT,
    ...Object.keys(carrierNodes).map(cgroup),
    ...branded.map((p) => p.disp),
  ];
  L.push(`- name: ${yq(TOP)}`);
  L.push("  type: select");
  L.push("  proxies:");
  for (const n of topMembers) L.push("  - " + yq(n));
  if (hasAuto) {
    for (const [gname, gtype] of [[AUTO, "url-test"], [FAIL, "fallback"]]) {
      L.push(`- name: ${yq(gname)}`);
      L.push("  type: " + gtype);
      L.push("  url: http://www.gstatic.com/generate_204");
      L.push("  interval: 300");
      if (gtype === "url-test") L.push("  tolerance: 80");
      L.push("  proxies:");
      for (const n of names) L.push("  - " + yq(n));
    }
  }
  for (const c of Object.keys(carrierNodes).sort()) {
    L.push(`- name: ${yq(cgroup(c))}`);
    L.push("  type: select");
    L.push("  proxies:");
    if (hasAuto) L.push("  - " + yq(AUTO));
    for (const n of carrierNodes[c]) L.push("  - " + yq(n));
  }
  L.push(`- name: ${yq(DIRECT)}`);
  L.push("  type: select");
  L.push("  proxies: [DIRECT, REJECT]");
  L.push("rules:");
  L.push("  - GEOIP,PRIVATE,DIRECT");
  L.push("  - DOMAIN-SUFFIX,cn,DIRECT");
  L.push("  - GEOIP,CN,DIRECT");
  L.push("  - MATCH," + TOP);
  L.push("proxies:");
  for (const p of branded) {
    const net = normNet(p.net, p.proto);
    L.push("- name: " + yq(p.disp));
    L.push("  type: " + (p.proto === "trojan" ? "trojan" : p.proto === "vmess" ? "vmess" : "vless"));
    L.push("  server: " + yq(p.server));
    L.push("  port: " + p.port);
    if (p.proto === "trojan") {
      L.push("  password: " + yq(p.password));
    } else {
      L.push("  uuid: " + yq(p.uuid));
      if (p.proto === "vmess") {
        L.push("  alterId: " + (p.alterId || 0));
        L.push("  cipher: " + yq(p.cipher || "auto"));
      }
    }
    L.push("  network: " + net);
    L.push("  udp: true");
    const tlsOn = p.security === "tls" || p.security === "reality" || p.proto === "trojan";
    if (tlsOn) L.push("  tls: true");
    if (p.insecure) L.push("  skip-cert-verify: true");
    // flow (xtls-rprx-vision) is only valid over tcp/grpc
    if (p.flow && (net === "tcp" || net === "grpc")) L.push("  flow: " + yq(p.flow));
    if (p.sni) L.push("  servername: " + yq(p.sni));
    if (p.fp) L.push("  client-fingerprint: " + yq(p.fp));
    else if (p.security === "reality") L.push("  client-fingerprint: \"chrome\"");
    if (net === "ws") {
      if (p.path || p.ws_host) {
        L.push("  ws-opts:");
        if (p.path) L.push("    path: " + yq(p.path));
        if (p.ws_host) {
          L.push("    headers:");
          L.push("      Host: " + yq(p.ws_host));
        }
      }
    } else if (net === "grpc") {
      // grpc nodes without their service name can never connect — always emit the block
      L.push("  grpc-opts:");
      L.push("    grpc-service-name: " + yq(p.serviceName || ""));
    } else if (net === "h2") {
      L.push("  h2-opts:");
      if (p.ws_host) L.push("    host: [" + yq(p.ws_host) + "]");
      if (p.path) L.push("    path: " + yq(p.path));
    } else if (net === "http") {
      // mihomo expects http-opts path / Host header as LISTS
      L.push("  http-opts:");
      L.push("    path: [" + yq(p.path || "/") + "]");
      if (p.ws_host) {
        L.push("    headers:");
        L.push("      Host: [" + yq(p.ws_host) + "]");
      }
    }
    if (p.security === "reality") {
      L.push("  reality-opts:");
      if (p.pbk) L.push("    public-key: " + yq(p.pbk));
      if (p.sid) L.push("    short-id: " + yq(p.sid));
    }
  }
  return L.join("\n") + "\n";
}

export function quotaSummary(status) {
  const m = status.match(/↑:([\d.]+)GB,↓:([\d.]+)GB,TOT:([\d.]+)GB.*?Expires:([\d-]+)/);
  if (!m) return null;
  const up = parseFloat(m[1]), down = parseFloat(m[2]), tot = parseFloat(m[3]);
  return { up, down, tot, left: Math.max(tot - up - down, 0), exp: m[4] };
}

// ---------------- HTML ----------------
const CSS = `:root{--bg:#0b1220;--card:#141d31;--card2:#0e1626;--line:rgba(148,163,184,.14);--text:#e8eef8;--dim:#8ea0ba;--green:#34d399;--blue:#60a5fa}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:radial-gradient(1100px 500px at 50% -120px,rgba(37,99,235,.28),transparent),var(--bg);color:var(--text);display:flex;justify-content:center;align-items:flex-start;padding:28px 16px;min-height:100vh}
.card{background:linear-gradient(180deg,#17233c,#121a2c);border:1px solid var(--line);border-radius:22px;padding:24px;max-width:460px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.55);margin-top:12px}
h1{font-size:22px;margin:0 0 6px;font-weight:800;letter-spacing:.2px;text-align:center}
.sub{color:var(--dim);font-size:13px;text-align:center;margin:4px 0 16px;line-height:1.5}
.big{font-size:42px;font-weight:800;text-align:center;margin:12px 0 2px;background:linear-gradient(90deg,#34d399,#60a5fa);-webkit-background-clip:text;background-clip:text;color:transparent}
.big span{font-size:17px;font-weight:600;color:var(--dim);-webkit-text-fill-color:var(--dim)}
.bar{height:12px;background:#0c1424;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:14px 0 16px}
.fill{height:100%;background:linear-gradient(90deg,#34d399,#60a5fa)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid div{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.grid b{display:block;font-size:16px}
.grid span{font-size:12px;color:var(--dim)}
.exp{margin-top:12px;color:#fbbf24;font-size:14px;text-align:center;font-weight:700}
.btn{display:block;margin-top:10px;background:linear-gradient(90deg,#2563eb,#4f46e5);color:#fff;text-decoration:none;border:0;cursor:pointer;padding:13px;border-radius:11px;font-size:15px;text-align:center;font-weight:700;width:100%}
.btn.gray{background:#1b2740;border:1px solid var(--line);color:var(--text)}
.btn.green{background:linear-gradient(90deg,#059669,#10b981)}
label{display:block;font-size:14px;margin:12px 0 6px;color:#cbd5e1;font-weight:600}
input[type=text],textarea{width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:12px;font-size:15px;outline:none}
textarea{height:110px;resize:vertical}
input[type=submit]{width:100%;margin-top:14px;background:linear-gradient(90deg,#059669,#10b981);color:#fff;font-weight:800;border:0;padding:14px;border-radius:11px;font-size:16px;cursor:pointer}
.me{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:12px 13px;margin-top:10px}
.me .t{font-size:13px;color:var(--dim);margin-bottom:6px;line-height:1.5}
.me .u{font-size:13px;word-break:break-all;color:var(--blue);line-height:1.5}
.err{color:#f87171;font-size:15px;text-align:center;line-height:1.6;margin:10px 0}
.dim{color:var(--dim);font-size:12px;margin-top:14px;text-align:center;line-height:1.6}
.ok{color:var(--green);font-size:13px;text-align:center;margin-top:8px;font-weight:600}
.row{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}
.qr-wrap{background:#fff;border-radius:12px;padding:14px;margin:12px 0;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.qr-wrap svg{width:180px;height:180px;margin:0 auto;display:block}
.msg{font-size:13px;color:#cdd8e8;background:var(--card2);border-radius:10px;padding:12px;line-height:1.65;white-space:pre-wrap}
.steps{margin-top:16px;font-size:14px;line-height:1.85;color:#cbd5e1}`;

const page = (title, body, refresh) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="60">' : ""}
<title>${title}</title><style>${CSS}</style></head><body><div class="card">${body}</div></body></html>`;

const COPY_JS = `<script>function cp(id,ok){var t=document.getElementById(id).textContent.trim();
function d(){document.getElementById(ok).style.display='block'}
if(navigator.clipboard){navigator.clipboard.writeText(t).then(d)}
else{var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove();d()}}
function cm(k,ok){var el=document.getElementById(k);el.style.display='block';var t=el.textContent;
function d(){document.getElementById(ok).style.display='block'}
if(navigator.clipboard){navigator.clipboard.writeText(t).then(d)}
else{var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove();d()}}
function tqr(id){var el=document.getElementById(id);if(el)el.style.display=(el.style.display==='none'||!el.style.display)?'block':'none'}</script>`;

const homePage = () => page("Check your data", `
<h1>⚡ SP VPN — check your data</h1>
<div class="sub">paste your subscription link · 10 seconds</div>
<form method="post" action="/">
<label>Your subscription link (the one you use in Shadowrocket)</label>
<textarea name="link" placeholder="Paste your subscription link here"></textarea>
<input type="submit" value=" Show my quota">
</form>
<div class="steps">1️⃣ Paste the link your seller gave you<br>2️⃣ Tap <b>Show my quota</b><br>3️⃣ You'll get <b>your own personal link &amp; QR code</b> — save it. Next time you just tap it.<br><br>📱 Need to make a QR code? <a href="/qr" style="color:var(--blue)">Open QR Maker</a></div>`);

const formPage = (title, sub, action, btn) => page(title, `
<h1>⚡ ${title}</h1>
<div class="sub">${sub}</div>
<form method="post" action="${action}">
<label>Brand name (shown on every node &amp; link)</label>
<input type="text" name="brand" value="SP VPN" maxlength="40">
<label>Supplier link(s) — one per line (up to 20)</label>
<textarea name="links" placeholder="https://provider.example/api/sub?token=…"></textarea>
<input type="submit" value="${btn}">
</form>
<div class="steps">For each link you get: ✨ ONE link (all apps) · 📱 QR Code (scan &amp; go) · 🔗 live quota link · 📋 ready-to-send message · <a href="/qr" style="color:var(--blue)">QR Maker</a></div>`);

const errorPage = (msg) => page("Error", `
<h1>⚡ SP VPN</h1>
<div class="err">${msg}</div>
<a class="btn" href="/">← Back</a>
<div class="dim">If your plan was renewed, use the NEW link.</div>`);

function quotaBody(host, tok, brand, status, proxies, linksTotal) {
  const s = quotaSummary(status);
  const one = `${host}/all/${encodeURIComponent(brand)}?t=${encodeURIComponent(tok)}`;
  const sub = `${host}/sub/${encodeURIComponent(tok)}?brand=${encodeURIComponent(brand)}`;
  let quota;
  if (s) {
    const pct = Math.min(100, ((s.tot - s.left) / s.tot) * 100);
    quota = `<div class="big">${s.left.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} <span>GB left</span></div>
<div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
<div class="grid">
  <div><b>${s.tot.toFixed(0)} GB</b><span>total plan</span></div>
  <div><b>${(s.up + s.down).toFixed(2)} GB</b><span>used</span></div>
  <div><b>↑ ${s.up.toFixed(2)} GB</b><span>uploaded</span></div>
  <div><b>↓ ${s.down.toFixed(2)} GB</b><span>downloaded</span></div>
</div>
<div class="exp">💡 Expires: ${s.exp}</div>`;
  } else {
    quota = `<div class="err">Quota text not recognized.<br>${status || "No status from provider."}</div>`;
  }
  return `
<h1>⚡ ${brand} — your data</h1>
<div class="sub">updated ${new Date().toISOString().slice(11, 16)} UTC · auto-refreshes every 60s</div>
${quota}
<div class="dim" style="text-align:center;margin-top:10px">${proxies.length} of ${linksTotal} nodes ready</div>
<div class="me"><div class="t">🔗 <b>YOUR personal link</b> — save it:</div><div class="u" id="pl">${one}</div></div>
<div style="display:flex;gap:8px">
<button class="btn gray" style="flex:1;margin-top:8px" onclick="cp('pl','cop1')">📋 Copy personal link</button>
<button class="btn gray" style="flex:1;margin-top:8px" onclick="tqr('qr_pl')">📱 Show QR</button>
</div>
<div class="ok" id="cop1" style="display:none">✅ copied</div>
<div id="qr_pl" class="qr-wrap" style="display:none">
  ${generateQrSvg(one, { title: "Personal Quota Link" })}
  <div style="color:#334155;font-size:12px;font-weight:600;margin-top:6px">Scan to open your live data page</div>
</div>

<div class="me" style="margin-top:14px"><div class="t">✨ <b>ONE VPN LINK — all apps</b> (Shadowrocket / v2rayNG / Clash / Hiddify — auto-detects, named "${brand}", English node names):</div><div class="u" id="al">${one}</div></div>
<div style="display:flex;gap:8px">
<button class="btn green" style="flex:1;margin-top:8px" onclick="cp('al','copa')">📋 Copy ONE link</button>
<button class="btn gray" style="flex:1;margin-top:8px" onclick="tqr('qr_al')">📱 Show QR</button>
</div>
<div class="ok" id="copa" style="display:none">✅ copied — that's all your client needs</div>
<div id="qr_al" class="qr-wrap" style="display:none">
  ${generateQrSvg(one, { title: "ONE VPN Link" })}
  <div style="color:#334155;font-size:12px;font-weight:600;margin-top:6px">Scan in Shadowrocket, Clash, or v2rayNG</div>
</div>

<div class="me" style="margin-top:14px"><div class="t">🔄 <b>Clash auto-update</b> (Verge/Fugu): Profiles → New → remote URL:</div><div class="u" id="su">${sub}</div></div>
<div style="display:flex;gap:8px">
<button class="btn gray" style="flex:1;margin-top:8px" onclick="cp('su','cop2')">📋 Copy Clash link</button>
<button class="btn gray" style="flex:1;margin-top:8px" onclick="tqr('qr_su')">📱 Show QR</button>
</div>
<div class="ok" id="cop2" style="display:none">✅ copied</div>
<div id="qr_su" class="qr-wrap" style="display:none">
  ${generateQrSvg(sub, { title: "Clash Auto-Update Link" })}
  <div style="color:#334155;font-size:12px;font-weight:600;margin-top:6px">Scan in Clash Meta / Verge</div>
</div>
${COPY_JS}`;
}

function rebrandResults(host, brand, rows) {
  const parts = [`<h1>⚡ Rebranded as ${brand}</h1><div class="sub">${rows.length} link(s) · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</div>`];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.error) { parts.push(`<div class="row"><b>Link ${n}</b><div class="err">❌ ${r.error}</div></div>`); return; }
    const one = `${host}/all/${encodeURIComponent(brand)}?t=${encodeURIComponent(r.tok)}`;
    parts.push(`<div class="row"><b>Link ${n} — ${r.proxies.length} nodes</b>
${r.summary ? `<div class="dim" style="text-align:center">🚀 ${r.summary.left.toFixed(2)} GB left · expires ${r.summary.exp}</div>` : ""}
<div class="me"><div class="t">✨ <b>ONE LINK — works in all apps</b> (Shadowrocket, v2rayNG, NekoBox, Hiddify, Clash):</div><div class="u" id="al${n}">${one}</div></div>
<div class="me"><div class="t">🔗 <b>Client's private quota</b> link (live GB, auto-refresh):</div><div class="u" id="pl${n}">${one}</div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<button class="btn green" style="flex:1;min-width:120px;margin-top:8px" onclick="cp('al${n}','cosp${n}')">📋 Copy one link</button>
<button class="btn gray" style="flex:1;min-width:120px;margin-top:8px" onclick="tqr('qr_al${n}')">📱 Show QR</button>
<button class="btn gray" style="flex:1;min-width:120px;margin-top:8px" onclick="cp('pl${n}','cosp2${n}')">📋 Copy quota link</button>
</div>
<div class="ok" id="cosp${n}" style="display:none">✅ copied</div>
<div class="ok" id="cosp2${n}" style="display:none">✅ copied</div>
<div id="qr_al${n}" class="qr-wrap" style="display:none">
  ${generateQrSvg(one, { title: "ONE Link " + n })}
  <div style="color:#334155;font-size:12px;font-weight:600;margin-top:6px">Scan with Shadowrocket, Clash, or v2rayNG</div>
</div></div>`);
  });
  parts.push(COPY_JS);
  return page(`Rebranded as ${brand}`, parts.join(""));
}

function toolResults(host, brand, rows) {
  const parts = [`<h1>⚡ ${brand} — client packs</h1><div class="sub">${rows.length} link(s) · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</div>`];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.error) { parts.push(`<div class="row"><b>Link ${n}</b><div class="err">❌ ${r.error}</div></div>`); return; }
    const one = `${host}/all/${encodeURIComponent(brand)}?t=${encodeURIComponent(r.tok)}`;
    const sub = `${host}/sub/${encodeURIComponent(r.tok)}?brand=${encodeURIComponent(brand)}`;
    const msg = `Here's your ${brand} setup 🚀

1) VPN — add this ONE link in your app (Shadowrocket / v2rayNG / NekoBox / Hiddify / Clash — auto-detects, arrives named "${brand}"):
${one}
   Clash (Verge/Fugu) users — use this instead, it auto-updates:
${sub}

2) Check your data anytime (live):
${one}

If your plan renews: open ${one} and paste your new subscription link.`;
    parts.push(`<div class="row"><b>Link ${n} — ${r.proxies.length} nodes</b>
${r.summary ? `<div class="dim" style="text-align:center">🚀 ${r.summary.left.toFixed(2)} GB left · expires ${r.summary.exp}</div>` : ""}
<div class="me"><div class="t">✨ <b>ONE LINK — all apps</b>:</div><div class="u" id="al${n}">${one}</div></div>
<div class="me"><div class="t">🔄 <b>Clash auto-update</b> link:</div><div class="u" id="su${n}">${sub}</div></div>
<div class="me"><div class="t">🔗 <b>Client's private quota</b> link:</div><div class="u" id="pl${n}">${one}</div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<button class="btn" style="flex:2;min-width:140px;margin-top:8px" onclick="cm('m${n}','copm${n}')">📋 Copy message</button>
<button class="btn gray" style="flex:1;min-width:100px;margin-top:8px" onclick="tqr('qr_tool${n}')">📱 Show QR</button>
</div>
<div class="msg" id="m${n}" style="display:none">${msg.replace(/</g, "&lt;")}</div>
<div class="ok" id="copm${n}" style="display:none">✅ message copied — send it to your client</div>
<div id="qr_tool${n}" class="qr-wrap" style="display:none">
  ${generateQrSvg(one, { title: "ONE Link " + n })}
  <div style="color:#334155;font-size:12px;font-weight:600;margin-top:6px">Scan with Shadowrocket, Clash, or v2rayNG</div>
</div></div>`);
  });
  parts.push(COPY_JS);
  return page(`${brand} — client packs`, parts.join(""));
}

// ---------------- router ----------------
async function collectRows(brand, linksText, host) {
  const links = linksText.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith("http://") || l.startsWith("https://") || /^[a-z0-9+.-]+:\/\//i.test(l)).slice(0, 20);
  const rows = [];
  // Up to 20 links may be pasted here; one 7s budget is shared across all of
  // them so a seller page can't multiply the platform limit either.
  const deadline = Date.now() + FETCH_BUDGET_MS;
  for (const link of links) {
    const isNodeLink = !/^https?:\/\//i.test(link);
    const key = isNodeLink ? "direct:" + link : link;
    // Opaque token — the supplier link is stored server-side, never in the URL.
    const tok = await storeMint(key, "seller-tool");
    try {
      if (isNodeLink) {
        const ns = link.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const proxies = ns.map(parseNode).filter(Boolean);
        if (!proxies.length) { rows.push({ tok, error: "link contained no nodes" }); continue; }
        rows.push({ tok, status: "", proxies, summary: null, linksTotal: ns.length });
      } else {
        const left = deadline - Date.now();
        if (left <= 0) { rows.push({ tok, error: "skipped — supplier fetch budget used up by earlier links" }); continue; }
        const { status, links: ls } = await fetchSubscription(link, left);
        if (!ls.length) { rows.push({ tok, error: "link opened but contained no nodes" }); continue; }
        const proxies = ls.map(parseNode).filter(Boolean);
        rows.push({ tok, status, proxies, summary: quotaSummary(status), linksTotal: ls.length });
      }
    } catch (e) {
      rows.push({ tok, error: "could not read link (" + e.message + ")" });
    }
  }
  return rows;
}

// ---------------- data (with 5-min cache to protect the supplier) ----------------
const _cache = new Map();
const TTL = 300000;

// Health-report cache: an open dashboard polls /admin/health, and the report
// itself fetches the supplier — cache it so polling cannot hammer the panel.
const HEALTH_TTL_MS = 120000;
let _healthCache = { t: 0, report: null };

async function getDecoded(tok) {
  // Token state is resolved on EVERY request so revocation takes effect
  // immediately; only the expensive supplier fetch is memoised below.
  let url = null;
  try {
    url = await storeResolve(tok);
  } catch (e) {
    // Store unreachable: serve a cached payload rather than killing every
    // student's VPN because the database had a blip.
    const stale = _cache.get(tok);
    if (stale && Date.now() - stale.t < TTL) return stale.d;
    throw e;
  }
  if (!url) throw new Error("unknown or revoked link");

  const hit = _cache.get(tok);
  if (hit && Date.now() - hit.t < TTL) return hit.d;
  let d;
  if (url.startsWith("direct:")) {
    const ns = url.slice(7).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    d = { status: "", links: ns, proxies: ns.map(parseNode).filter(Boolean) };
  } else {
    const { status, links } = await fetchSubscription(url);
    d = { status, links, proxies: links.map(parseNode).filter(Boolean) };
  }
  _cache.set(tok, { t: Date.now(), d });
  return d;
}

const html = (doc, title) => {
  const t = String(doc).trimStart();
  const isFull = t.startsWith("<!doctype") || t.startsWith("<html");
  const out = isFull ? doc : page(title || "SP VPN", doc);
  return new Response(out, { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
const plain = (body, extra) => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", ...extra } });
const yamlRes = (body, extra) => new Response(body, { headers: { "Content-Type": "text/yaml; charset=utf-8", ...extra } });
// Real errors must return a real HTTP error status. Apps used to receive a 200
// HTML page and then showed a confusing "parse error" instead of the reason.
const plainErr = (msg, code = 502) => new Response(msg + "\n", {
  status: code,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
});

// Standard subscription headers (subconverter spec): Clash Verge / v2rayNG show
// live quota + expiry next to the profile, and "home page" links to the quota page.
const json = (obj, code = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2) + "\n", {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
// The admin output must never hand back a supplier URL in full — that is the
// exact secret this whole change exists to protect. Host only.
const generatedKind = (r) => r.label === "quota-page" ? "quota-page" : r.label === "seller-tool" ? "seller-tool" : null;
const redact = (r, accounts = supplierAccounts([r])) => ({
  token: r.token,
  label: r.label,
  system_generated: isSystemGeneratedRow(r),
  system_kind: isSystemGeneratedRow(r) ? generatedKind(r) : null,
  customer: r.customer || null,
  customer_type: customerType(r),
  supplier_account: accounts.get(supplierKey(r.supplier_url)) || null,
  plan: r.plan || null,
  price: r.price ?? null,
  currency: r.currency || null,
  billing_cycle: r.billing_cycle || null,
  paid_until: r.paid_until || null,
  notes: r.notes || null,
  // The reseller's login on the supplier panel for this customer — used to
  // renew the account. Shown only on /admin routes.
  account_email: r.account_email || null,
  account_password: r.account_password || null,
  supplier_expires: r.supplier_expires || null,
  total_gb: r.total_gb ?? null,
  used_gb: r.used_gb ?? null,
  // Usage movement since the immediately previous SUCCESSFUL check.
  // usage_delta_gb is null until a customer has been checked twice — the
  // dashboard renders that as "no comparison yet" rather than "no new usage".
  prev_used_gb: r.prev_used_gb ?? null,
  usage_delta_gb: r.usage_delta_gb ?? null,
  usage_change: usageKind(r.usage_delta_gb ?? null),
  usage_message: usageMessage(r.usage_delta_gb ?? null),
  checked_at: r.checked_at || null,
  revoked: !!r.revoked,
  created_at: r.created_at,
  // price - catalogue cost of the plan (null when the plan is unknown).
  // Anonymous quota/tool links are not customers, so they never carry profit.
  profit: isSystemGeneratedRow(r) ? null : profitOf(r),
  supplier_host: (() => {
    try { return new URL(r.supplier_url).host; } catch (e) { return "direct-node-list"; }
  })(),
  legacy: r.label === "legacy",
});

function subHeaders(status, pageUrl) {
  const h = {};
  const s = quotaSummary(status);
  if (s) {
    const G = 1073741824;
    const exp = Math.floor(Date.parse(s.exp + "T00:00:00Z") / 1000);
    h["subscription-userinfo"] =
      `upload=${Math.round(s.up * G)}; download=${Math.round(s.down * G)}; total=${Math.round(s.tot * G)}` +
      (exp ? `; expire=${exp}` : "");
  }
  if (pageUrl) {
    h["profile-web-page-url"] = pageUrl;
    h["profile-update-interval"] = "6";
  }
  return h;
}


export default {
  async fetch(request, env, ctx) {
    if (env && (env.DB || env.TOKEN_STORE_URL)) storeSetBackend(null);
    await storeInit(env).catch(() => {}); // a backend hiccup must not 500 every route
    // m0 is declared here rather than down with the route variables: the admin
    // routes use it, and a let-declaration further down would be hoisted into
    // a temporal dead zone.
    let url, path, m0;
    try {
      url = new URL(request.url);
      path = url.pathname;
      const host = `${request.headers.get("x-forwarded-proto") || "https"}://${url.host}`;

      if (request.method === "POST") {
        const data = Object.fromEntries(new URLSearchParams(await request.text()));
        const brand = (data.brand || "SP VPN").trim().slice(0, 40) || "SP VPN";
        if (path === "/rebrand" || path === "/tool") {
          const rows = await collectRows(brand, data.links || "", host);
          if (!rows.length) return html(errorPage("No valid links found — paste the subscription URL your supplier gave you (starts with http or https)"));
          return html((path === "/tool" ? toolResults : rebrandResults)(host, brand, rows));
        }
        if (path === "/admin/inspect") {
          // The dashboard's "paste a link, we fill the form" helper: fetch the
          // subscription once and return everything derivable from it — quota,
          // expiry, node count. The supplier URL itself never goes back out.
          const link = (data.link || "").trim();
          if (!/^(https?:\/\/|[a-z0-9+.-]+:\/\/)/i.test(link)) {
            return json({ ok: false, error: "link must be a subscription URL or node link" }, 400);
          }
          try {
            if (!/^https?:\/\//i.test(link)) {
              // Direct node link(s) — no panel behind them, so no quota/expiry.
              const ns = link.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              const proxies = ns.map(parseNode).filter(Boolean);
              return json({ ok: true, direct: true, nodes: ns.length, validNodes: proxies.length });
            }
            const { status, links } = await fetchSubscription(link);
            const s = quotaSummary(status);
            const used = s ? Math.round((s.up + s.down) * 100) / 100 : null;
            return json({
              ok: true,
              nodes: links.length,
              validNodes: links.map(parseNode).filter(Boolean).length,
              expires: s ? s.exp : null,
              total_gb: s ? s.tot : null,
              used_gb: used,
              left_gb: s ? Math.round(s.left * 100) / 100 : null,
              used_pct: s && s.tot ? Math.round(((s.up + s.down) / s.tot) * 1000) / 10 : null,
              // Matched plan price from the catalogue (null when the quota
              // is not a known plan) so the form can auto-fill pricing.
              pricing: s && PLAN_CATALOG[s.tot] ? PLAN_CATALOG[s.tot] : null,
            });
          } catch (e) {
            return json({ ok: false, error: String(e.message || e) }, 502);
          }
        }
        if (path === "/admin/shared-link") {
          try {
            const source = resolveCustomerLink(data.link, host, await storeList(), "shared");
            return json({ account: source.account });
          } catch (e) {
            return json({ error: e.status ? e.message : "Could not look up the supplier account." }, e.status || 500);
          }
        }
        if (path === "/admin/shared-users") {
          // Discovery is read-only and GET-based; never accept a POST body here.
          return json({ error: "Shared-user discovery supports GET only." }, 405, { Allow: "GET", "Cache-Control": "no-store" });
        }
        if (path === "/admin/mint") {
          const type = data.customer_type || "individual";
          if (!validCustomerType(type)) return json({ error: "customer_type must be individual or shared" }, 400);
          if (data.paid_until) return json({ error: "Create the customer first, then use Pay to record their payment." }, 400);
          const label = (data.label || "").trim().slice(0, 200) || null;
          let source;
          try { source = resolveCustomerLink(data.link, host, await storeList(), type); }
          catch (e) { return json({ error: e.status ? e.message : "Could not look up the supplier account." }, e.status || 500); }
          const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));
          const txt = (v) => (v ? String(v).trim().slice(0, 200) : null);
          // Details detected up front by POST /admin/inspect (the dashboard's
          // auto-fill). Stored at creation so the row shows live quota + expiry
          // immediately, with no separate Refresh click. Strictly validated —
          // junk fields are dropped, never stored.
          const dateOnly = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim()) ? String(v).trim() : null);
          const gb = (v) => { const n = num(v); return Number.isFinite(n) && n >= 0 ? n : null; };
          const detected = {
            supplier_expires: dateOnly(data.supplier_expires),
            total_gb: gb(data.total_gb),
            used_gb: gb(data.used_gb),
          };
          const hasDetected = detected.supplier_expires != null || detected.total_gb != null || detected.used_gb != null;
          const token = await storeMint(source.supplierUrl, label, {
            customer: txt(data.customer),
            customer_type: type,
            supplier_account: type === "shared" ? source.sourceRow?.supplier_account || null : txt(data.supplier_account) || source.sourceRow?.supplier_account || null,
            plan: txt(data.plan),
            price: num(data.price),
            currency: txt(data.currency),
            billing_cycle: txt(data.billing_cycle),
            notes: txt(data.notes),
            account_email: type === "shared" ? source.sourceRow?.account_email || null : txt(data.account_email),
            account_password: type === "shared" ? source.sourceRow?.account_password || null : txt(data.account_password),
            ...(hasDetected ? { ...detected, checked_at: new Date().toISOString() } : {}),
          });
          return json({ token, oneLink: `${host}/all/${encodeURIComponent(brand)}?t=${token}` });
        }
        if ((m0 = path.match(/^\/admin\/link\/([^/]+)$/)) && ["pay", "paid", "unpaid"].includes(url.searchParams.get("action"))) {
          const t = m0[1];
          const rows = await storeList();
          const cur = rows.find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          if (cur.revoked) return json({ error: "cannot record payment for a revoked customer" }, 400);
          const unpaid = url.searchParams.get("action") === "unpaid";
          const paidUntil = unpaid ? null : (data.paid_until || "").trim();
          if (!unpaid && !validPaidUntil(paidUntil)) return json({ error: "Choose a valid paid-until date (today or later)." }, 400);
          // Deliberately update ONE customer by token, not everyone on the
          // supplier URL. Do not fetch the supplier or infer that they paid.
          const updated = await storeUpdate(t, { paid_until: paidUntil });
          return updated ? json({ ...redact(updated, supplierAccounts(rows)), ok: true, paid: !unpaid, customer: redact(updated, supplierAccounts(rows)) }) : json({ error: "unknown token" }, 404);
        }
        if (path === "/admin/reminders") {
          const out = await runRemindersFromEnv(env || {}, {
            listAll: storeList, updateRow: storeUpdate,
            hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
          }, { fetchSubscription, quotaSummary });
          return json(out);
        }
        if (path === "/admin/customer") {
          if (data.paid_until !== undefined) return json({ error: "Use Pay to record a customer's payment." }, 400);
          if (data.customer_type !== undefined && !validCustomerType(data.customer_type)) {
            return json({ error: "customer_type must be individual or shared" }, 400);
          }
          const rows = await storeList();
          const cur = rows.find((r) => r.token === data.token);
          if (!cur) return json({ error: "unknown token" }, 404);
          const patchObj = {};
          for (const k of ["customer", "customer_type", "plan", "currency", "billing_cycle", "notes", "label"]) {
            if (data[k] !== undefined) patchObj[k] = data[k] ? String(data[k]).trim().slice(0, 200) : null;
          }
          if (data.price !== undefined) patchObj.price = data.price === "" ? null : Number(data.price);
          if (data.revoked !== undefined) patchObj.revoked = data.revoked === "1";
          // An account name belongs to the supplier link. Renaming it on the
          // original customer also updates its shared customers, not billing.
          if ((data.customer_type || customerType(cur)) === "individual") {
            const accountPatch = {};
            for (const key of ["supplier_account", "account_email", "account_password"]) {
              if (data[key] !== undefined) accountPatch[key] = String(data[key]).trim().slice(0, 200) || null;
            }
            if (Object.keys(accountPatch).length) {
              for (const row of rows.filter((r) => supplierKey(r.supplier_url) === supplierKey(cur.supplier_url))) {
                await storeUpdate(row.token, accountPatch);
              }
            }
          }
          const updated = await storeUpdate(cur.token, patchObj);
          return updated ? json(redact(updated, supplierAccounts(await storeList()))) : json({ error: "unknown token" }, 404);
        }
        if (path === "/") {
          const link = (data.link || "").trim();
          if (!link) return html(homePage());
          if (!/^https?:\/\//i.test(link)) return html(errorPage("That doesn't look like a link — it should start with http or https."));
          await fetchSubscription(link);
          const qtok = await storeMint(link, "quota-page");
          return new Response(null, { status: 302, headers: { Location: "/q/" + qtok } });
        }
        return html(errorPage("Not found"));
      }

      // GET
      if (path === "/healthz") return plain("ok");

      // ---- dashboard ----
      if (path === "/admin" || path === "/admin/dashboard") {
        return new Response(dashboardPage(host), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/admin/dashboard.json") {
        const rows = await storeList();
        const accounts = supplierAccounts(rows);
        // `store` names the active backend ("turso" | "sqlite-file" | "memory" |
        // "d1") so a misconfigured deploy is visible from the dashboard itself:
        // "memory" means TOKEN_STORE_URL was NOT picked up and links will not
        // survive a cold start.
        return json({ generated: new Date().toISOString(), store: storeBackend().name, stats: summarise(rows), customers: rows.map((r) => redact(r, accounts)) });
      }
      if (path === "/admin/health") {
        // Live health of the whole pipeline: token store -> supplier -> the
        // converter itself (end-to-end, fetched like a customer's app would).
        // Cached 2 minutes so a polling dashboard cannot hammer the supplier.
        // ?force=1 bypasses the cache.
        const force = url.searchParams.get("force") === "1";
        if (_healthCache.report && !force && Date.now() - _healthCache.t < HEALTH_TTL_MS) {
          return json({ ..._healthCache.report, cached: true, age_ms: Date.now() - _healthCache.t });
        }
        const report = { generated: new Date().toISOString(), checks: {} };
        let rows = [];
        try {
          const t0 = Date.now();
          rows = await storeList();
          report.checks.store = {
            ok: true, ms: Date.now() - t0, backend: storeBackend().name,
            customers: rows.filter((r) => !isSystemGeneratedRow(r)).length,
            generated: rows.filter(isSystemGeneratedRow).length,
            active: rows.filter((r) => !r.revoked && !isSystemGeneratedRow(r)).length,
          };
        } catch (e) {
          report.checks.store = { ok: false, error: String(e.message || e) };
        }
        if (report.checks.store.ok) {
          const active = rows.filter((r) => !r.revoked && !isSystemGeneratedRow(r));
          // One representative supplier link per unique supplier host.
          const byHost = new Map();
          for (const r of active) {
            try { const h = new URL(r.supplier_url).host; if (!byHost.has(h)) byHost.set(h, r); } catch (e) {}
          }
          report.checks.supplier = { ok: true, hosts: {} };
          await Promise.all([...byHost.entries()].slice(0, 5).map(async ([h, r]) => {
            const t0 = Date.now();
            try {
              const { status, links } = await fetchSubscription(r.supplier_url);
              const s = quotaSummary(status);
              report.checks.supplier.hosts[h] = {
                ok: true, ms: Date.now() - t0, nodes: links.length,
                quota_parsed: !!s, expires: s ? s.exp : null,
              };
            } catch (e) {
              report.checks.supplier.ok = false;
              report.checks.supplier.hosts[h] = { ok: false, ms: Date.now() - t0, error: String(e.message || e) };
            }
          }));
          // Converter end-to-end: fetch our own one-link exactly like a
          // customer's VPN app does — exercises worker -> supplier -> cache ->
          // transform -> base64, the full path.
          const target = active[0];
          if (target) {
            const t0 = Date.now();
            try {
              const one = `${host}/all/${encodeURIComponent(target.label || "SP VPN")}?t=${encodeURIComponent(target.token)}`;
              const { status, links } = await fetchSubscription(one);
              report.checks.converter = {
                ok: true, ms: Date.now() - t0, nodes: links.length,
                quota_parsed: !!quotaSummary(status),
              };
            } catch (e) {
              report.checks.converter = { ok: false, ms: Date.now() - t0, error: String(e.message || e) };
            }
          } else {
            report.checks.converter = { ok: true, skipped: "no active customers yet" };
          }
        }
        const c = report.checks;
        report.ok = !!(c.store && c.store.ok && c.supplier && c.supplier.ok && c.converter && c.converter.ok);
        report.level = !(c.store && c.store.ok) || !(c.converter && c.converter.ok) ? "down"
          : !(c.supplier && c.supplier.ok) ? "degraded" : "ok";
        report.note = "Supplier and converter checks run from our server — they prove the pipeline works end-to-end. They cannot measure China-to-node latency: VPN traffic never flows through this server.";
        _healthCache = { t: Date.now(), report };
        return json(report);
      }
      if (path === "/admin/compare") {
        // Diagnostics — byte-diff the ORIGINAL supplier subscription against two
        // converter one-links. `a` and `b` must be https://*.netlify.app URLs;
        // the original supplier URL is recovered from B's ?t= base64 token (the
        // sp-global link format embeds it). Returns comparison facts only.
        const a = url.searchParams.get("a") || "";
        const b = url.searchParams.get("b") || "";
        if (!/^https:\/\/[a-z0-9-]+\.netlify\.app\//i.test(a) || !/^https:\/\/[a-z0-9-]+\.netlify\.app\//i.test(b)) {
          return json({ error: "a and b must be https://<site>.netlify.app/… URLs" }, 400);
        }
        let supplier = "";
        try { supplier = b64d(new URL(b).searchParams.get("t") || ""); } catch (e) { supplier = ""; }
        if (!/^[a-z0-9+.-]+:\/\//i.test(supplier)) {
          return json({ error: "could not recover the supplier URL from b's token (expected the sp-global base64 link format)" }, 400);
        }
        const grab = async (u) => {
          const t0 = Date.now();
          try {
            const { status, links } = await fetchSubscription(u);
            return { ok: true, ms: Date.now() - t0, status, links };
          } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e.message || e) }; }
        };
        // Two original fetches: if the supplier rotates nodes between requests,
        // that — not the converters — explains any set differences.
        const [o, ra, rb, o2] = await Promise.all([grab(supplier), grab(a), grab(b), grab(supplier)]);

        const uri = (l) => l.split("#")[0].toLowerCase(); // case-insensitive, as apps parse it
        const setName = (l) => safeDecode(l.split("#")[1] || "");
        const hostOf = (u) => String(u.split("@")[1] || u).split(/[?:]/)[0];
        const set = (links) => new Set(links.map(uri));
        const base = {
          fetched: {
            original: { ok: o.ok, ms: o.ms, nodes: o.links ? o.links.length : 0, status: o.status || o.error },
            a: { ok: ra.ok, ms: ra.ms, nodes: ra.links ? ra.links.length : 0, status: ra.status || ra.error },
            b: { ok: rb.ok, ms: rb.ms, nodes: rb.links ? rb.links.length : 0, status: rb.status || rb.error },
          },
        };
        if (!(o.ok && ra.ok && rb.ok)) return json(base);

        const oSet = set(o.links), aSet = set(ra.links), bSet = set(rb.links);
        const diff = (xSet) => ({
          identical: [...oSet].filter((u) => xSet.has(u)).length + "/" + oSet.size,
          missing_from_it: [...oSet].filter((u) => !xSet.has(u)).map(hostOf).slice(0, 12),
          extra_in_it: [...xSet].filter((u) => !oSet.has(u)).map(hostOf).slice(0, 12),
        });
        const aMap = new Map(ra.links.map((l) => [uri(l), l]));
        const bMap = new Map(rb.links.map((l) => [uri(l), l]));
        const perfect =
          [...oSet].every((u) => aSet.has(u)) && aSet.size === oSet.size &&
          [...oSet].every((u) => bSet.has(u)) && bSet.size === oSet.size;
        return json({
          ...base,
          counts: { original: o.links.length, a: ra.links.length, b: rb.links.length },
          a_vs_original: diff(aSet),
          b_vs_original: diff(bSet),
          a_vs_b: {
            identical_sets: aSet.size === bSet.size && [...aSet].every((u) => bSet.has(u)),
            only_in_a: [...aSet].filter((u) => !bSet.has(u)).map(hostOf).slice(0, 12),
            only_in_b: [...bSet].filter((u) => !aSet.has(u)).map(hostOf).slice(0, 12),
            same_order: ra.links.map(uri).join() === rb.links.map(uri).join(),
          },
          supplier_rotation: o2.ok
            ? {
                nodes_second_fetch: o2.links.length,
                uri_diffs_between_two_original_fetches:
                  [...oSet].filter((u) => !set(o2.links).has(u)).length +
                  [...set(o2.links)].filter((u) => !oSet.has(u)).length,
              }
            : { error: o2.error },
          name_samples: o.links.slice(0, 8).map((l) => ({
            original: setName(l),
            a: aMap.has(uri(l)) ? setName(aMap.get(uri(l))) : "(missing)",
            b: bMap.has(uri(l)) ? setName(bMap.get(uri(l))) : "(missing)",
          })),
          verdict: perfect
            ? "✅ both converters pass the original nodes through byte-identically — same servers, ports, UUIDs, REALITY keys; only display names are rebranded"
            : "⚠️ differences found — see missing/extra lists (check supplier_rotation: if the source itself changes between fetches, rotation explains it)",
          note: "VPN traffic never flows through either converter — apps connect directly to the node servers. The subscription file is downloaded once; it cannot change node speed or cause timeouts.",
        });
      }
      if (path === "/admin/refresh") {
        const rows = (await storeList()).filter((r) => !r.revoked && !isSystemGeneratedRow(r));
        // Bounded parallelism: the supplier panel must not see a burst of 50
        // concurrent fetches just because you opened the dashboard.
        const CONC = 6;
        let updated = 0, failed = 0;
        // Index-assigned (not pushed) so the report order matches the table
        // order rather than whichever supplier answered first.
        const results = new Array(rows.length);
        for (let i = 0; i < rows.length; i += CONC) {
          const batch = rows.slice(i, i + CONC);
          await Promise.all(batch.map(async (r, k) => {
            // Same single-customer code path as the per-row Renew / Check, so
            // the global refresh calculates and persists the usage delta for
            // every customer it successfully checks. A customer whose supplier
            // fails keeps its previous values AND its previous delta.
            const out = await checkCustomerRow(r, {
              fetchSubscription, quotaSummary, updateRow: storeUpdate,
            });
            const base = { token: r.token, customer: r.customer || r.label || null };
            if (!out.ok) {
              failed++;
              results[i + k] = { ...base, ok: false, error: out.error };
              return;
            }
            updated++;
            results[i + k] = {
              ...base,
              ok: true,
              renewed: out.expiryChanged,
              marked_paid: out.markedPaid,
              paid_until: out.paidUntil,
              supplier_expires: out.row.supplier_expires ?? null,
              used_gb: out.row.used_gb ?? null,
              usage_delta_gb: out.usageDeltaGb,
              usage_change: out.usageKind,
              message: out.message,
              usage_message: out.usageMessage,
            };
          }));
        }
        const done = results.filter(Boolean);
        return json({
          checked: rows.length,
          updated,
          failed,
          renewed: done.filter((x) => x.ok && x.renewed).length,
          marked_paid: done.filter((x) => x.ok && x.marked_paid).length,
          results: done,
        });
      }

      // ---- link lifecycle ----
      if ((m0 = path.match(/^\/admin\/link\/([^/]+)$/))) {
        const t = m0[1];
        const action = url.searchParams.get("action");
        if (["pay", "paid", "unpaid"].includes(action)) return json({ error: "Use POST to update a payment." }, 405, { Allow: "POST" });
        if (action === "check" || action === "renew") {
          // "Renew / Check" — you renewed this ONE customer with the supplier
          // by hand; this verifies it landed. It re-reads only this customer's
          // saved subscription and persists what the supplier now reports.
          // It never buys, renews or changes anything on the supplier side.
          const rows = await storeList();
          const cur = rows.find((r) => r.token === t);
          if (!cur) return json({ ok: false, token: t, error: "unknown token" }, 404);
          const out = await checkCustomerRow(cur, {
            fetchSubscription, quotaSummary, updateRow: storeUpdate,
          });
          // A failed check writes nothing — the row keeps its previous expiry,
          // quota and usage delta.
          if (!out.ok) return json({ ok: false, token: t, error: out.error }, out.code);
          return json({
            ok: true,
            token: t,
            renewed: out.expiryChanged,
            expiryChanged: out.expiryChanged,
            expiry: out.row.supplier_expires ?? null,
            previousExpiry: out.previous.supplier_expires,
            usageDeltaGb: out.usageDeltaGb,
            usedGb: out.row.used_gb ?? null,
            previousUsedGb: out.previous.used_gb,
            expiry_changed: out.expiryChanged,
            marked_paid: out.markedPaid,
            paid_until: out.paidUntil,
            previous_paid_until: out.previous.paid_until,
            previous_expiry: out.previous.supplier_expires,
            supplier_expires: out.row.supplier_expires ?? null,
            previous_used_gb: out.previous.used_gb,
            used_gb: out.row.used_gb ?? null,
            total_gb: out.row.total_gb ?? null,
            usage_delta_gb: out.usageDeltaGb,
            usage_change: out.usageKind,
            checked_at: out.row.checked_at || null,
            message: out.message,
            usage_message: out.usageMessage,
            // Redacted so the refreshed row can be merged straight into the
            // dashboard table without a full reload — and without ever
            // carrying the supplier URL.
            customer: redact(out.row, supplierAccounts(rows)),
          });
        }
        if (action === "rotate") {
          const cur = (await storeList()).find((r) => r.token === t);
          if (!cur) return json({ error: "unknown token" }, 404);
          // Carry the customer's details onto the new link, but never its
          // identity: token / created_at / revoked belong to the new row.
          const carry = {};
          // prev_used_gb / usage_delta_gb ride along so a rotated link keeps
          // the usage comparison it had; everything else is unchanged.
          for (const k of ["customer", "customer_type", "supplier_account", "account_email", "account_password", "plan", "price", "currency", "billing_cycle", "paid_until", "notes", "supplier_expires", "total_gb", "used_gb", "checked_at", "prev_used_gb", "usage_delta_gb"]) {
            if (cur[k] != null) carry[k] = cur[k];
          }
          const fresh = await storeMint(cur.supplier_url, cur.label, carry);
          await storeUpdate(t, { revoked: true });
          return json({ oldToken: t, newToken: fresh, note: "old link is now dead — send the new one" });
        }
        if (action === "revoke") {
          const r = await storeUpdate(t, { revoked: true });
          return r ? json({ token: t, revoked: true }) : json({ error: "unknown token" }, 404);
        }
        if (action === "delete") {
          const gone = await storeRemove(t);
          return gone ? json({ token: t, deleted: true }) : json({ error: "unknown token" }, 404);
        }
        return json({ error: "action must be check | renew | pay/paid/unpaid (POST) | rotate | revoke | delete" }, 400);
      }
      if (path === "/admin/reminders/run") {
        // GET so a platform cron can hit it directly (Vercel/Netlify crons
        // issue GETs). On Cloudflare prefer the scheduled() handler instead.
        const out = await runRemindersFromEnv(env || {}, {
          listAll: storeList, updateRow: storeUpdate,
          hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
        }, { fetchSubscription, quotaSummary });
        return json(out);
      }
      if (path === "/admin/reminders") {
        const rows = await storeListReminders(Number(url.searchParams.get("limit")) || 100);
        return json({ count: rows.length, reminders: rows });
      }
      if (path === "/admin/links") {
        const rows = await storeList();
        const accounts = supplierAccounts(rows);
        return json({ count: rows.length, links: rows.map((r) => redact(r, accounts)) });
      }
      if (path === "/admin/shared-users") {
        // Read-only discovery. No supplier/network calls and no writes happen
        // anywhere in this path: the helper groups rows already in memory.
        const noStore = { "Cache-Control": "no-store" };
        if (request.method !== "GET") {
          return json({ error: "Shared-user discovery supports GET only." }, 405, { ...noStore, Allow: "GET" });
        }
        const tokenParam = url.searchParams.get("token");
        try {
          const rows = await storeList();
          if (tokenParam !== null) {
            if (!tokenParam.trim()) return json({ error: "token parameter must not be empty." }, 400, noStore);
            const report = sharedUsersForToken(rows, host, tokenParam.trim());
            if (!report) return json({ error: "Unknown customer record." }, 404, noStore);
            return json(report, 200, noStore);
          }
          return json(sharedUsersReport(rows, host), 200, noStore);
        } catch (e) {
          // Generic, safe message: never echo a supplier URL, token or key.
          return json({ error: "Could not load customer data. Please try again." }, 500, noStore);
        }
      }

      if (path === "/") return html(homePage());
      if (path === "/rebrand") return html(formPage("Link Rebranding", "paste supplier link → get your ONE link", "/rebrand", "✨ Rebrand link(s)"));
      if (path === "/tool") return html(formPage("Seller Tool", "full client packs — links for every app, quota & message", "/tool", "⚡ Generate client packs"));
      if (path === "/qr" || path === "/qr-maker") return html(qrMakerPage(host));
      if (path === "/qr/svg" || path === "/qr.svg") {
        const text = url.searchParams.get("text") || url.searchParams.get("t") || "";
        if (!text) return plainErr("missing text parameter", 400);
        return new Response(generateQrSvg(text), {
          headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
        });
      }

      let m;
      if ((m = path.match(/^\/q\/([^/]+)$/))) {
        const brand = url.searchParams.get("brand") || "SP VPN";
        const { status, proxies, links } = await getDecoded(m[1]);
        return html(quotaBody(host, m[1], brand, status, proxies, links.length));
      }
      if ((m = path.match(/^\/all\/([^/?]+)$/))) {
        const brand = safeDecode(m[1]) || "SP VPN";
        const tok = url.searchParams.get("t") || "";
        if (!tok) return plainErr("missing ?t= parameter", 400);
        const { status, links, proxies } = await getDecoded(tok);
        if (!links.length) return plainErr("No nodes found in that link.");
        // format negotiation: explicit ?fmt= wins, then Accept header, then UA
        const fmt = (url.searchParams.get("fmt") || "").toLowerCase();
        const ua = (request.headers.get("user-agent") || "").toLowerCase();
        const accept = (request.headers.get("accept") || "").toLowerCase();
        const clashClient = ["clash", "mihomo", "fugu", "streisand", "nyanpasu", "verge", "reqwest", "tauri", "clashx", "clashmeta", "meta", "metacubex", "stash", "flclash", "karing"].some((k) => ua.includes(k));
        const wantsYaml = fmt === "yaml" ? true : fmt === "sr" ? false : clashClient || accept.includes("yaml") || accept.includes("yml");
        const extra = subHeaders(status, `${host}/q/${tok}`);
        if (wantsYaml) {
          if (!proxies.length) return plainErr("No vless://, vmess:// or trojan:// nodes found in that link — Clash apps can't use it.");
          return yamlRes(buildYaml(status, proxies, brand), extra);
        }
        return plain(btoa(unescape(encodeURIComponent(buildShare(status, links, brand)))), extra);
      }
      if ((m = path.match(/^\/sub\/([^/]+)$/))) {
        const brand = url.searchParams.get("brand") || "SP VPN";
        const { status, proxies } = await getDecoded(m[1]);
        if (!proxies.length) return plainErr("No vless://, vmess:// or trojan:// nodes found in that link — Clash apps can't use it.");
        return yamlRes(buildYaml(status, proxies, brand), subHeaders(status, `${host}/q/${m[1]}`));
      }
      if ((m = path.match(/^\/share\/([^/]+)$/))) {
        const brand = url.searchParams.get("brand") || "SP VPN";
        const { status, links } = await getDecoded(m[1]);
        if (!links.length) return plainErr("No nodes found in that link.");
        const body = buildShare(status, links, brand);
        if (url.searchParams.get("file") === "1")
          return plain(body, { "Content-Disposition": `attachment; filename="${(brand.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}.txt"` });
        return plain(body);
      }
      if ((m = path.match(/^\/sr\/([^/?]+)$/))) {
        const brand = safeDecode(m[1]) || "SP VPN";
        const tok = url.searchParams.get("t") || "";
        if (!tok) return plainErr("missing ?t= parameter", 400);
        const { status, links } = await getDecoded(tok);
        if (!links.length) return plainErr("No nodes found in that link.");
        return plain(btoa(unescape(encodeURIComponent(buildShare(status, links, brand)))), subHeaders(status, `${host}/q/${tok}`));
      }
      return html(errorPage("Not found"));
    } catch (e) {
      if (path?.startsWith("/admin/")) return json({ error: "Could not save or load customer data. Please try again." }, 500);
      // subscription endpoints: return a plain-text error with a 5xx status so
      // Clash/v2ray apps display the actual reason instead of failing to parse HTML
      if (/^\/(all|sub|sr|share)\//.test(path)) {
        return plainErr("Couldn't read that link — it may be invalid or expired. (" + String(e.message) + ")");
      }
      return html(errorPage("Couldn't read that link — it may be invalid or expired.<br>(" + String(e.message).replace(/</g, "&lt;") + ")"));
    }
  },

  // Cloudflare scheduled trigger. Add to wrangler.toml:
  //   [triggers]
  //   crons = ["0 * * * *"]
  // On Vercel/Netlify use a cron job hitting POST /admin/reminders instead —
  // see README → Scheduling.
  async scheduled(event, env, ctx) {
    if (env && (env.DB || env.TOKEN_STORE_URL)) storeSetBackend(null);
    await storeInit(env).catch(() => {});
    await runRemindersFromEnv(env || {}, {
      listAll: storeList, updateRow: storeUpdate,
      hasBeenSent: storeHasBeenSent, markSent: storeMarkSent,
    }, { fetchSubscription, quotaSummary });
  },
};
