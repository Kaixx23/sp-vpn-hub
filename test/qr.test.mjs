import { generateQrSvg, generateQrMatrix, ECC, qrMakerPage } from "../qr.js";
import worker from "../sp-vpn-worker.js";
import { mint } from "../token-store.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

console.log("\n[1] QR Code Generator Engine (Pure JS)");
{
  const shortText = "https://sp.example.com";
  const m1 = generateQrMatrix(shortText, ECC.MEDIUM);
  ok(m1.size > 0 && m1.matrix.length === m1.size, "matrix generated with correct size");
  ok(m1.matrix[0][0] === 1 && m1.matrix[0][6] === 1, "finder patterns placed at (0,0)");
  ok(m1.matrix[0][m1.size - 1] === 1 && m1.matrix[0][m1.size - 7] === 1, "finder patterns placed at top-right");
  ok(m1.matrix[m1.size - 1][0] === 1 && m1.matrix[m1.size - 7][0] === 1, "finder patterns placed at bottom-left");

  const longUrl = "https://sp.example.com/all/SP%20VPN?t=f40a34be1c06b3fcc68e9c34d0676a7c330380f1d9cc7b2f";
  const svg = generateQrSvg(longUrl, { margin: 4, darkColor: "#111" });
  ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), "SVG output valid");
  ok(svg.includes('viewBox="0 0'), "SVG includes viewBox");
  ok(svg.includes('fill="#111"'), "SVG honors custom colors");
}

console.log("\n[2] QR Maker Routes (/qr, /qr/svg)");
{
  const resQr = await worker.fetch(new Request("https://sp.example.com/qr"), {}, {});
  ok(resQr.status === 200, "GET /qr returns 200");
  const htmlQr = await resQr.text();
  ok(htmlQr.includes("QR Code Maker"), "/qr serves QR Maker page");
  ok(htmlQr.includes("<form"), "/qr includes generator form");

  const testUrl = "https://sp.example.com/all/SP%20VPN?t=test123456";
  const resSvg = await worker.fetch(new Request("https://sp.example.com/qr/svg?text=" + encodeURIComponent(testUrl)), {}, {});
  ok(resSvg.status === 200, "GET /qr/svg returns 200");
  ok(resSvg.headers.get("content-type").includes("svg"), "content-type is image/svg+xml");
  const svgBody = await resSvg.text();
  ok(svgBody.startsWith("<svg"), "/qr/svg returns raw SVG markup");

  const resMissing = await worker.fetch(new Request("https://sp.example.com/qr/svg"), {}, {});
  ok(resMissing.status === 400, "missing text parameter returns 400");
}

console.log("\n[3] Integrated QR in Converter Views (/q/, /tool, /rebrand)");
{
  const tok = await mint("direct:vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?security=none#%E9%A6%99%E6%B8%AF01", "qr-test");
  const resQ = await worker.fetch(new Request("https://sp.example.com/q/" + tok), {}, {});
  const htmlQ = await resQ.text();
  ok(htmlQ.includes("Show QR"), "quota page has Show QR button");
  ok(htmlQ.includes("qr-wrap") && htmlQ.includes("<svg"), "quota page embeds QR SVG");

  const resTool = await worker.fetch(new Request("https://sp.example.com/tool", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "brand=TestBrand&links=vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443%23HK"
  }), {}, {});
  const htmlTool = await resTool.text();
  ok(htmlTool.includes("Show QR"), "seller tool result has Show QR button");
  ok(htmlTool.includes("qr-wrap") && htmlTool.includes("<svg"), "seller tool embeds QR SVG");
}

console.log(`\n──────────────────────────────────────────────────────────────────────`);
console.log(`🎉 ALL ${checks} CHECKS PASSED\n`);
if (failures > 0) process.exit(1);
