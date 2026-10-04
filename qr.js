// ============================================================================
// Standard ISO/IEC 18004 QR Code Generator (Clean, Zero Dependencies)
// Based on Project Nayuki's reference implementation (Public Domain / MIT)
// Used by Google Chrome, Chromium, and standard production QR systems.
// ============================================================================

export class QrCode {
  static Ecc = {
    LOW: 0,
    MEDIUM: 1,
    QUARTILE: 2,
    HIGH: 3,
  };

  static encodeText(text, ecl = QrCode.Ecc.MEDIUM) {
    const segs = QrSegment.makeSegments(text);
    return QrCode.encodeSegments(segs, ecl);
  }

  static encodeBinary(data, ecl = QrCode.Ecc.MEDIUM) {
    const seg = QrSegment.makeBytes(data);
    return QrCode.encodeSegments([seg], ecl);
  }

  static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
    if (!(1 <= minVersion && minVersion <= maxVersion && maxVersion <= 40) || mask < -1 || mask > 7) {
      throw new RangeError("Invalid version or mask parameter");
    }

    let version, dataUsedBits;
    for (version = minVersion; ; version++) {
      const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
      const usedBits = QrSegment.getTotalBits(segs, version);
      if (usedBits <= dataCapacityBits) {
        dataUsedBits = usedBits;
        break;
      }
      if (version >= maxVersion) {
        throw new RangeError("Data too long for QR Code");
      }
    }

    if (boostEcl) {
      for (const newEcl of [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) {
        if (dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8) {
          ecl = newEcl;
        }
      }
    }

    const bb = [];
    for (const seg of segs) {
      QrCode.appendBits(seg.mode, 4, bb);
      QrCode.appendBits(seg.numChars, seg.numCharCountBits(version), bb);
      for (const b of seg.bitData) bb.push(b);
    }

    const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
    QrCode.appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
    QrCode.appendBits(0, (8 - (bb.length % 8)) % 8, bb);

    for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      QrCode.appendBits(padByte, 8, bb);
    }

    const dataCodewords = new Uint8Array(bb.length / 8);
    for (let i = 0; i < bb.length; i++) {
      dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7));
    }

    return new QrCode(version, ecl, dataCodewords, mask);
  }

  constructor(version, errorCorrectionLevel, dataCodewords, msk) {
    this.version = version;
    this.errorCorrectionLevel = errorCorrectionLevel;
    this.size = version * 4 + 17;

    const size = this.size;
    this.modules = Array.from({ length: size }, () => new Array(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

    this.drawFunctionPatterns();
    const allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    if (msk === -1) {
      let minPenalty = 1000000000;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          msk = i;
          minPenalty = penalty;
        }
        this.applyMask(i);
      }
    }
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    const alignPatPos = QrCode.getAlignmentPatternPositions(this.version);
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))
          continue;
        this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
      }
    }

    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  drawFormatBits(mask) {
    const data = QrCode.FORMAT_BITS[this.errorCorrectionLevel][mask];
    for (let i = 0; i <= 5; i++)
      this.setFunctionModule(8, i, QrCode.getBit(data, i));
    this.setFunctionModule(8, 7, QrCode.getBit(data, 6));
    this.setFunctionModule(8, 8, QrCode.getBit(data, 7));
    this.setFunctionModule(7, 8, QrCode.getBit(data, 8));
    for (let i = 9; i < 15; i++)
      this.setFunctionModule(14 - i, 8, QrCode.getBit(data, i));

    for (let i = 0; i < 8; i++)
      this.setFunctionModule(this.size - 1 - i, 8, QrCode.getBit(data, i));
    for (let i = 8; i < 15; i++)
      this.setFunctionModule(8, this.size - 15 + i, QrCode.getBit(data, i));
    this.setFunctionModule(8, this.size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    const rem = QrCode.VERSION_BITS[this.version - 7];
    for (let i = 0; i < 18; i++) {
      const bit = QrCode.getBit(rem, i);
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  addEccAndInterleave(data) {
    const ver = this.version, ecl = this.errorCorrectionLevel;
    const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const rs = QrCode.reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i >= numShortBlocks ? 1 : 0));
      k += dat.length;
      const ecc = QrCode.reedSolomonComputeRemainder(dat, rs);
      blocks.push({ data: dat, ecc });
    }

    const result = [];
    for (let i = 0; i < shortBlockLen - blockEccLen + 1; i++) {
      for (let j = 0; j < numBlocks; j++) {
        if (i < blocks[j].data.length) result.push(blocks[j].data[i]);
      }
    }
    for (let i = 0; i < blockEccLen; i++) {
      for (let j = 0; j < numBlocks; j++) {
        result.push(blocks[j].ecc[i]);
      }
    }
    return new Uint8Array(result);
  }

  drawCodewords(data) {
    const size = this.size;
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x]) {
            let dark = false;
            if (bitIndex < data.length * 8) {
              dark = QrCode.getBit(data[bitIndex >>> 3], 7 - (bitIndex & 7));
              bitIndex++;
            }
            this.modules[y][x] = dark;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const size = this.size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.isFunction[y][x]) {
          let invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: throw new Error("Invalid mask");
          }
          if (invert) this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }

  getPenaltyScore() {
    const size = this.size;
    let result = 0;

    for (let y = 0; y < size; y++) {
      let runColor = false, runLen = 0;
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result++;
        } else {
          runColor = this.modules[y][x];
          runLen = 1;
        }
      }
    }

    for (let x = 0; x < size; x++) {
      let runColor = false, runLen = 0;
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result++;
        } else {
          runColor = this.modules[y][x];
          runLen = 1;
        }
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1])
          result += 3;
      }
    }

    for (let y = 0; y < size; y++) {
      let bits = 0;
      for (let x = 0; x < size; x++) {
        bits = ((bits << 1) & 0x7ff) | (this.modules[y][x] ? 1 : 0);
        if (x >= 10 && (bits === 0x05d || bits === 0x5d0)) result += 40;
      }
    }

    for (let x = 0; x < size; x++) {
      let bits = 0;
      for (let y = 0; y < size; y++) {
        bits = ((bits << 1) & 0x7ff) | (this.modules[y][x] ? 1 : 0);
        if (y >= 10 && (bits === 0x05d || bits === 0x5d0)) result += 40;
      }
    }

    let dark = 0;
    for (const row of this.modules) {
      for (const color of row) {
        if (color) dark++;
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  static getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  static appendBits(val, len, bb) {
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  static getNumDataCodewords(ver, ecl) {
    return Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
      QrCode.ECC_CODEWORDS_PER_BLOCK[ecl][ver] * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  static getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  static getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const num = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10, i = 0; i < num - 1; i++, pos -= step)
      result.splice(1, 0, pos);
    return result;
  }

  static reedSolomonComputeDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = QrCode.reedSolomonMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = QrCode.reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  static reedSolomonComputeRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++)
        result[i] ^= QrCode.reedSolomonMultiply(divisor[i], factor);
    }
    return result;
  }

  static reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  toSvgString(border = 4, darkColor = "#000000", lightColor = "#ffffff") {
    const size = this.size + border * 2;
    const parts = [];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x]) {
          parts.push(`M${x + border},${y + border}h1v1h-1z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
      (lightColor ? `<rect width="100%" height="100%" fill="${lightColor}"/>` : "") +
      `<path d="${parts.join("")}" fill="${darkColor}"/>` +
      `</svg>`;
  }
}

export class QrSegment {
  static Mode = {
    NUMERIC: 0x1,
    ALPHANUMERIC: 0x2,
    BYTE: 0x4,
    KANJI: 0x8,
    ECI: 0x7,
  };

  static makeBytes(data) {
    const bb = [];
    for (const b of data) QrCode.appendBits(b, 8, bb);
    return new QrSegment(QrSegment.Mode.BYTE, data.length, bb);
  }

  static makeSegments(text) {
    return [QrSegment.makeBytes(new TextEncoder().encode(text))];
  }

  static getTotalBits(segs, version) {
    let result = 0;
    for (const seg of segs) {
      const ccbits = seg.numCharCountBits(version);
      result += 4 + ccbits + seg.bitData.length;
    }
    return result;
  }

  constructor(mode, numChars, bitData) {
    this.mode = mode;
    this.numChars = numChars;
    this.bitData = bitData;
  }

  numCharCountBits(version) {
    const i = Math.floor((version + 7) / 17);
    switch (this.mode) {
      case QrSegment.Mode.NUMERIC: return [10, 12, 14][i];
      case QrSegment.Mode.ALPHANUMERIC: return [9, 11, 13][i];
      case QrSegment.Mode.BYTE: return [8, 16, 16][i];
      case QrSegment.Mode.KANJI: return [8, 10, 12][i];
      case QrSegment.Mode.ECI: return 0;
      default: throw new Error("Invalid mode");
    }
  }
}

QrCode.ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 32, 30, 34, 34, 34, 36, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54],
  [-1, 13, 22, 36, 26, 36, 28, 30, 32, 38, 40, 42, 44, 46, 54, 54, 60, 64, 64, 64, 68, 70, 72, 78, 80, 84, 88, 90, 98, 102, 106, 114, 120, 122, 128, 134, 140, 144, 150, 156, 162],
  [-1, 17, 28, 44, 32, 48, 34, 34, 40, 42, 46, 50, 54, 58, 64, 64, 72, 74, 78, 82, 86, 90, 94, 100, 106, 114, 120, 126, 132, 138, 144, 154, 162, 170, 180, 190, 196, 206, 218, 230, 240],
];

QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

QrCode.FORMAT_BITS = [
  [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976], // Low
  [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0], // Medium
  [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed], // Quartile
  [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b], // High
];

QrCode.VERSION_BITS = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d,
  0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9,
  0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75,
  0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64,
  0x27541, 0x28c69,
];

// ------------------------------------------------------------- Core Helpers --

export const ECC = QrCode.Ecc;

export function generateQrMatrix(text, ecl = QrCode.Ecc.MEDIUM) {
  const qr = QrCode.encodeText(text, ecl);
  return {
    size: qr.size,
    matrix: qr.modules.map((row) => row.map((m) => (m ? 1 : 0))),
    version: qr.version,
    qr,
  };
}

export function generateQrSvg(text, options = {}) {
  const ecl = options.ecc !== undefined ? options.ecc : QrCode.Ecc.MEDIUM;
  const margin = options.margin !== undefined ? options.margin : 4;
  const darkColor = options.darkColor || "#000000";
  const lightColor = options.lightColor || "#ffffff";
  const qr = QrCode.encodeText(text, ecl);
  return qr.toSvgString(margin, darkColor, lightColor);
}

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
<div class="sub">Standard QR generator for Clash, Shadowrocket &amp; all apps · 100% Offline Safe</div>
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
<div class="dim">Works with Shadowrocket, Clash Meta, v2rayNG, Sing-box, iPhone Camera, WeChat.</div>
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
