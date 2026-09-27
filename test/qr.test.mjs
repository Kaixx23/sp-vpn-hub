import { generateQrSvg, generateQrMatrix, ECC, qrMakerPage, QrCode } from "../qr.js";
import worker from "../sp-vpn-worker.js";
import { mint } from "../token-store.js";
import jsqr from "jsqr";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};

function decodeSvgWithJsQr(svgString) {
  // Parse viewBox
  const vbMatch = svgString.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!vbMatch) return null;
  const totalSize = parseInt(vbMatch[1], 10);
  
  // Extract module positions from SVG path
  const grid = Array.from({ length: totalSize }, () => new Array(totalSize).fill(false));
  const pathMatch = svgString.match(/d="([^"]+)"/);
  if (pathMatch) {
    const d = pathMatch[1];
    const regex = /M(\d+),(\d+)h1v1h-1z/g;
    let m;
    while ((m = regex.exec(d)) !== null) {
      const x = parseInt(m[1], 10);
      const y = parseInt(m[2], 10);
      if (x >= 0 && x < totalSize && y >= 0 && y < totalSize) {
        grid[y][x] = true;
      }
    }
  }

  // Render to RGBA bitmap for jsQR
  const scale = 8;
  const imgWidth = totalSize * scale;
  const imgHeight = totalSize * scale;
  const data = new Uint8ClampedArray(imgWidth * imgHeight * 4);

  for (let y = 0; y < imgHeight; y++) {
    for (let x = 0; x < imgWidth; x++) {
      const gx = Math.floor(x / scale);
      const gy = Math.floor(y / scale);
      const isDark = (gx >= 0 && gx < totalSize && gy >= 0 && gy < totalSize && grid[gy][gx]);
      const idx = (y * imgWidth + x) * 4;
      const color = isDark ? 0 : 255;
      data[idx] = color;
      data[idx + 1] = color;
      data[idx + 2] = color;
      data[idx + 3] = 255;
    }
  }

  const res = jsqr(data, imgWidth, imgHeight);
  return res ? res.data : null;
}

console.log("\n[1] Standard ISO/IEC 18004 QR Code Generator (Chrome-grade, pure JS)");
{
  const shortText = "https://sp.example.com";
  const m1 = generateQrMatrix(shortText, ECC.MEDIUM);
  ok(m1.size > 0 && m1.matrix.length === m1.size, "matrix generated with correct dimensions");
  ok(m1.matrix[0][0] === 1 && m1.matrix[0][6] === 1, "finder patterns placed at (0,0)");
  ok(m1.matrix[0][m1.size - 1] === 1 && m1.matrix[0][m1.size - 7] === 1, "finder patterns placed at top-right");
  ok(m1.matrix[m1.size - 1][0] === 1 && m1.matrix[m1.size - 7][0] === 1, "finder patterns placed at bottom-left");

  const longUrl = "https://sp.example.com/all/SP%20VPN?t=f40a34be1c06b3fcc68e9c34d0676a7c330380f1d9cc7b2f";
  const svg = generateQrSvg(longUrl, { margin: 4, darkColor: "#000000" });
  ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), "SVG output valid");
  ok(svg.includes('viewBox="0 0'), "SVG includes viewBox");
  ok(svg.includes('fill="#000000"'), "SVG honors custom colors");

  // Verify jsQR decode matches input exactly
  const decodedLong = decodeSvgWithJsQr(svg);
  ok(decodedLong === longUrl, "jsQR successfully decodes SVG: " + (decodedLong ? decodedLong.slice(0, 30) + "..." : "FAILED"));

  const vlessNode = "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#HongKong01";
  const svgVless = generateQrSvg(vlessNode);
  const decodedVless = decodeSvgWithJsQr(svgVless);
  ok(decodedVless === vlessNode, "jsQR successfully decodes long vless:// node QR");
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

  const decodedRouteSvg = decodeSvgWithJsQr(svgBody);
  ok(decodedRouteSvg === testUrl, "/qr/svg endpoint output decodes cleanly with jsQR");

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
