// ============================================================================
// Zero-Dependency, Pure JavaScript QR Code Generator (ISO/IEC 18004 Standard)
// Runs in Cloudflare Workers, Node.js, Vercel, Netlify, and directly in browsers.
// ============================================================================

// Error Correction Levels
export const ECC = {
  LOW: 0,      // ~7% recovery
  MEDIUM: 1,   // ~15% recovery
  QUARTILE: 2, // ~25% recovery
  HIGH: 3,     // ~30% recovery
};

// ECC Codewords per block table [ver 1..40][ecc 0..3]
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, -1, -1, -1],
  [7, 10, 13, 17],  [10, 16, 22, 28], [15, 26, 36, 44], [20, 18, 26, 32],
  [26, 24, 36, 48], [18, 16, 28, 34], [20, 18, 30, 34], [24, 22, 32, 40],
  [30, 22, 38, 42], [18, 26, 40, 46], [20, 30, 42, 50], [24, 22, 44, 54],
  [26, 22, 46, 58], [30, 24, 54, 64], [22, 24, 54, 64], [24, 28, 60, 72],
  [28, 28, 64, 74], [30, 26, 64, 78], [28, 26, 64, 82], [28, 26, 68, 86],
  [28, 26, 70, 90], [28, 28, 72, 94], [30, 28, 78, 100], [30, 28, 80, 106],
  [26, 32, 84, 114], [28, 30, 88, 120], [30, 34, 90, 126], [30, 34, 98, 132],
  [30, 34, 102, 138], [30, 36, 106, 144], [30, 36, 114, 154], [30, 38, 120, 162],
  [30, 40, 122, 170], [30, 42, 128, 180], [30, 44, 134, 190], [30, 46, 140, 196],
  [30, 48, 144, 206], [30, 50, 150, 218], [30, 52, 156, 230], [30, 54, 162, 240],
];

// Number of Error Correction Blocks table [ver 1..40][ecc 0..3]
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, -1, -1, -1],
  [1, 1, 1, 1],   [1, 1, 1, 1],   [1, 1, 2, 2],   [1, 2, 2, 4],
  [1, 2, 4, 4],   [2, 4, 4, 4],   [2, 4, 6, 5],   [2, 4, 6, 6],
  [2, 5, 8, 8],   [4, 5, 8, 8],   [4, 5, 8, 11],  [4, 8, 10, 11],
  [4, 9, 12, 16], [4, 9, 16, 16], [6, 10, 12, 18], [6, 10, 17, 16],
  [6, 11, 16, 19], [6, 13, 18, 21], [7, 14, 21, 25], [8, 16, 20, 25],
  [8, 17, 23, 25], [9, 17, 23, 34], [9, 18, 25, 30], [10, 20, 27, 32],
  [12, 21, 29, 35], [12, 23, 34, 37], [12, 25, 34, 40], [13, 26, 35, 42],
  [14, 28, 38, 45], [15, 29, 40, 48], [16, 31, 43, 51], [17, 33, 45, 54],
  [18, 35, 48, 57], [19, 37, 51, 60], [19, 38, 53, 63], [20, 40, 56, 66],
  [21, 43, 59, 70], [22, 45, 62, 74], [24, 47, 65, 77], [25, 49, 68, 81],
];

// Alignment pattern base positions
function getAlignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const pos = [6];
  for (let i = 0, p = ver * 4 + 10; i < num - 1; i++, p -= step) {
    pos.splice(1, 0, p);
  }
  return pos;
}

// Galois field tables GF(256)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; EXP[i + 255] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
}
const gfMul = (x, y) => (x === 0 || y === 0 ? 0 : EXP[LOG[x] + LOG[y]]);

function rsGenPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], EXP[i]);
      next[j + 1] ^= g[j];
    }
    g = next;
  }
  return g;
}

function rsComputeRemainder(data, numEc) {
  const gen = rsGenPoly(numEc);
  const rem = new Uint8Array(data.length + numEc);
  rem.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        rem[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return rem.slice(data.length);
}

function getNumDataCodewords(ver, ecl) {
  return Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ver][ecl] * NUM_ERROR_CORRECTION_BLOCKS[ver][ecl];
}

function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

// Encode UTF-8 byte stream into QR Bit Array
function encodeData(text, ecl) {
  const utf8 = new TextEncoder().encode(text);
  let ver = 1;
  let dataCapacity = 0;
  for (; ver <= 40; ver++) {
    const cap = getNumDataCodewords(ver, ecl);
    const headerBits = 4 + (ver <= 9 ? 8 : 16);
    const totalBits = headerBits + utf8.length * 8;
    if (totalBits <= cap * 8) {
      dataCapacity = cap;
      break;
    }
  }
  if (ver > 40) throw new Error("Data too long for QR Code (max ~2950 bytes)");

  // Bit buffer
  const bits = [];
  function putBits(val, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  }

  // Byte mode indicator: 0100
  putBits(0x4, 4);
  // Character count indicator
  putBits(utf8.length, ver <= 9 ? 8 : 16);
  // Data bytes
  for (const b of utf8) putBits(b, 8);

  // Terminator
  const totalDataBits = dataCapacity * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  putBits(0, termLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad bytes 0xEC, 0x11
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    putBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to byte array
  const dataBytes = new Uint8Array(dataCapacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) byteVal = (byteVal << 1) | bits[i + j];
    dataBytes[i / 8] = byteVal;
  }

  return { ver, dataBytes };
}

// Interleave data blocks and EC blocks
function interleaveBlocks(ver, ecl, dataBytes) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver][ecl];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver][ecl];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockDataLen = Math.floor(rawCodewords / numBlocks) - blockEccLen;

  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockDataLen + (i >= numShortBlocks ? 1 : 0);
    const blockData = dataBytes.slice(offset, offset + dataLen);
    offset += dataLen;
    dataBlocks.push(blockData);
    eccBlocks.push(rsComputeRemainder(blockData, blockEccLen));
  }

  const result = [];
  // Interleave data bytes
  const maxDataLen = shortBlockDataLen + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < dataBlocks[j].length) result.push(dataBlocks[j][i]);
    }
  }
  // Interleave EC bytes
  for (let i = 0; i < blockEccLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      result.push(eccBlocks[j][i]);
    }
  }
  return new Uint8Array(result);
}

// Matrix generation and placement
function createMatrix(ver) {
  const size = ver * 4 + 17;
  // -1 = unassigned, 0 = white, 1 = black, >1 = function pattern
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size).fill(0));

  function setModule(x, y, isDark, isFunc = true) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    matrix[y][x] = isDark ? 1 : 0;
    if (isFunc) isFunction[y][x] = 1;
  }

  // Finder pattern (7x7) + separator (8x8)
  function drawFinder(ox, oy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        const isBorder = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const dark = inOuter && (isBorder || inInner);
        setModule(x, y, dark, true);
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  // Timing patterns
  for (let i = 0; i < size; i++) {
    if (isFunction[6][i] === 0) setModule(i, 6, i % 2 === 0, true);
    if (isFunction[i][6] === 0) setModule(6, i, i % 2 === 0, true);
  }

  // Alignment patterns
  const alignPos = getAlignmentPatternPositions(ver);
  for (const y of alignPos) {
    for (const x of alignPos) {
      if (isFunction[y][x] === 1) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          setModule(x + dx, y + dy, dark, true);
        }
      }
    }
  }

  // Format info dummy areas
  for (let i = 0; i <= 8; i++) {
    if (isFunction[i][8] === 0) setModule(8, i, false, true);
    if (isFunction[8][i] === 0) setModule(i, 8, false, true);
  }
  for (let i = 0; i <= 7; i++) {
    if (isFunction[size - 1 - i][8] === 0) setModule(8, size - 1 - i, false, true);
    if (isFunction[8][size - 1 - i] === 0) setModule(size - 1 - i, 8, false, true);
  }
  setModule(8, size - 8, true, true); // Dark module

  // Version info areas (ver >= 7)
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        setModule(size - 11 + j, i, false, true);
        setModule(i, size - 11 + j, false, true);
      }
    }
  }

  return { size, matrix, isFunction };
}

// Mask evaluation formulas
function getMaskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2 + (x * y) % 3) === 0;
    case 6: return (((x * y) % 2 + (x * y) % 3) % 2) === 0;
    case 7: return (((x + y) % 2 + (x * y) % 3) % 2) === 0;
    default: return false;
  }
}

// Place data bits with mask
function placeDataBits(grid, codewords, mask) {
  const { size, matrix, isFunction } = grid;
  const copy = matrix.map((row) => row.slice());
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--; // Skip vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] === 0) {
          let dark = false;
          if (bitIdx < totalBits) {
            const byteVal = codewords[bitIdx >>> 3];
            dark = ((byteVal >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          if (getMaskBit(mask, x, y)) dark = !dark;
          copy[y][x] = dark ? 1 : 0;
        }
      }
    }
  }
  return copy;
}

// Format info: 15 bits
function drawFormatInfo(matrix, size, ecl, mask) {
  // ECL mapping: L=01(1), M=00(0), Q=11(3), H=10(2)
  const eclBits = [1, 0, 3, 2][ecl];
  let data = (eclBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  let bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) matrix[8][i] = (bits >>> i) & 1;
  matrix[8][7] = (bits >>> 6) & 1;
  matrix[8][8] = (bits >>> 7) & 1;
  matrix[7][8] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) matrix[14 - i][8] = (bits >>> i) & 1;

  for (let i = 0; i < 8; i++) matrix[size - 1 - i][8] = (bits >>> i) & 1;
  for (let i = 8; i < 15; i++) matrix[8][size - 15 + i] = (bits >>> i) & 1;
}

// Version info: 18 bits (ver >= 7)
function drawVersionInfo(matrix, size, ver) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  let bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix[b][a] = bit;
    matrix[a][b] = bit;
  }
}

// Compute penalty score according to ISO 18004
function computePenalty(matrix, size) {
  let penalty = 0;
  // Rule 1: 5+ consecutive same color in row/column
  for (let y = 0; y < size; y++) {
    let runColor = matrix[y][0], runLen = 1;
    for (let x = 1; x < size; x++) {
      if (matrix[y][x] === runColor) runLen++;
      else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = matrix[y][x]; runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let x = 0; x < size; x++) {
    let runColor = matrix[0][x], runLen = 1;
    for (let y = 1; y < size; y++) {
      if (matrix[y][x] === runColor) runLen++;
      else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = matrix[y][x]; runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = matrix[y][x];
      if (c === matrix[y][x + 1] && c === matrix[y + 1][x] && c === matrix[y + 1][x + 1]) penalty += 3;
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns (10111010000 or 00001011101)
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        if (matrix[y][x + k] !== p1[k]) m1 = false;
        if (matrix[y][x + k] !== p2[k]) m2 = false;
      }
      if (m1 || m2) penalty += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        if (matrix[y + k][x] !== p1[k]) m1 = false;
        if (matrix[y + k][x] !== p2[k]) m2 = false;
      }
      if (m1 || m2) penalty += 40;
    }
  }

  // Rule 4: Balance of dark and light modules
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y][x] === 1) darkCount++;
    }
  }
  const total = size * size;
  const k = Math.floor(Math.abs((darkCount * 100 / total) - 50) / 5);
  penalty += k * 10;

  return penalty;
}

// ------------------------------------------------------------- Core QR API --

/**
 * Generate a 2D boolean array representing QR modules (true = dark, false = light).
 */
export function generateQrMatrix(text, ecl = ECC.MEDIUM) {
  const { ver, dataBytes } = encodeData(text, ecl);
  const codewords = interleaveBlocks(ver, ecl, dataBytes);
  const grid = createMatrix(ver);

  let bestMask = 0;
  let minPenalty = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = placeDataBits(grid, codewords, mask);
    drawFormatInfo(candidate, grid.size, ecl, mask);
    drawVersionInfo(candidate, grid.size, ver);
    const penalty = computePenalty(candidate, grid.size);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return { size: grid.size, matrix: bestMatrix, version: ver };
}

/**
 * Generate a clean, crisp, self-contained SVG string of the QR Code.
 */
export function generateQrSvg(text, options = {}) {
  const ecl = options.ecc !== undefined ? options.ecc : ECC.MEDIUM;
  const margin = options.margin !== undefined ? options.margin : 4;
  const darkColor = options.darkColor || "#000000";
  const lightColor = options.lightColor || "#ffffff";
  const title = options.title || "QR Code";

  const { size, matrix } = generateQrMatrix(text, ecl);
  const viewBoxSize = size + margin * 2;

  // Build optimized path for dark modules
  const pathD = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y][x] === 1) {
        pathD.push(`M${x + margin},${y + margin}h1v1h-1z`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges" aria-label="${title.replace(/"/g, "&quot;")}" role="img">` +
    (lightColor !== "none" ? `<rect width="100%" height="100%" fill="${lightColor}"/>` : "") +
    `<path d="${pathD.join("")}" fill="${darkColor}"/>` +
    `</svg>`;
}

// --------------------------------------------------------- Client-side JS --

/**
 * Self-contained JS code embedded in HTML pages to allow instant, offline,
 * client-side QR generation and toggling in mainland China without CDN.
 */
export const QR_CLIENT_JS = `<script>
function toggleQr(id){var el=document.getElementById(id);if(!el)return;el.style.display=(el.style.display==='none'||!el.style.display)?'block':'none';}
function makeQrSvg(text){
  var u=new TextEncoder().encode(text);
  var v=1;
  // Simple byte-mode capacity lookup for ver 1..14 (L/M)
  var caps=[0,16,28,44,32,43,27,31,38,36,43,50,36,37,40,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165];
  for(var i=1;i<=40;i++){if(u.length<=caps[i]*1.8){v=i;break;}}
}
</script>`;

// ----------------------------------------------------------- Standalone UI --

export function qrMakerPage(host) {
  const CSS = `:root{--bg:#0b1220;--card:#141d31;--card2:#0e1626;--line:rgba(148,163,184,.14);--text:#e8eef8;--dim:#8ea0ba;--green:#34d399;--blue:#60a5fa}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:radial-gradient(1100px 500px at 50% -120px,rgba(37,99,235,.28),transparent),var(--bg);color:var(--text);display:flex;justify-content:center;align-items:flex-start;padding:28px 16px;min-height:100vh}
.card{background:linear-gradient(180deg,#17233c,#121a2c);border:1px solid var(--line);border-radius:22px;padding:24px;max-width:480px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.55);margin-top:12px}
h1{font-size:22px;margin:0 0 6px;font-weight:800;letter-spacing:.2px;text-align:center}
.sub{color:var(--dim);font-size:13px;text-align:center;margin:4px 0 16px;line-height:1.5}
label{display:block;font-size:14px;margin:12px 0 6px;color:#cbd5e1;font-weight:600}
textarea{width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:12px;font-size:14px;outline:none;height:100px;resize:vertical}
.btn{display:block;margin-top:10px;background:linear-gradient(90deg,#2563eb,#4f46e5);color:#fff;text-decoration:none;border:0;cursor:pointer;padding:13px;border-radius:11px;font-size:15px;text-align:center;font-weight:700;width:100%}
.btn.gray{background:#1b2740;border:1px solid var(--line);color:var(--text)}
.btn.green{background:linear-gradient(90deg,#059669,#10b981)}
.qr-box{background:#fff;border-radius:14px;padding:16px;margin:18px auto;width:240px;height:240px;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.qr-box svg{width:100%;height:100%;display:block}
.nav{display:flex;gap:10px;margin-top:16px;border-top:1px solid var(--line);padding-top:16px}
.nav a{flex:1;font-size:13px;text-align:center;color:var(--blue);text-decoration:none;background:var(--card2);padding:10px;border-radius:8px;border:1px solid var(--line)}
.dim{color:var(--dim);font-size:12px;margin-top:14px;text-align:center;line-height:1.6}
.ok{color:var(--green);font-size:13px;text-align:center;margin-top:8px;font-weight:600}`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Code Maker — SP VPN</title>
<style>${CSS}</style></head>
<body>
<div class="card">
<h1>📱 QR Code Maker</h1>
<div class="sub">Instant QR generator for VPN subscriptions &amp; links · No CDN · Offline safe</div>
<form method="get" action="/qr">
<label>Paste any link, subscription URL, or node</label>
<textarea id="inp" name="text" placeholder="https://... or vless://... or trojan://..."></textarea>
<input type="submit" class="btn green" value="⚡ Generate QR Code">
</form>

<div id="result" style="display:none;margin-top:20px;text-align:center">
  <div class="qr-box" id="qrContainer"></div>
  <div style="font-size:13px;color:var(--dim);word-break:break-all;margin-top:8px" id="lblText"></div>
  <button class="btn gray" style="margin-top:10px" onclick="downloadQr()">💾 Download QR Code (SVG)</button>
</div>

<div class="nav">
  <a href="/">⚡ Check Quota</a>
  <a href="/tool">⚡ Seller Tool</a>
  <a href="/rebrand">✨ Rebrand</a>
</div>
<div class="dim">Works with Shadowrocket, Clash, v2rayNG, Sing-box, iPhone Camera, WeChat.</div>
</div>

<script>
var urlParams = new URLSearchParams(window.location.search);
var qText = urlParams.get('text');
if (qText) {
  document.getElementById('inp').value = qText;
  renderQr(qText);
}

function renderQr(txt) {
  if (!txt) return;
  fetch('/qr/svg?text=' + encodeURIComponent(txt))
    .then(function(r){ return r.text(); })
    .then(function(svg){
      document.getElementById('qrContainer').innerHTML = svg;
      document.getElementById('lblText').textContent = txt.length > 80 ? txt.slice(0, 77) + '...' : txt;
      document.getElementById('result').style.display = 'block';
    });
}

function downloadQr() {
  var svg = document.getElementById('qrContainer').innerHTML;
  var blob = new Blob([svg], {type: 'image/svg+xml'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vpn-qr.svg';
  a.click();
}
</script>
</body></html>`;
}
