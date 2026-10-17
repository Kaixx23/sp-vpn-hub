#!/usr/bin/env node
/**
 * cf-node-probe — rank Cloudflare entry IPs ("优选IP") for an edgetunnel
 * deployment, measured FROM THE NETWORK THIS SCRIPT RUNS ON.
 *
 * Why it exists
 * -------------
 * Every "node" in an edgetunnel subscription is the SAME Worker, reached
 * through a different Cloudflare IP:
 *
 *   vless://UUID@<entry IP>:<port>?sni=<your domain>&host=<your domain>&path=/
 *
 * Which entry IP is fast depends on the customer's ISP (China Mobile / Unicom /
 * Telecom / campus network), city and time of day. It can only be measured from
 * the customer's side of the wall. Testing from Singapore tells you nothing
 * about a phone in Guangzhou. So: run this on a mainland-China connection,
 * VPN OFF, ideally at the 20:00-23:00 evening peak.
 *
 * Stages (each stage only sees the survivors of the previous one)
 * ---------------------------------------------------------------
 *  1. TCP ping    connect() round-trips to ip:port → latency + packet loss.
 *                 Costs nothing on Cloudflare.
 *  2. Edge trace  TLS with SNI = your domain + GET /cdn-cgi/trace → proves the IP
 *                 serves your domain with a valid certificate, and tells you
 *                 which Cloudflare data centre ("colo") it lands on from here.
 *                 For China, HKG/SIN/NRT/ICN/TPE are far better than LAX/SJC/FRA.
 *                 Answered by Cloudflare's edge, NOT your Worker: still free.
 *  3. Tunnel      Real VLESS-over-WebSocket sessions through YOUR Worker:
 *                   • real delay  → http://www.gstatic.com/generate_204
 *                                   (the same thing Clash "Auto Speed" measures)
 *                   • ProxyIP     → a Cloudflare-hosted target, which a Worker can
 *                                   only reach through your PROXYIP (ChatGPT, X,
 *                                   Discord… all depend on this path)
 *                   • download    → a timed plain-HTTP download (top N only)
 *                 Each tunnel = 1 Worker request (free plan: 100,000/day total).
 *
 * Output
 * ------
 *  • a ranked table on screen
 *  • --out  best-ADD.txt   lines in edgetunnel's custom-IP format:
 *                          104.18.42.72:443#新加坡•电信 CF01
 *                          (paste into admin → 自定义订阅 → 自定义优选地址 → 保存;
 *                          the 移动/联通/电信 word also drives sp-vpn-hub's carrier groups)
 *  • --json report.json    everything that was measured
 *
 * Zero dependencies. Node 18+.
 */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const VERSION = "1.0.0";
const UA = `cf-node-probe/${VERSION}`;
const WS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Cloudflare anycast ranges used for sampling. This is the list
// XIU2/CloudflareSpeedTest ships as ip.txt (official ranges from
// https://www.cloudflare.com/ips-v4 with 104.16.0.0/12 and the
// 172.64.x carve-outs that don't serve customer zones removed).
export const CF_IPV4_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/12",
  "172.64.0.0/17", "172.64.128.0/18", "172.64.192.0/19", "172.64.224.0/22",
  "172.64.229.0/24", "172.64.230.0/23", "172.64.232.0/21", "172.64.240.0/21",
  "172.64.248.0/21", "172.65.0.0/16", "172.66.0.0/16", "172.67.0.0/16",
  "131.0.72.0/22",
];
export const CF_IPV6_RANGES = [
  "2606:4700::/32", "2400:cb00:2049::/48", "2400:cb00:f00e::/48",
  "2606:4700:10::/48", "2606:4700:130::/48", "2606:4700:3000::/48",
  "2606:4700:3001::/48", "2606:4700:3002::/48", "2606:4700:3003::/48",
];
// Cloudflare's HTTPS ports. Every one of them reaches the same Worker.
export const CF_TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

export const ISP_LABELS = {
  mobile: "移动", cmcc: "移动",
  unicom: "联通", cu: "联通",
  telecom: "电信", ct: "电信",
  edu: "教育网", cernet: "教育网",
};

// Cloudflare colo (IATA code) → the country words sp-vpn-hub already
// translates (日本 → Japan, 香港 → Hong Kong, …). Unknown colos keep the code.
const COLO_COUNTRY = {
  HKG: "香港", TPE: "台湾", KHH: "台湾", NRT: "日本", KIX: "日本", FUK: "日本", OKA: "日本",
  ICN: "韩国", SIN: "新加坡", BKK: "泰国", SGN: "越南", HAN: "越南", DAD: "越南",
  BOM: "印度", DEL: "印度", MAA: "印度", SYD: "澳大利亚", MEL: "澳大利亚",
  FRA: "德国", MUC: "德国", DUS: "德国", HAM: "德国", LHR: "英国", MAN: "英国", CDG: "法国", MRS: "法国",
  AMS: "荷兰", YYZ: "加拿大", YVR: "加拿大", YUL: "加拿大",
};
const US_COLOS = new Set(("LAX SJC SEA SFO PDX DFW ORD IAD EWR ATL MIA DEN PHX LAS SLC MCI MSP " +
  "BOS JFK CLT IAH AUS SAN SMF OMA IND CMH PIT DTW STL TPA MEM RIC BNA HNL ANC").split(" "));
export function coloCountry(colo) {
  const c = String(colo || "").toUpperCase();
  if (COLO_COUNTRY[c]) return COLO_COUNTRY[c];
  if (US_COLOS.has(c)) return "美国";
  return c || "未知";
}

// ───────────────────────────── small utils ─────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function spread(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length > 1 ? Math.max(...a) - Math.min(...a) : 0;
}
export async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
export function maskSecret(s) {
  s = String(s || "");
  return s.length <= 10 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
export function fmtAddr(address, port) {
  return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
}
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

// ───────────────────────────── IP sampling ─────────────────────────────
function ipv4ToInt(ip) { return ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0); }
function intToIpv4(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); }
function ipv6ToBigInt(ip) {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}
function bigIntToIpv6(n) {
  const g = [];
  for (let i = 0; i < 8; i++) { g.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  return g.join(":").replace(/(^|:)0(:0)+(:|$)/, "::").replace(/:{3,}/, "::");
}

/**
 * Pick `count` random IPv4s across the ranges, one per random /24 (weighted by
 * how many /24s each range holds), hosts .1-.254 — the same idea as
 * CloudflareSpeedTest's default "one random IP per /24".
 */
export function sampleIPv4(count, ranges = CF_IPV4_RANGES, rnd = Math.random) {
  const blocks = ranges.map((cidr) => {
    const [base, bits] = cidr.split("/");
    const prefix = Number(bits);
    const n24 = prefix >= 24 ? 1 : 2 ** (24 - prefix);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { start: (ipv4ToInt(base) & mask) >>> 0, n24, prefix };
  });
  const total = blocks.reduce((s, b) => s + b.n24, 0);
  const seen = new Set();
  const out = [];
  let guard = count * 20;
  while (out.length < count && guard-- > 0) {
    let pick = Math.floor(rnd() * total);
    const b = blocks.find((x) => (pick -= x.n24) < 0);
    const block24 = b.start + Math.floor(rnd() * b.n24) * 256;
    const ip = intToIpv4((block24 + 1 + Math.floor(rnd() * 254)) >>> 0);
    if (!seen.has(ip)) { seen.add(ip); out.push(ip); }
  }
  return out;
}
export function sampleIPv6(count, ranges = CF_IPV6_RANGES, rnd = Math.random) {
  const out = new Set();
  let guard = count * 20;
  while (out.size < count && guard-- > 0) {
    const [base, bits] = ranges[Math.floor(rnd() * ranges.length)].split("/");
    const hostBits = 128n - BigInt(bits);
    let r = 0n;
    for (let i = 0n; i < hostBits; i += 16n) r = (r << 16n) | BigInt(Math.floor(rnd() * 65536));
    r &= (1n << hostBits) - 1n;
    out.add(bigIntToIpv6(((ipv6ToBigInt(base) >> hostBits) << hostBits) | (r === 0n ? 1n : r)));
  }
  return [...out];
}

// ───────────────────────────── parsing inputs ─────────────────────────────
/** "1.2.3.4", "1.2.3.4:2053", "[2606:4700::1]:443", "www.visa.cn" → {address, port} */
export function parseHostPort(s, defaultPort = 443) {
  s = String(s).trim();
  let m = s.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (m) return { address: m[1], port: m[2] ? Number(m[2]) : defaultPort };
  if (net.isIPv6(s)) return { address: s, port: defaultPort };
  m = s.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (m && (net.isIPv4(m[1]) || /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(m[1]))) {
    return { address: m[1], port: m[2] ? Number(m[2]) : defaultPort };
  }
  return null;
}

/**
 * Candidate list → [{address, port, label, hintColo}].
 * Accepts edgetunnel ADD.txt lines ("ip[:port][#label]", comma-separated also
 * fine) and CloudflareSpeedTest result.csv ("IP 地址,已发送,…,地区码").
 */
export function parseCandidates(text, defaultPort = 443) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = (lines.find((l) => l.trim()) || "").trim();
  const out = [];
  const isCsv = first.includes(",") && /(IP\s*地址|IP Address|延迟|丢包|已发送|Latency)/i.test(first);
  if (isCsv) {
    const head = first.split(",").map((h) => h.trim());
    const ipIdx = head.findIndex((h) => /IP/i.test(h));
    const portIdx = head.findIndex((h) => h === "端口" || /^port$/i.test(h));
    const coloIdx = head.findIndex((h) => h.includes("地区码") || h.includes("数据中心") || /colo/i.test(h));
    for (const line of lines.slice(lines.indexOf(lines.find((l) => l.trim())) + 1)) {
      if (!line.trim()) continue;
      const c = line.split(",").map((x) => x.trim());
      const hp = parseHostPort(c[ipIdx] || "", portIdx >= 0 && c[portIdx] ? Number(c[portIdx]) : defaultPort);
      if (hp) out.push({ ...hp, label: "", hintColo: coloIdx >= 0 ? (c[coloIdx] || "") : "" });
    }
    return out;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    for (const item of line.split(",")) {
      const it = item.trim();
      if (!it) continue;
      if (/^(sub|https?):\/\//i.test(it)) continue; // ADDAPI / generator entries: not an IP
      const hash = it.indexOf("#");
      const hp = parseHostPort(hash >= 0 ? it.slice(0, hash) : it, defaultPort);
      if (hp) out.push({ ...hp, label: hash >= 0 ? it.slice(hash + 1).trim() : "", hintColo: "" });
    }
  }
  return out;
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** edgetunnel /sub output (base64 or plain) → [{proto, address, port, secret, host, sni, path, label, type, security}] */
export function parseSubscription(text) {
  let t = String(text).replace(/^\uFEFF/, "").trim();
  if (!t.includes("://")) {
    try { t = Buffer.from(t.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { /* not base64 */ }
  }
  const nodes = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(vless|trojan):\/\/([^@]+)@(\[[^\]]+\]|[^:/?#]+):(\d{1,5})\/?(?:\?([^#]*))?(?:#(.*))?$/i);
    if (!m) continue;
    const q = new URLSearchParams(m[5] || "");
    const host = q.get("host") || q.get("sni") || "";
    nodes.push({
      proto: m[1].toLowerCase(),
      secret: safeDecode(m[2]),
      address: m[3].replace(/^\[|\]$/g, ""),
      port: Number(m[4]),
      host,
      sni: q.get("sni") || host,
      path: q.get("path") || "/",
      type: q.get("type") || "tcp",
      security: q.get("security") || "",
      label: safeDecode(m[6] || ""),
    });
  }
  return nodes;
}

// ───────────────────────────── protocol bytes ─────────────────────────────
export function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("invalid UUID");
  return Buffer.from(hex, "hex");
}
function ipv6ToBytes(ip) {
  let n = ipv6ToBigInt(ip);
  const b = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}
/** VLESS address types: 1=IPv4 2=domain 3=IPv6. Trojan (SOCKS5-style): 1=IPv4 3=domain 4=IPv6. */
export function encodeAddress(host, style = "vless") {
  if (net.isIPv4(host)) return Buffer.from([1, ...host.split(".").map(Number)]);
  if (net.isIPv6(host)) return Buffer.concat([Buffer.from([style === "vless" ? 3 : 4]), ipv6ToBytes(host)]);
  const name = Buffer.from(host, "utf8");
  if (!name.length || name.length > 255) throw new Error("invalid target host");
  return Buffer.concat([Buffer.from([style === "vless" ? 2 : 3, name.length]), name]);
}
function portBytes(port) { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; }

/** version(0) | uuid(16) | addons-len(0) | cmd(1 = TCP) | port(2) | atyp | addr */
export function buildVlessHeader(uuid, host, port) {
  return Buffer.concat([Buffer.from([0]), uuidToBytes(uuid), Buffer.from([0, 1]), portBytes(port), encodeAddress(host, "vless")]);
}
/** hex(sha224(password)) | CRLF | cmd(1) | atyp | addr | port | CRLF */
export function buildTrojanHeader(password, host, port) {
  const hash = crypto.createHash("sha224").update(String(password)).digest("hex");
  return Buffer.concat([Buffer.from(hash + "\r\n"), Buffer.from([1]), encodeAddress(host, "trojan"), portBytes(port), Buffer.from("\r\n")]);
}

/**
 * The first WebSocket message(s) for a tunnel. edgetunnel decides
 * "Trojan or VLESS?" by checking whether bytes 56-57 of the first message are
 * CRLF (where a Trojan header has its CRLF). A VLESS header + HTTP request can
 * collide with that by accident; when it would, send the header on its own
 * first (a VLESS header alone can't have CRLF there).
 */
export function buildFirstMessages(proto, secret, host, port, payload) {
  const header = proto === "trojan" ? buildTrojanHeader(secret, host, port) : buildVlessHeader(secret, host, port);
  const combined = Buffer.concat([header, payload]);
  if (proto === "vless" && combined.length >= 58 && combined[56] === 0x0d && combined[57] === 0x0a) return [header, payload];
  return [combined];
}

/** Client → server frames must be masked (RFC 6455 §5.3). */
export function wsFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export class WsFrameParser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) throw new Error("WebSocket frame too large");
        len = Number(big); off = 10;
      }
      let mask = null;
      if (masked) { if (b.length < off + 4) break; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len);
      if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      this.buf = b.subarray(off + len);
      frames.push({ fin, opcode, payload });
    }
    return frames;
  }
}

// ───────────────────────────── network primitives ─────────────────────────────
export function tcpPing(address, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const sock = net.connect({ host: address, port });
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ms);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once("connect", () => finish(performance.now() - t0));
    sock.once("error", () => finish(null));
  });
}

function tlsConnect({ address, port, servername, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const sock = tls.connect({
      host: address, port, servername,
      ALPNProtocols: ["http/1.1"], // WebSocket upgrade needs HTTP/1.1, not h2
      rejectUnauthorized: !insecure,
    });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("TLS handshake timeout")); }, timeoutMs);
    sock.once("secureConnect", () => { clearTimeout(timer); resolve({ sock, tlsMs: performance.now() - t0 }); });
    sock.once("error", (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

/** Read an HTTP/1.1 response (Connection: close) off a plain socket. */
function readHttpResponse(sock, timeoutMs, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let buf = Buffer.alloc(0), firstByteMs = null, done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners("data");
      if (err && !buf.length) return reject(err);
      const idx = buf.indexOf("\r\n\r\n");
      const head = (idx >= 0 ? buf.subarray(0, idx) : buf).toString("latin1");
      const body = idx >= 0 ? buf.subarray(idx + 4).toString("utf8") : "";
      resolve({ head, body, firstByteMs });
    };
    const timer = setTimeout(() => finish(new Error("HTTP response timeout")), timeoutMs);
    sock.on("data", (chunk) => {
      if (firstByteMs === null) firstByteMs = performance.now() - t0;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const cl = buf.subarray(0, idx).toString("latin1").match(/\r\ncontent-length:\s*(\d+)/i);
        if (cl && buf.length - idx - 4 >= Number(cl[1])) return finish();
      }
      if (buf.length > maxBytes) finish();
    });
    sock.once("end", () => finish());
    sock.once("close", () => finish());
    sock.once("error", (e) => finish(e));
  });
}

function parseTrace(body) {
  const kv = {};
  for (const line of String(body).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

/**
 * Stage 2: TLS (SNI = your domain) + GET /cdn-cgi/trace on that entry IP.
 * Cloudflare's edge answers this itself, so it costs no Worker request, and
 * the reply says which data centre served it (colo=HKG) and where you are (loc=CN).
 */
export async function edgeTrace({ address, port, host, timeoutMs = 2500, insecure = false }) {
  const t0 = performance.now();
  let sock;
  try {
    const c = await tlsConnect({ address, port, servername: host, timeoutMs, insecure });
    sock = c.sock;
    const tReq = performance.now();
    sock.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    const { head, body, firstByteMs } = await readHttpResponse(sock, timeoutMs);
    const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0);
    const kv = parseTrace(body);
    const ray = head.match(/\r\ncf-ray:\s*([^\r\n]+)/i)?.[1] || "";
    const colo = (kv.colo || (ray.includes("-") ? ray.split("-").pop() : "")).toUpperCase();
    // Pass = the IP completed a TLS handshake with a valid certificate for YOUR
    // domain and answered HTTP. The colo is best-effort (trace body or cf-ray).
    return {
      ok: status > 0,
      error: status > 0 ? undefined : "no HTTP response",
      status, colo, loc: kv.loc || "", clientIp: kv.ip || "",
      tlsMs: c.tlsMs, rttMs: firstByteMs ?? performance.now() - tReq, totalMs: performance.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e.code === "ERR_TLS_CERT_ALTNAME_INVALID" ? "certificate does not cover your domain" : (e.message || String(e)) };
  } finally {
    sock?.destroy();
  }
}

/**
 * Stage 3: one real proxied request through the Worker.
 *   TLS(SNI=host) → WebSocket upgrade on `path` → VLESS/Trojan header + an
 *   HTTP/1.1 request for `target` → read the proxied response.
 * mode "head": stop at the response headers (real delay)
 * mode "body": read the whole (small) body (ProxyIP trace)
 * mode "download": read for up to `seconds`, report throughput
 */
export async function tunnelRequest({
  address, port, host, path = "/", proto = "vless", secret,
  target, mode = "head", seconds = 8, timeoutMs = 2500, insecure = false,
}) {
  const t0 = performance.now();
  let sock;
  const fail = (stage, e) => ({ ok: false, stage, error: e?.message || String(e), elapsedMs: performance.now() - t0 });
  try {
    try { sock = (await tlsConnect({ address, port, servername: host, timeoutMs, insecure })).sock; }
    catch (e) { return fail("tls", e); }

    // ── WebSocket upgrade ──
    const key = crypto.randomBytes(16).toString("base64");
    sock.write(`GET ${path || "/"} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${WS_UA}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    let rest;
    try {
      rest = await new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => reject(new Error("WebSocket upgrade timeout")), timeoutMs);
        const onData = (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf("\r\n\r\n");
          if (idx < 0) { if (buf.length > 16384) { cleanup(); reject(new Error("bad upgrade response")); } return; }
          cleanup();
          const head = buf.subarray(0, idx).toString("latin1");
          if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
          const accept = head.match(/\r\nsec-websocket-accept:\s*([^\r\n]+)/i)?.[1]?.trim();
          const want = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
          if (accept !== want) return reject(new Error("bad Sec-WebSocket-Accept"));
          resolve(buf.subarray(idx + 4));
        };
        const onEnd = () => { cleanup(); reject(new Error("connection closed during upgrade")); };
        const cleanup = () => { clearTimeout(timer); sock.off("data", onData); sock.off("end", onEnd); sock.off("error", onEnd); };
        sock.on("data", onData);
        sock.once("end", onEnd);
        sock.once("error", onEnd);
      });
    } catch (e) { return fail("websocket", e); }
    const wsMs = performance.now() - t0;

    // ── proxied HTTP request ──
    const req = Buffer.from(`GET ${target.path || "/"} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: ${UA}\r\n` +
      `Accept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    for (const m of buildFirstMessages(proto, secret, target.host, target.port || 80, req)) sock.write(wsFrame(m));

    return await new Promise((resolve) => {
      const parser = new WsFrameParser();
      let needVlessHeader = proto === "vless", pre = Buffer.alloc(0);
      let headBuf = Buffer.alloc(0), httpHead = null, status = 0, contentLength = null;
      let bodyBytes = 0, bodyChunks = [], tFirst = null, tBody = null, tLast = null, done = false;
      const firstByteTimer = setTimeout(() => finish("no response from target (timeout)"), timeoutMs * 3);
      let dlTimer = null;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(firstByteTimer);
        clearTimeout(dlTimer);
        sock.destroy();
        const now = performance.now();
        if (httpHead === null) {
          // edgetunnel silently drops a WebSocket whose VLESS/Trojan header it rejects
          const why = err || (tFirst === null && !needVlessHeader ? "no data from target" :
            "Worker closed the tunnel before any response — wrong UUID/path, or the target is unreachable from the Worker");
          return resolve({ ...fail("target", why), wsMs });
        }
        const bodySecs = tBody !== null ? ((tLast ?? now) - tBody) / 1000 : 0;
        resolve({
          ok: true, status, wsMs,
          delayMs: tFirst - t0, // like Clash's url-test: fresh connection → first response byte
          bodyBytes,
          // only a real 2xx file download counts as a speed result
          mbps: mode === "download" && status >= 200 && status < 300 && bodySecs > 0.002 ? (bodyBytes * 8) / bodySecs / 1e6 : null,
          body: mode === "body" ? Buffer.concat(bodyChunks).toString("utf8") : undefined,
          elapsedMs: now - t0,
          note: err || undefined,
        });
      };
      const onPayload = (data) => {
        if (needVlessHeader) { // VLESS response header: version, addons-len, addons…
          pre = Buffer.concat([pre, data]);
          if (pre.length < 2 || pre.length < 2 + pre[1]) return;
          data = pre.subarray(2 + pre[1]);
          needVlessHeader = false;
        }
        if (!data.length) return;
        const now = performance.now();
        if (tFirst === null) tFirst = now;
        if (httpHead === null) {
          headBuf = Buffer.concat([headBuf, data]);
          const idx = headBuf.indexOf("\r\n\r\n");
          if (idx < 0) { if (headBuf.length > 65536) finish("oversized response headers"); return; }
          httpHead = headBuf.subarray(0, idx).toString("latin1");
          status = Number(httpHead.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0);
          const cl = httpHead.match(/\r\ncontent-length:\s*(\d+)/i);
          contentLength = cl ? Number(cl[1]) : null;
          if (mode === "head") return finish();
          tBody = now;
          data = headBuf.subarray(idx + 4);
          if (mode === "download") dlTimer = setTimeout(() => finish(), seconds * 1000);
        }
        bodyBytes += data.length;
        tLast = now;
        if (mode === "body") {
          bodyChunks.push(Buffer.from(data));
          if (bodyBytes > 65536) return finish();
        }
        if (contentLength !== null && bodyBytes >= contentLength) finish();
      };
      sock.on("data", (chunk) => {
        let frames;
        try { frames = parser.push(chunk); } catch (e) { return finish(e.message); }
        for (const f of frames) {
          if (done) return;
          if (f.opcode === 0x8) return finish();
          if (f.opcode === 0x9) { sock.write(wsFrame(f.payload, 0xa)); continue; }
          if (f.opcode === 0xa) continue;
          onPayload(f.payload);
        }
      });
      sock.once("end", () => finish());
      sock.once("close", () => finish());
      sock.once("error", (e) => finish(e.message));
      if (rest.length) sock.emit("data", rest);
    });
  } finally {
    sock?.destroy();
  }
}

// ───────────────────────────── the probe ─────────────────────────────
export const DEFAULTS = {
  pings: 4,
  concurrency: 16,
  timeoutMs: 2500,
  top: 5,
  traceLimit: 40,
  tunnelLimit: 12,
  delayRounds: 2,
  dlSeconds: 8,
  delayUrl: "http://www.gstatic.com/generate_204",
  // Cloudflare-hosted: a Worker cannot connect() to Cloudflare IPs, so this only
  // answers if your PROXYIP works. Same path ChatGPT / X / Discord take.
  proxyIpUrl: "http://www.cloudflare.com/cdn-cgi/trace",
  dlUrl: "http://cachefly.cachefly.net/10mb.test",
};

function splitUrl(u) {
  const x = new URL(u);
  if (x.protocol !== "http:") throw new Error(`only plain http:// targets are supported for tunnel tests (${u})`);
  return { host: x.hostname.replace(/^\[|\]$/g, ""), port: Number(x.port || 80), path: x.pathname + x.search };
}

/** Lower is better. Explained in the report header so nobody has to trust a black box. */
export function scoreOf(r) {
  const base = r.realDelayMs ?? r.edgeRttMs ?? r.tcpMs;
  if (!Number.isFinite(base)) return Infinity;
  let s = base * (1 + 3 * (r.tcpLoss || 0));
  if (r.tunnelFails) s *= 1 + r.tunnelFails;
  if (r.proxyIpOk === false) s *= 1.5;
  if (Number.isFinite(r.mbps) && r.mbps < 2) s *= 2;
  return s;
}

export function makeLabel(r, i, isp) {
  const word = ISP_LABELS[String(isp || "").toLowerCase()] || "";
  // No commas/quotes/newlines: edgetunnel splits its custom-IP list on them.
  return `${coloCountry(r.colo)}•${word}${word ? " " : ""}CF${String(i + 1).padStart(2, "0")}`.replace(/[,"'\r\n\t]/g, " ");
}

export function toAddTxt(results, isp) {
  return results.map((r, i) => `${fmtAddr(r.address, r.port)}#${makeLabel(r, i, isp)}`).join("\n") + "\n";
}

/**
 * Run all stages. `candidates`: [{address, port, label?, hintColo?}].
 * `tunnel`: {host, path, proto, secret} or null (stages 1-2 only).
 */
export async function runProbe({ candidates, host, tunnel = null, opts = {}, log = () => {} }) {
  const o = { ...DEFAULTS, ...opts };
  if (!host) throw new Error("need the Worker's domain (--host or --sub) for the edge-trace stage");

  // De-duplicate; resolve "preferred domains" (www.visa.cn…) once, keep the name for output.
  const uniq = new Map();
  for (const c of candidates) {
    const k = `${c.address.toLowerCase()}|${c.port}`;
    if (!uniq.has(k)) uniq.set(k, { ...c });
  }
  const list = [...uniq.values()];
  await pool(list, o.concurrency, async (c) => {
    if (net.isIP(c.address)) { c.dial = c.address; return; }
    try { c.dial = (await dns.lookup(c.address)).address; } catch { c.dial = null; c.error = "DNS lookup failed"; }
  });

  // ── stage 1: TCP ──
  log(`\n[1/3] TCP ping: ${list.length} candidate(s) × ${o.pings}`);
  await pool(list, o.concurrency, async (c) => {
    if (!c.dial) { c.tcpLoss = 1; return; }
    const samples = [];
    for (let i = 0; i < o.pings; i++) {
      samples.push(await tcpPing(c.dial, c.port, o.timeoutMs));
      if (i === 0 && samples[0] === null && o.pings > 2) { samples.push(null); break; } // dead on first try: don't wait out every timeout
      await sleep(50);
    }
    const ok = samples.filter((x) => x !== null);
    c.tcpMs = median(ok);
    c.tcpJitter = spread(ok);
    c.tcpLoss = 1 - ok.length / Math.max(samples.length, o.pings);
    if (!ok.length) c.error = c.error || `TCP ${c.port} unreachable`;
  });
  let alive = list.filter((c) => c.tcpMs !== null && c.tcpLoss < 0.5)
    .sort((a, b) => a.tcpMs * (1 + 3 * a.tcpLoss) - b.tcpMs * (1 + 3 * b.tcpLoss));
  log(`      ${alive.length} reachable`);

  // ── stage 2: edge trace ──
  const toTrace = alive.slice(0, o.traceLimit);
  log(`[2/3] Edge trace (TLS + /cdn-cgi/trace, SNI=${host}): ${toTrace.length} IP(s)`);
  let whereFrom = null;
  await pool(toTrace, o.concurrency, async (c) => {
    const t = await edgeTrace({ address: c.dial, port: c.port, host, timeoutMs: o.timeoutMs, insecure: o.insecure });
    c.edgeOk = t.ok;
    c.edgeError = t.error;
    c.colo = t.colo || c.hintColo || "";
    c.edgeRttMs = t.rttMs;
    c.tlsMs = t.tlsMs;
    if (t.ok && !whereFrom) whereFrom = { loc: t.loc, clientIp: t.clientIp };
  });
  for (const c of toTrace) if (!c.edgeOk && !c.edgeError) c.edgeError = "edge check failed";
  let served = toTrace.filter((c) => c.edgeOk);
  if (o.colos?.length) served = served.filter((c) => o.colos.includes(String(c.colo).toUpperCase()));
  served.sort((a, b) => a.edgeRttMs - b.edgeRttMs);
  log(`      ${served.length} serve your domain${o.colos?.length ? ` in ${o.colos.join("/")}` : ""}` +
    (served.length ? ` (colos: ${[...new Set(served.map((c) => c.colo || "?"))].join(", ")})` : ""));

  // ── stage 3: tunnel ──
  let finalists = served;
  if (tunnel && served.length) {
    const toTunnel = served.slice(0, o.tunnelLimit);
    const dlCount = Math.min(o.top, toTunnel.length);
    const cost = toTunnel.length * (o.delayRounds + 1) + (o.dlUrl ? dlCount : 0);
    log(`[3/3] Tunnel tests through your Worker: ${toTunnel.length} IP(s) — about ${cost} Worker request(s)`);
    const delayT = splitUrl(o.delayUrl);
    const proxyT = o.proxyIpUrl ? splitUrl(o.proxyIpUrl) : null;
    await pool(toTunnel, Math.min(o.concurrency, 6), async (c) => {
      const base = { address: c.dial, port: c.port, host: tunnel.host, path: tunnel.path, proto: tunnel.proto, secret: tunnel.secret, timeoutMs: o.timeoutMs, insecure: o.insecure };
      const delays = [];
      c.tunnelFails = 0;
      for (let i = 0; i < o.delayRounds; i++) {
        const r = await tunnelRequest({ ...base, target: delayT, mode: "head" });
        if (r.ok) delays.push(r.delayMs); else { c.tunnelFails++; c.tunnelError = `${r.stage}: ${r.error}`; }
      }
      c.realDelayMs = median(delays);
      if (proxyT) {
        const p = await tunnelRequest({ ...base, target: proxyT, mode: "body" });
        c.proxyIpOk = p.ok;
        if (p.ok) {
          const kv = parseTrace(p.body || "");
          c.proxyIpDelayMs = p.delayMs;
          c.proxyIpExit = kv.ip || "";
          c.proxyIpColo = (kv.colo || "").toUpperCase();
        } else c.proxyIpError = `${p.stage}: ${p.error}`;
      }
    });
    finalists = toTunnel.filter((c) => c.realDelayMs !== null)
      .sort((a, b) => scoreOf(a) - scoreOf(b));
    if (o.dlUrl && finalists.length) {
      const dlT = splitUrl(o.dlUrl);
      const dl = finalists.slice(0, dlCount);
      log(`      download test (${o.dlSeconds}s each) on the best ${dl.length}`);
      for (const c of dl) { // one at a time, so the tests don't share your bandwidth
        const r = await tunnelRequest({ address: c.dial, port: c.port, host: tunnel.host, path: tunnel.path, proto: tunnel.proto, secret: tunnel.secret, target: dlT, mode: "download", seconds: o.dlSeconds, timeoutMs: o.timeoutMs, insecure: o.insecure });
        c.mbps = r.ok ? r.mbps : null;
        c.dlBytes = r.ok ? r.bodyBytes : 0;
        if (!r.ok) c.dlError = `${r.stage}: ${r.error}`;
      }
    }
  }

  for (const c of finalists) c.score = scoreOf(c);
  finalists.sort((a, b) => a.score - b.score);
  return { whereFrom, tested: list, ranked: finalists, winners: finalists.slice(0, o.top) };
}

// ───────────────────────────── CLI ─────────────────────────────
const HELP = `cf-node-probe ${VERSION} — find the best entry IPs for your edgetunnel Worker,
measured from the network you run it on.

  Run it ON A MAINLAND-CHINA CONNECTION with your VPN turned OFF
  (TUN/global mode would route the test through another proxy and make every
  number meaningless). Best at the 20:00–23:00 Beijing evening peak.

Usage
  node bin/cf-node-probe.mjs --sub "<your /sub?token=… link>" [options]
  node bin/cf-node-probe.mjs --sub "<link>" --sample 300 --isp mobile
  node bin/cf-node-probe.mjs --sub "<link>" --ips result.csv --isp telecom
  node bin/cf-node-probe.mjs --ips ADD.txt --host your.domain   (no UUID → stages 1-2 only)

Inputs
  --sub URL|FILE     edgetunnel subscription: supplies domain, UUID, path and its
                     current nodes (so they get tested too). Never written to disk.
  --ips FILE         extra candidates: edgetunnel ADD.txt lines (ip[:port][#name])
                     or a CloudflareSpeedTest result.csv
  --sample N         add N random Cloudflare IPv4s (one per random /24)
  --sample6 N        add N random Cloudflare IPv6s
  --ports LIST       ports for sampled IPs, e.g. 443,2053,8443   (default 443)
  --no-current       don't include the subscription's current nodes
  --host DOMAIN      your Worker's domain (if not using --sub)
  --uuid UUID        your node UUID (if not using --sub) — enables tunnel tests
  --path PATH        WebSocket path (default from --sub, else "/")

Selection
  --isp NAME         mobile | unicom | telecom | edu — names the output nodes
                     移动/联通/电信/教育网, which sp-vpn-hub turns into carrier groups
  --colo LIST        keep only these data centres, e.g. HKG,SIN,NRT,ICN,TPE
  --top N            winners to keep (default ${DEFAULTS.top})

Tuning
  --pings N          TCP pings per IP (default ${DEFAULTS.pings})
  --concurrency N    parallel probes (default ${DEFAULTS.concurrency})
  --timeout MS       per-step timeout (default ${DEFAULTS.timeoutMs})
  --trace-limit N    max IPs for the edge-trace stage (default ${DEFAULTS.traceLimit})
  --tunnel-limit N   max IPs for tunnel tests (default ${DEFAULTS.tunnelLimit})
  --dl-url URL       plain-http file for the download test (default ${DEFAULTS.dlUrl})
                     e.g. http://cachefly.cachefly.net/100mb.test for fast lines
  --dl-seconds N     seconds per download test (default ${DEFAULTS.dlSeconds})
  --no-download      skip the download test
  --no-tunnel        skip all tunnel tests (uses zero Worker requests)
  --delay-url URL    plain-http URL for the real-delay test (default ${DEFAULTS.delayUrl})
  --proxyip-url URL  Cloudflare-hosted plain-http URL for the ProxyIP check
                     (default ${DEFAULTS.proxyIpUrl})

Output
  --out FILE         winners in edgetunnel custom-IP format (default best-ADD.txt)
  --json FILE        full measurements as JSON
  --insecure         skip TLS certificate checks (local testing only)
`;

export function parseArgs(argv) {
  const flags = new Set(["no-current", "no-download", "no-tunnel", "insecure", "help", "h", "version"]);
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--") && t !== "-h") throw new Error(`unexpected argument: ${t}`);
    const k = t.replace(/^-+/, "");
    if (flags.has(k)) { a[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
    a[k] = v;
    i++;
  }
  return a;
}

async function loadSub(src) {
  if (/^https?:\/\//i.test(src)) {
    // A User-Agent without "mozilla"/"clash"/… makes edgetunnel answer with the
    // plain base64 VLESS list — the format this parser reads.
    const res = await fetch(src, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`subscription returned HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(src, "utf8");
}

function printTable(rows, out = console.log) {
  const cols = [
    ["#", (r, i) => String(i + 1)],
    ["entry", (r) => fmtAddr(r.address, r.port)],
    ["colo", (r) => r.colo || "?"],
    ["tcp ms", (r) => r.tcpMs == null ? "-" : `${r0(r.tcpMs)}${r.tcpLoss ? ` (${r0(r.tcpLoss * 100)}% loss)` : ""}`],
    ["edge ms", (r) => r.edgeRttMs == null ? "-" : String(r0(r.edgeRttMs))],
    ["real delay", (r) => r.realDelayMs == null ? "-" : `${r0(r.realDelayMs)}${r.tunnelFails ? ` (${r.tunnelFails} fail)` : ""}`],
    ["ProxyIP", (r) => r.proxyIpOk == null ? "-" : r.proxyIpOk ? `ok ${r0(r.proxyIpDelayMs)}ms` : "FAIL"],
    ["Mbps", (r) => r.mbps == null ? (r.dlError ? "fail" : "-") : String(r1(r.mbps))],
    ["was", (r) => r.label || ""],
  ];
  const cells = rows.map((r, i) => cols.map(([, f]) => f(r, i)));
  const w = cols.map(([h], j) => Math.max(h.length, ...cells.map((c) => [...c[j]].length)));
  const line = (c) => c.map((x, j) => x + " ".repeat(Math.max(0, w[j] - [...x].length))).join("  ");
  out(line(cols.map(([h]) => h)));
  out(w.map((n) => "─".repeat(n)).join("  "));
  for (const c of cells) out(line(c));
}

export async function main(argv = process.argv.slice(2), out = console.log) {
  const a = parseArgs(argv);
  if (a.help || a.h || !argv.length) { out(HELP); return 0; }
  if (a.version) { out(VERSION); return 0; }

  let host = a.host || "", path = a.path || "", tunnel = null;
  const candidates = [];
  if (a.sub) {
    const nodes = parseSubscription(await loadSub(a.sub));
    if (!nodes.length) throw new Error("no vless:// or trojan:// nodes found in the subscription");
    const n0 = nodes[0];
    host = host || n0.host || n0.sni;
    path = path || n0.path || "/";
    if (n0.type === "ws" && n0.security === "tls") {
      tunnel = { host, path, proto: n0.proto, secret: a.uuid || n0.secret };
    } else {
      out(`! nodes use type=${n0.type} security=${n0.security}; tunnel tests support ws+tls only — skipping stage 3`);
    }
    out(`subscription: ${nodes.length} node(s), domain ${host}, ${n0.proto} ${maskSecret(n0.secret)}, path ${path}`);
    if (!a["no-current"]) for (const n of nodes) candidates.push({ address: n.address, port: n.port, label: n.label });
  } else if (a.uuid && host) {
    tunnel = { host, path: path || "/", proto: "vless", secret: a.uuid };
  }
  if (a.ips) candidates.push(...parseCandidates(fs.readFileSync(a.ips, "utf8")));
  const ports = (a.ports || "443").split(",").map((p) => Number(p.trim())).filter((p) => p > 0 && p < 65536);
  if (a.sample) for (const ip of sampleIPv4(Number(a.sample))) candidates.push({ address: ip, port: ports[Math.floor(Math.random() * ports.length)], label: "" });
  if (a.sample6) for (const ip of sampleIPv6(Number(a.sample6))) candidates.push({ address: ip, port: ports[Math.floor(Math.random() * ports.length)], label: "" });
  if (!candidates.length) throw new Error("no candidates — give --sub, --ips and/or --sample (see --help)");
  if (a["no-tunnel"]) tunnel = null;
  if (tunnel && !tunnel.secret) tunnel = null;

  const opts = {
    pings: Number(a.pings || DEFAULTS.pings),
    concurrency: Number(a.concurrency || DEFAULTS.concurrency),
    timeoutMs: Number(a.timeout || DEFAULTS.timeoutMs),
    top: Number(a.top || DEFAULTS.top),
    traceLimit: Number(a["trace-limit"] || DEFAULTS.traceLimit),
    tunnelLimit: Number(a["tunnel-limit"] || DEFAULTS.tunnelLimit),
    dlSeconds: Number(a["dl-seconds"] || DEFAULTS.dlSeconds),
    dlUrl: a["no-download"] ? null : (a["dl-url"] || DEFAULTS.dlUrl),
    delayUrl: a["delay-url"] || DEFAULTS.delayUrl,
    proxyIpUrl: a["proxyip-url"] || DEFAULTS.proxyIpUrl,
    colos: a.colo ? a.colo.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean) : null,
    insecure: !!a.insecure,
  };

  const res = await runProbe({ candidates, host, tunnel, opts, log: out });

  out("");
  if (res.whereFrom?.loc) {
    out(`testing from: ${maskSecret(res.whereFrom.clientIp)} (Cloudflare sees loc=${res.whereFrom.loc})`);
    if (res.whereFrom.loc && res.whereFrom.loc !== "CN") {
      out(`! You are NOT on a mainland-China connection (loc=${res.whereFrom.loc}). These numbers describe YOUR network,`);
      out(`  not your customers'. Use this run as a health check; pick China nodes from a run made inside China.`);
    }
  }
  if (!res.ranked.length) {
    out("No candidate passed every stage. Check the domain, the UUID, and that your VPN is OFF.");
    const why = res.tested.find((c) => c.tunnelError) || res.tested.find((c) => c.edgeError) || res.tested.find((c) => c.error);
    if (why) out(`first error seen (${fmtAddr(why.address, why.port)}): ${why.tunnelError || why.edgeError || why.error}`);
    return 2;
  }
  out(`score = delay × (1 + 3×loss) × (1 + tunnel failures) × (1.5 if ProxyIP failed) × (2 if < 2 Mbps)  — lower is better\n`);
  printTable(res.ranked.slice(0, Math.max(opts.top * 2, 10)), out);

  const isp = a.isp || "";
  const outFile = a.out || "best-ADD.txt";
  fs.writeFileSync(outFile, toAddTxt(res.winners, isp));
  out(`\nwrote ${res.winners.length} winner(s) → ${outFile}`);
  out(`next: admin panel → 优选订阅生成 → 自定义订阅 → paste into 自定义优选地址 → 保存`);
  if (!isp) out(`tip: add --isp mobile|unicom|telecom so the names carry the carrier (sp-vpn-hub groups by it)`);
  if (tunnel && res.ranked.some((r) => r.proxyIpOk === false)) {
    out(`! ProxyIP check failed on some entries: Cloudflare-hosted sites (ChatGPT, X, Discord, …) will break on those.`);
    out(`  Set PROXYIP to a reverse proxy you run yourself instead of the shared public default.`);
  }

  if (a.json) {
    const strip = ({ dial, ...r }) => ({ ...r, tcpMs: r0(r.tcpMs), edgeRttMs: r0(r.edgeRttMs), realDelayMs: r0(r.realDelayMs), mbps: r1(r.mbps), score: r0(r.score) });
    fs.writeFileSync(a.json, JSON.stringify({
      version: VERSION, at: new Date().toISOString(), host, isp: isp || null,
      from: res.whereFrom ? { loc: res.whereFrom.loc } : null, // no IPs, no UUID, no token
      winners: res.winners.map(strip), ranked: res.ranked.map(strip),
    }, null, 2));
    out(`wrote full report → ${a.json}`);
  }
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); } catch { return false; }
})();
if (isMain) {
  main().then((code) => process.exit(code), (e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
