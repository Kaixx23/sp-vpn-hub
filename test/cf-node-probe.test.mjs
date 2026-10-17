// ============================================================================
// CF-NODE-PROBE SUITE — parsers, protocol bytes, WebSocket framing, sampling,
// labels, scoring, and a full end-to-end run against a local fake edgetunnel
// (TLS + WebSocket + VLESS/Trojan, same wire behaviour as cmliu/edgetunnel's
// _worker.js 2026-10-08). Loopback only — no internet needed.
// Run: node test/cf-node-probe.test.mjs
// ============================================================================
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSubscription, parseCandidates, parseHostPort, buildVlessHeader, buildTrojanHeader,
  buildFirstMessages, wsFrame, WsFrameParser, sampleIPv4, sampleIPv6, CF_IPV4_RANGES,
  makeLabel, toAddTxt, scoreOf, coloCountry, edgeTrace, tunnelRequest, runProbe, main, maskSecret, median,
} from "../bin/cf-node-probe.mjs";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

const UUID = "11111111-2222-4333-8444-555555555555";
const enc = encodeURIComponent;

console.log("\n[1] parseSubscription() — edgetunnel /sub output");
{
  const links = [
    `vless://${UUID}@190.93.245.249:443?security=tls&type=ws&host=probe.test&fp=chrome&sni=probe.test&path=${enc("/")}&encryption=none#${enc("US 联通优选[192ms 52.89Mbps]")}`,
    `vless://${UUID}@[2606:4700::6810:1]:2053?security=tls&type=ws&host=probe.test&sni=probe.test&path=${enc("/?ed=2560")}#v6`,
    `trojan://${UUID}@104.16.7.216:2087?security=tls&type=ws&host=probe.test&path=%2F#t`,
    `ss://ignored`,
  ].join("\n");
  const b64 = Buffer.from(links).toString("base64");
  const nodes = parseSubscription(b64);
  ok(nodes.length === 3, "base64 sub → 3 nodes (vless, vless v6, trojan; ss ignored)");
  ok(nodes[0].address === "190.93.245.249" && nodes[0].port === 443, "ip/port parsed");
  ok(nodes[0].host === "probe.test" && nodes[0].path === "/" && nodes[0].type === "ws" && nodes[0].security === "tls", "host, path, type, security parsed");
  ok(nodes[0].label === "US 联通优选[192ms 52.89Mbps]", "URL-encoded Chinese label decoded");
  ok(nodes[0].secret === UUID, "UUID kept in memory (for the tunnel test)");
  ok(nodes[1].address === "2606:4700::6810:1" && nodes[1].port === 2053 && nodes[1].path === "/?ed=2560", "IPv6 entry + early-data path");
  ok(nodes[2].proto === "trojan", "trojan link recognised");
  ok(parseSubscription(links).length === 3, "plain (non-base64) sub also parsed");
}

console.log("\n[2] parseCandidates() — ADD.txt and CloudflareSpeedTest CSV");
{
  const add = [
    "# comment line",
    "104.18.42.72:2053#新加坡•电信 CF01",
    "172.66.137.187",
    "[2606:4700::1]:8443#v6",
    "www.visa.cn#优选域名",
    "1.1.1.1:443#a, 1.0.0.1#b",
    "https://example.com/api.txt",
    "sub://x",
    "not an ip!",
  ].join("\n");
  const c = parseCandidates(add);
  ok(c.length === 6, `ADD.txt → 6 candidates (got ${c.length})`);
  ok(c[0].address === "104.18.42.72" && c[0].port === 2053 && c[0].label === "新加坡•电信 CF01", "ip:port#label");
  ok(c[1].port === 443, "port defaults to 443");
  ok(c[2].address === "2606:4700::1" && c[2].port === 8443, "[IPv6]:port");
  ok(c[3].address === "www.visa.cn", "preferred domain kept as a name");
  ok(c[4].address === "1.1.1.1" && c[5].address === "1.0.0.1", "comma-separated entries split");
  const csv = "IP 地址,已发送,已接收,丢包率,平均延迟,下载速度(MB/s),地区码\n104.19.1.1,4,4,0.00,103.20,12.34,HKG\n104.19.1.2,4,3,0.25,150.00,3.10,SIN\n";
  const k = parseCandidates(csv);
  ok(k.length === 2 && k[0].address === "104.19.1.1" && k[0].hintColo === "HKG" && k[1].hintColo === "SIN", "CFST result.csv → IPs + colo hints");
  ok(parseHostPort("8.8.8.8:99999") === null || parseHostPort("8.8.8.8:99999").port === 99999, "parseHostPort doesn't throw on odd ports");
  ok(parseHostPort("bad host") === null, "garbage rejected");
}

console.log("\n[3] protocol bytes — what edgetunnel's parser expects");
{
  const h = buildVlessHeader(UUID, "www.gstatic.com", 80);
  ok(h[0] === 0, "VLESS version byte = 0");
  ok(h.subarray(1, 17).toString("hex") === UUID.replace(/-/g, ""), "bytes 1-16 = UUID");
  ok(h[17] === 0 && h[18] === 1, "addons-len 0, command 1 (TCP)");
  ok(h.readUInt16BE(19) === 80, "port big-endian at 19-20");
  ok(h[21] === 2 && h[22] === 15 && h.subarray(23).toString() === "www.gstatic.com", "atyp 2 (domain) + length + name");
  const h4 = buildVlessHeader(UUID, "1.2.3.4", 443);
  ok(h4[21] === 1 && [...h4.subarray(22)].join(".") === "1.2.3.4", "atyp 1 (IPv4)");
  const h6 = buildVlessHeader(UUID, "2606:4700::1", 443);
  ok(h6[21] === 3 && h6.length === 22 + 16 && h6[h6.length - 1] === 1, "atyp 3 (IPv6) for VLESS");
  const t = buildTrojanHeader(UUID, "example.com", 80);
  ok(t.subarray(0, 56).toString() === crypto.createHash("sha224").update(UUID).digest("hex"), "Trojan: sha224(password) hex");
  ok(t[56] === 0x0d && t[57] === 0x0a && t[58] === 1 && t[59] === 3, "Trojan: CRLF, cmd 1, atyp 3 (domain)");
  let threw = false;
  try { buildVlessHeader("not-a-uuid", "a.com", 80); } catch { threw = true; }
  ok(threw, "invalid UUID rejected");
}

console.log("\n[4] Trojan-detection collision guard");
{
  // edgetunnel treats a first message with CRLF at bytes 56-57 as Trojan.
  const hdr = buildVlessHeader(UUID, "a.com", 80); // 28 bytes
  const pad = 56 - hdr.length;
  const payload = Buffer.concat([Buffer.alloc(pad, 0x41), Buffer.from("\r\nrest")]);
  const m = buildFirstMessages("vless", UUID, "a.com", 80, payload);
  ok(m.length === 2 && m[0].equals(hdr), "colliding payload → header sent alone first");
  ok(!(m[0].length >= 58 && m[0][56] === 0x0d && m[0][57] === 0x0a), "header-only message can't look like Trojan");
  const m2 = buildFirstMessages("vless", UUID, "a.com", 80, Buffer.from("GET / HTTP/1.1\r\nHost: a.com\r\n\r\n"));
  ok(m2.length === 1, "normal request → one combined message");
}

console.log("\n[5] WebSocket framing");
{
  for (const n of [0, 5, 125, 126, 1000, 65535, 65536, 300000]) {
    const p = crypto.randomBytes(n);
    const f = wsFrame(p);
    ok((f[1] & 0x80) !== 0, `len ${n}: client frame is masked`);
    const parser = new WsFrameParser();
    const frames = [];
    for (let i = 0; i < f.length; i += 997) frames.push(...parser.push(f.subarray(i, i + 997))); // split delivery
    ok(frames.length === 1 && frames[0].payload.equals(p) && frames[0].opcode === 2 && frames[0].fin, `len ${n}: round-trips through split chunks`);
  }
}

console.log("\n[6] Cloudflare IP sampling");
{
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ips = sampleIPv4(200, CF_IPV4_RANGES, rnd);
  ok(ips.length === 200 && new Set(ips).size === 200, "200 unique IPv4s");
  const toInt = (ip) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const inRange = (ip) => CF_IPV4_RANGES.some((cidr) => {
    const [b, bits] = cidr.split("/"); const size = 2 ** (32 - Number(bits));
    const start = Math.floor(toInt(b) / size) * size; return toInt(ip) >= start && toInt(ip) < start + size;
  });
  ok(ips.every(inRange), "every sample is inside a Cloudflare range");
  ok(ips.every((ip) => !/\.(0|255)$/.test(ip)), "no .0/.255 host addresses");
  const v6 = sampleIPv6(20);
  ok(v6.length === 20 && v6.every((x) => net.isIPv6(x)), "IPv6 samples are valid addresses");
}

console.log("\n[7] labels → edgetunnel ADD.txt + sp-vpn-hub carrier groups");
{
  ok(coloCountry("HKG") === "香港" && coloCountry("LAX") === "美国" && coloCountry("XYZ") === "XYZ", "colo → country word (unknown keeps code)");
  ok(makeLabel({ colo: "HKG" }, 0, "mobile") === "香港•移动 CF01", "mobile → 移动 (hub: Hong Kong•Mobile CF01)");
  ok(makeLabel({ colo: "SIN" }, 1, "telecom") === "新加坡•电信 CF02", "telecom → 电信");
  ok(makeLabel({ colo: "SJC" }, 2, "unicom") === "美国•联通 CF03", "unicom → 联通");
  ok(makeLabel({ colo: "NRT" }, 0, "") === "日本•CF01", "no ISP → no carrier word");
  const txt = toAddTxt([{ address: "104.18.42.72", port: 443, colo: "SIN" }, { address: "2606:4700::1", port: 2053, colo: "HKG" }], "telecom");
  ok(txt === "104.18.42.72:443#新加坡•电信 CF01\n[2606:4700::1]:2053#香港•电信 CF02\n", "ADD.txt lines (IPv6 bracketed)");
  ok(!/[,"]/.test(txt), "no commas/quotes (edgetunnel splits on them)");
}

console.log("\n[8] scoring");
{
  const a = scoreOf({ realDelayMs: 200, tcpLoss: 0 });
  ok(a === 200, "clean 200 ms → 200");
  ok(scoreOf({ realDelayMs: 150, tcpLoss: 0.25 }) > a, "25% loss is worse than 50 ms extra");
  ok(scoreOf({ realDelayMs: 150, proxyIpOk: false }) > a, "broken ProxyIP is worse than 50 ms extra");
  ok(scoreOf({ realDelayMs: 150, mbps: 1 }) > a, "< 2 Mbps is worse than 50 ms extra");
  ok(scoreOf({ realDelayMs: 150, tunnelFails: 1 }) > a, "a failed tunnel attempt is worse than 50 ms extra");
  ok(scoreOf({}) === Infinity, "nothing measured → last");
  ok(median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && median([]) === null, "median");
  ok(maskSecret(UUID) === "1111…5555" && maskSecret("short") === "****", "secrets masked in output");
}

// ───────────────────── fake edgetunnel (loopback) ─────────────────────
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgM0v4f3uqWM0BktmD
Sed95LGFRXCv+S+scnCy7X5nKz+hRANCAASHWOkjHLWhSncDJPmsLcpztCwO1f5A
o5yU69GUQCqSn1EVmhc08Kc8KdygroUPzHwd5CBsL+2kWxMIYnmVmL0l
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT6gAwIBAgIULAAI/UoCpWbEiRybWCsP7ISwRUYwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKcHJvYmUudGVzdDAgFw0yNjEwMTcyMTUxNTVaGA8yMTI2MDky
MzIxNTE1NVowFTETMBEGA1UEAwwKcHJvYmUudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABIdY6SMctaFKdwMk+awtynO0LA7V/kCjnJTr0ZRAKpKfURWaFzTw
pzwp3KCuhQ/MfB3kIGwv7aRbEwhieZWYvSWjajBoMB0GA1UdDgQWBBTvuYvHJ7zp
ClfIWpBkRamq09GnnjAfBgNVHSMEGDAWgBTvuYvHJ7zpClfIWpBkRamq09GnnjAP
BgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnByb2JlLnRlc3QwCgYIKoZIzj0E
AwIDSQAwRgIhAOS5euP0B/S10YbNVgt9gkzAyXX+awkyGMIQXSRitaHXAiEA9jun
JYpz8EnHVbHfN+Ibc1vBmbSQCupn5/lDyhjWTgA=
-----END CERTIFICATE-----`;

function serverFrame(payload, opcode = 2) { // server → client: unmasked
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

/** Mirrors edgetunnel: WS on any path; CRLF at 56-57 → Trojan else VLESS; bad UUID → drop. */
function fakeEdgetunnel({ colo, upgradeDelayMs = 0, uuid = UUID }) {
  const uuidHex = uuid.replace(/-/g, "");
  const trojanHash = crypto.createHash("sha224").update(uuid).digest("hex");
  const stats = { tunnels: 0, rejected: 0, protocols: [] };
  const server = tls.createServer({ key: KEY, cert: CERT, ALPNProtocols: ["http/1.1"] }, (sock) => {
    let buf = Buffer.alloc(0);
    const onHead = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      sock.off("data", onHead);
      const head = buf.subarray(0, idx).toString("latin1");
      const rest = buf.subarray(idx + 4);
      if (head.startsWith("GET /cdn-cgi/trace")) {
        const body = `fl=1\nh=probe.test\nip=203.0.113.50\nts=1\nvisit_scheme=https\ncolo=${colo}\nloc=CN\n`;
        sock.end(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncf-ray: 8f00000000000000-${colo}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        return;
      }
      const key = head.match(/\r\nsec-websocket-key:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (!/\r\nupgrade:\s*websocket/i.test(head) || !key) { sock.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nnginx"); return; }
      if (upgradeDelayMs) await new Promise((r) => setTimeout(r, upgradeDelayMs));
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const parser = new WsFrameParser(); // handles the client's masked frames
      let remote = null, pending = [], first = true, respHeader = null;
      const onFrames = (frames) => {
        for (const f of frames) {
          if (f.opcode === 8) return sock.destroy();
          if (f.opcode !== 2 && f.opcode !== 0) continue;
          if (!first) { remote ? remote.write(f.payload) : pending.push(f.payload); continue; }
          first = false;
          const b = f.payload;
          let host, port, data;
          if (b.length >= 58 && b[56] === 0x0d && b[57] === 0x0a) { // Trojan
            stats.protocols.push("trojan");
            if (b.subarray(0, 56).toString() !== trojanHash) { stats.rejected++; return sock.destroy(); }
            let i = 59; const at = b[i++];
            if (at === 1) { host = [...b.subarray(i, i + 4)].join("."); i += 4; }
            else if (at === 3) { const l = b[i++]; host = b.subarray(i, i + l).toString(); i += l; }
            else return sock.destroy();
            port = b.readUInt16BE(i); i += 2 + 2; data = b.subarray(i);
          } else { // VLESS
            stats.protocols.push("vless");
            if (b.subarray(1, 17).toString("hex") !== uuidHex) { stats.rejected++; return sock.destroy(); }
            let i = 18 + b[17]; i++; // skip addons + cmd
            port = b.readUInt16BE(i); i += 2;
            const at = b[i++];
            if (at === 1) { host = [...b.subarray(i, i + 4)].join("."); i += 4; }
            else if (at === 2) { const l = b[i++]; host = b.subarray(i, i + l).toString(); i += l; }
            else return sock.destroy();
            data = b.subarray(i);
            respHeader = Buffer.from([b[0], 0]);
          }
          stats.tunnels++;
          remote = net.connect({ host, port }, () => {
            if (data.length) remote.write(data);
            for (const p of pending) remote.write(p);
            pending = [];
          });
          remote.on("data", (d) => {
            if (respHeader) { d = Buffer.concat([respHeader, d]); respHeader = null; }
            for (let o = 0; o < d.length; o += 32768) sock.write(serverFrame(d.subarray(o, o + 32768)));
          });
          remote.on("end", () => sock.end(serverFrame(Buffer.alloc(0), 8)));
          remote.on("error", () => sock.destroy());
          sock.on("close", () => remote.destroy());
        }
      };
      sock.on("data", (c) => { try { onFrames(parser.push(c)); } catch { sock.destroy(); } });
      if (rest.length) sock.emit("data", rest);
    };
    sock.on("data", onHead);
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats })));
}

const big = crypto.randomBytes(2 * 1024 * 1024);
const targets = http.createServer((req, res) => {
  if (req.url.startsWith("/generate_204")) { res.writeHead(204); return res.end(); }
  if (req.url.startsWith("/file")) { res.writeHead(200, { "content-length": big.length }); return res.end(big); }
  if (req.url.startsWith("/cdn-cgi/trace")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("fl=1\nip=198.51.100.7\ncolo=HKG\nloc=HK\n"); }
  res.writeHead(404); res.end();
});
await new Promise((r) => targets.listen(0, "127.0.0.1", r));
const T = `http://127.0.0.1:${targets.address().port}`;
const fast = await fakeEdgetunnel({ colo: "HKG" });
const slow = await fakeEdgetunnel({ colo: "LAX", upgradeDelayMs: 150 });
const deadPort = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const opts = { insecure: true, delayUrl: `${T}/generate_204`, proxyIpUrl: `${T}/cdn-cgi/trace`, dlUrl: `${T}/file`, dlSeconds: 2, pings: 3, timeoutMs: 1500 };
const tunnel = { host: "probe.test", path: "/", proto: "vless", secret: UUID };

console.log("\n[9] network primitives against the fake edgetunnel");
{
  const tr = await edgeTrace({ address: "127.0.0.1", port: fast.port, host: "probe.test", insecure: true });
  ok(tr.ok && tr.colo === "HKG" && tr.loc === "CN", "edge trace → colo HKG, loc CN");
  const strict = await edgeTrace({ address: "127.0.0.1", port: fast.port, host: "probe.test" });
  ok(!strict.ok && /self.signed|certificate/i.test(strict.error || ""), "certificates are verified by default (self-signed rejected)");
  const d = await tunnelRequest({ address: "127.0.0.1", port: fast.port, host: "probe.test", proto: "vless", secret: UUID, target: { host: "127.0.0.1", port: targets.address().port, path: "/generate_204" }, mode: "head", insecure: true });
  ok(d.ok && d.status === 204 && d.delayMs > 0, `VLESS tunnel → 204 in ${Math.round(d.delayMs)} ms`);
  const tj = await tunnelRequest({ address: "127.0.0.1", port: fast.port, host: "probe.test", proto: "trojan", secret: UUID, target: { host: "127.0.0.1", port: targets.address().port, path: "/generate_204" }, mode: "head", insecure: true });
  ok(tj.ok && tj.status === 204, "Trojan tunnel → 204");
  const bad = await tunnelRequest({ address: "127.0.0.1", port: fast.port, host: "probe.test", proto: "vless", secret: "99999999-2222-4333-8444-555555555555", target: { host: "127.0.0.1", port: targets.address().port, path: "/generate_204" }, mode: "head", insecure: true, timeoutMs: 1000 });
  ok(!bad.ok && /wrong UUID/.test(bad.error), "wrong UUID → clear failure, never a false pass");
  const dl = await tunnelRequest({ address: "127.0.0.1", port: fast.port, host: "probe.test", proto: "vless", secret: UUID, target: { host: "127.0.0.1", port: targets.address().port, path: "/file" }, mode: "download", seconds: 3, insecure: true });
  ok(dl.ok && dl.bodyBytes === big.length && dl.mbps > 1, `download → all ${big.length} bytes, ${Math.round(dl.mbps)} Mbps`);
  const nf = await tunnelRequest({ address: "127.0.0.1", port: fast.port, host: "probe.test", proto: "vless", secret: UUID, target: { host: "127.0.0.1", port: targets.address().port, path: "/missing" }, mode: "download", seconds: 1, insecure: true });
  ok(nf.ok && nf.status === 404 && nf.mbps === null, "a 404 is not reported as a speed");
  ok(fast.stats.rejected === 1 && fast.stats.protocols.includes("trojan"), "server saw the Trojan session and rejected the bad UUID");
}

console.log("\n[10] runProbe() — ranking, filtering, budget");
{
  const lines = [];
  const res = await runProbe({
    candidates: [
      { address: "127.0.0.1", port: slow.port, label: "slow" },
      { address: "127.0.0.1", port: fast.port, label: "fast" },
      { address: "127.0.0.1", port: deadPort, label: "dead" },
    ],
    host: "probe.test", tunnel, opts, log: (s) => lines.push(s),
  });
  ok(res.ranked.length === 2, "dead port dropped, 2 ranked");
  ok(res.ranked[0].label === "fast" && res.ranked[1].label === "slow", "fast (HKG) ranked above slow (+150 ms upgrade)");
  ok(res.ranked[1].realDelayMs - res.ranked[0].realDelayMs > 100, "real delay reflects the extra 150 ms");
  ok(res.ranked.every((r) => r.proxyIpOk && r.proxyIpExit === "198.51.100.7"), "ProxyIP check read the exit IP through the tunnel");
  ok(res.ranked.every((r) => r.mbps > 0), "both got a download speed");
  ok(res.whereFrom?.loc === "CN", "reports where Cloudflare thinks we are");
  ok(lines.some((l) => /about \d+ Worker request/.test(l)), "announces the Worker-request cost before tunnelling");
  const res2 = await runProbe({ candidates: [{ address: "127.0.0.1", port: slow.port }, { address: "127.0.0.1", port: fast.port }], host: "probe.test", tunnel: null, opts: { ...opts, colos: ["LAX"] } });
  ok(res2.ranked.length === 1 && res2.ranked[0].colo === "LAX" && res2.ranked[0].realDelayMs === undefined, "--colo filter works; no tunnel when no UUID");
}

console.log("\n[11] CLI end-to-end (--sub file → best-ADD.txt), no secret leaks");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const sub = path.join(dir, "sub.txt");
  const mk = (port, label) => `vless://${UUID}@127.0.0.1:${port}?security=tls&type=ws&host=probe.test&sni=probe.test&path=%2F&encryption=none#${enc(label)}`;
  fs.writeFileSync(sub, Buffer.from([mk(slow.port, "US 联通优选[201ms]"), mk(fast.port, "US 联通优选[192ms]")].join("\n")).toString("base64"));
  const outFile = path.join(dir, "best-ADD.txt"), jsonFile = path.join(dir, "report.json");
  const lines = [];
  const code = await main(["--sub", sub, "--insecure", "--isp", "mobile", "--top", "2", "--pings", "2", "--timeout", "1500",
    "--delay-url", `${T}/generate_204`, "--proxyip-url", `${T}/cdn-cgi/trace`, "--dl-url", `${T}/file`, "--dl-seconds", "1",
    "--out", outFile, "--json", jsonFile], (s) => lines.push(String(s)));
  const add = fs.readFileSync(outFile, "utf8");
  ok(code === 0, "exit code 0");
  ok(add === `127.0.0.1:${fast.port}#香港•移动 CF01\n127.0.0.1:${slow.port}#美国•移动 CF02\n`, "best-ADD.txt: ranked, carrier-labelled");
  const all = lines.join("\n") + add + fs.readFileSync(jsonFile, "utf8");
  ok(!all.includes(UUID) && !all.includes(UUID.replace(/-/g, "")), "UUID never printed or written");
  ok(lines.some((l) => l.includes("1111…5555")), "UUID shown masked only");
  const code2 = await main(["--help"], () => {});
  ok(code2 === 0, "--help exits 0");
  let threw = false;
  try { await main(["--sub"], () => {}); } catch { threw = true; }
  ok(threw, "missing option value is an error");
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const s of [fast.server, slow.server, targets]) s.close();
console.log(`\n${failures ? "❌" : "✅"} ${checks - failures}/${checks} cf-node-probe checks passed`);
if (failures) process.exit(1);
process.exit(0);
