/* ==========================================================================
   qrcode.js · 零依赖 QR 码生成器（小满券仓 · 分享海报二维码）
   —— 算法移植自 Nayuki qrcodegen（MIT），byte 模式 + 纠错级 M，自动选版本（限 1..15，
      足以容纳本站深链 https://coupon.zangeng.com/p/<id> 的 ~80 字符）。
   —— 无网络、无第三方库；输出布尔矩阵，由 share.js 绘制到 canvas。
   —— 静默失败：输入超长（>v15-M 容量）时 encode() 返回 null，调用方降级为无二维码海报。
   用法：window.QRCode.encode(text) -> { size, modules:boolean[][] } | null
   ========================================================================== */
(function (global) {
  'use strict';

  // 纠错级 M：每块 ECC 码字（index = 版本-1，v1..v15）
  var ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
  // 纠错级 M：分块数（v1..v15）
  var NUM_BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];

  var MAX_VERSION = 15;
  var MIN_VERSION = 1;

  /* ------------------------- GF(256) Reed-Solomon ------------------------- */
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= rsMultiply(coef, factor); });
    });
    return result;
  }

  /* ----------------------------- 容量与选版本 ----------------------------- */
  // 版本可容纳的“数据+功能”总模块数（不含功能图形）
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver - 1] * NUM_BLOCKS_M[ver - 1];
  }

  // byte 模式所需比特：模式(4)+计数(v1-9为8/v10+为16)+数据*8
  function neededBits(len, ver) {
    var cciBits = ver < 10 ? 8 : 16;
    return 4 + cciBits + len * 8;
  }

  function pickVersion(len) {
    for (var ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
      if (neededBits(len, ver) <= numDataCodewords(ver) * 8) return ver;
    }
    return null; // 超出 v15-M 容量
  }

  /* ------------------------------ 位编码 ------------------------------ */
  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function encodeSegments(bytes, ver) {
    var bb = new BitBuffer();
    bb.put(4, 4); // byte 模式
    bb.put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { bb.put(b, 8); });
    var capacityBits = numDataCodewords(ver) * 8;
    // 终止符（最多 4 个 0）
    bb.put(0, Math.min(4, capacityBits - bb.bits.length));
    // 补到字节边界
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    // 交替 0xEC / 0x11 填充
    var pad = 0xEC;
    while (bb.bits.length < capacityBits) {
      bb.put(pad, 8);
      pad ^= 0xEC ^ 0x11;
    }
    // 位 -> 码字
    var codewords = [];
    for (var i = 0; i < bb.bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
      codewords.push(byte);
    }
    return codewords;
  }

  /* --------------------------- 分块 + 交织 + ECC --------------------------- */
  function addEccCodewords(dataCodewords, ver) {
    var numBlocks = NUM_BLOCKS_M[ver - 1];
    var eccLen = ECC_PER_BLOCK_M[ver - 1];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var shortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(eccLen);

    var blocks = [];
    var blocksData = [];
    var blocksEcc = [];
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var blk = dataCodewords.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
      k += blk.length;
      blocksData.push(blk);
      blocksEcc.push(rsRemainder(blk, divisor));
    }
    var result = [];
    // 交织需迭代到最长块（短块数 = numBlocks - raw%numBlocks，长块多 1 个数据码字）
    var maxDataLen = shortLen - eccLen + 1;
    for (var j = 0; j < maxDataLen; j++) {
      for (var b = 0; b < numBlocks; b++) if (j < blocksData[b].length) result.push(blocksData[b][j]);
    }
    for (var e = 0; e < eccLen; e++) {
      for (var b2 = 0; b2 < numBlocks; b2++) result.push(blocksEcc[b2][e]);
    }
    return result;
  }

  /* ------------------------------ 矩阵绘制 ------------------------------ */
  function alignPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    var size = ver * 4 + 17;
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function drawFinder(m, size, x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < size && xx >= 0 && xx < size) m.set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlign(m, size, x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        m.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function QrMatrix(size) {
    this.size = size;
    this.modules = [];
    this.isReserve = [];
    for (var y = 0; y < size; y++) {
      this.modules.push(new Array(size).fill(false));
      this.isReserve.push(new Array(size).fill(false));
    }
  }
  QrMatrix.prototype.set = function (x, y, dark) { this.modules[y][x] = !!dark; };
  QrMatrix.prototype.get = function (x, y) { return this.modules[y][x]; };
  QrMatrix.prototype.isDarkFn = function (x, y) { return this.modules[y][x]; };
  QrMatrix.prototype.reserve = function (x, y) { this.isReserve[y][x] = true; };
  QrMatrix.prototype.isReserved = function (x, y) { return this.isReserve[y][x]; };

  function buildFunctionPatterns(m, ver) {
    var size = m.size;
    // 定位 + 分隔
    drawFinderReserve(m, size, 3, 3);
    drawFinderReserve(m, size, size - 4, 3);
    drawFinderReserve(m, size, 3, size - 4);
    // 时序
    for (var i = 8; i < size - 8; i++) {
      var dark = i % 2 === 0;
      if (!m.isReserved(i, 6)) { m.set(i, 6, dark); m.reserve(i, 6); }
      if (!m.isReserved(6, i)) { m.set(6, i, dark); m.reserve(6, i); }
    }
    // 校正图形
    var pos = alignPositions(ver);
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === pos.length - 1) || (a === pos.length - 1 && b === 0)) continue;
        drawAlign(m, size, pos[b], pos[a]);
        reserveAlign(m, pos[b], pos[a]);
      }
    }
    // 预留格式 / 版本区
    m.reserve(size - 1, 6); m.reserve(size - 8, 6);
    for (var i2 = 0; i2 < 9; i2++) { m.reserve(i2, 8); m.reserve(8, i2); }
    for (var i3 = 0; i3 < 8; i3++) { m.reserve(8, size - 1 - i3); m.reserve(size - 1 - i3, 8); }
    // 固定暗模块（格式区）
    m.set(8, size - 8, true); m.reserve(8, size - 8);
    if (ver >= 7) reserveVersion(m, size);
  }

  function drawFinderReserve(m, size, x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < size && xx >= 0 && xx < size) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          m.set(xx, yy, dist !== 2 && dist !== 4);
          m.reserve(xx, yy);
        }
      }
    }
  }

  function reserveAlign(m, x, y) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) m.reserve(x + dx, y + dy);
  }

  function reserveVersion(m, size) {
    // 版本信息区为 3×6（两个对角块），必须全部预留，否则数据码字会被写入随后又被覆盖丢失
    for (var i = 0; i < 6; i++) {
      for (var j = 0; j < 3; j++) {
        m.reserve(size - 11 + j, i);
        m.reserve(i, size - 11 + j);
      }
    }
  }

  function drawFormatBits(m, ver, mask) {
    var size = m.size;
    // 纠错级 M 的格式标识为 0b00，data = (0 << 3) | mask
    var bits = (0 << 3) | mask;
    var rem = bits;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var allBits = ((bits << 10) | rem) ^ 0x5412;
    for (var j = 0; j <= 5; j++) setFn(m, 8, j, getBit(allBits, j));
    setFn(m, 8, 7, getBit(allBits, 6));
    setFn(m, 8, 8, getBit(allBits, 7));
    setFn(m, 7, 8, getBit(allBits, 8));
    for (var k = 9; k < 15; k++) setFn(m, 14 - k, 8, getBit(allBits, k));
    for (var l = 0; l < 8; l++) setFn(m, size - 1 - l, 8, getBit(allBits, l));
    for (var n = 8; n < 15; n++) setFn(m, 8, size - 15 + n, getBit(allBits, n));
    setFn(m, 8, size - 8, true); // 固定暗
  }

  function setFn(m, x, y, dark) { m.set(x, y, dark); m.reserve(x, y); }
  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function drawVersion(m, ver) {
    if (ver < 7) return;
    var size = m.size;
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (ver << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = size - 11 + j % 3;
      var b = Math.floor(j / 3);
      setFn(m, a, b, bit);
      setFn(m, b, a, bit);
    }
  }

  function drawCodewords(m, codewords) {
    var size = m.size;
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!m.isReserved(x, y) && i < codewords.length * 8) {
            m.set(x, y, getBit(codewords[i >>> 3], 7 - (i & 7)));
            i++;
          }
        }
      }
    }
  }

  function applyMask(m, mask) {
    var size = m.size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (m.isReserved(x, y)) continue;
        var invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: break;
        }
        if (invert) m.set(x, y, !m.get(x, y));
      }
    }
  }

  function penalty(m) {
    var size = m.size, result = 0;
    // 规则1：行/列连续同色 >=5
    for (var dir = 0; dir < 2; dir++) {
      for (var a = 0; a < size; a++) {
        var runColor = false, runLen = 0;
        for (var b = 0; b < size; b++) {
          var color = dir === 0 ? m.get(b, a) : m.get(a, b);
          if (color === runColor) {
            runLen++;
            if (runLen === 5) result += 3;
            else if (runLen > 5) result++;
          } else { runColor = color; runLen = 1; }
        }
      }
    }
    // 规则2：2x2 同色块
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = m.get(x, y);
        if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) result += 3;
      }
    }
    // 规则3：类似定位图形 1:1:3:1:1 + 4 空白
    for (var y2 = 0; y2 < size; y2++) {
      for (var x2 = 0; x2 < size - 6; x2++) {
        if (m.get(x2, y2) && !m.get(x2 + 1, y2) && m.get(x2 + 2, y2) && m.get(x2 + 3, y2) && m.get(x2 + 4, y2) && !m.get(x2 + 5, y2) && (m.get(x2 + 6, y2))) {
          if (finderLike(x2, y2, size, 'h', m)) result += 40;
        }
      }
    }
    for (var y3 = 0; y3 < size - 6; y3++) {
      for (var x3 = 0; x3 < size; x3++) {
        if (m.get(x3, y3) && !m.get(x3, y3 + 1) && m.get(x3, y3 + 2) && m.get(x3, y3 + 3) && m.get(x3, y3 + 4) && !m.get(x3, y3 + 5) && m.get(x3, y3 + 6)) {
          if (finderLikeV(x3, y3, size, m)) result += 40;
        }
      }
    }
    // 规则4：暗色比例
    var dark = 0;
    for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) if (m.get(xx, yy)) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
  function finderLike(x, y, size, dir, m) {
    // 模式前/后需 ≥4 个连续亮模块（越界方向不计）
    var a = x - 4 >= 0 && !m.get(x - 1, y) && !m.get(x - 2, y) && !m.get(x - 3, y) && !m.get(x - 4, y);
    var b = x + 10 < size && !m.get(x + 7, y) && !m.get(x + 8, y) && !m.get(x + 9, y) && !m.get(x + 10, y);
    return a || b;
  }
  function finderLikeV(x, y, size, m) {
    var a = y - 4 >= 0 && !m.get(x, y - 1) && !m.get(x, y - 2) && !m.get(x, y - 3) && !m.get(x, y - 4);
    var b = y + 10 < size && !m.get(x, y + 7) && !m.get(x, y + 8) && !m.get(x, y + 9) && !m.get(x, y + 10);
    return a || b;
  }

  /* ------------------------------- 主流程 ------------------------------- */
  function encode(text) {
    if (typeof text !== 'string' || !text.length) return null;
    var bytes = toUtf8Bytes(text);
    var ver = pickVersion(bytes.length);
    if (!ver) return null;
    var dataCw = encodeSegments(bytes, ver);
    var allCw = addEccCodewords(dataCw, ver);
    var size = ver * 4 + 17;
    var base = new QrMatrix(size);
    buildFunctionPatterns(base, ver);
    // 试 8 种掩码取罚分最小
    var bestM = null, bestPenalty = Infinity, bestMask = 0;
    for (var mask = 0; mask < 8; mask++) {
      var m = cloneMatrix(base);
      drawCodewords(m, allCw);
      applyMask(m, mask);
      drawFormatBits(m, ver, mask);
      drawVersion(m, ver);
      var p = penalty(m);
      if (p < bestPenalty) { bestPenalty = p; bestM = m; bestMask = mask; }
    }
    return { size: bestM.size, modules: bestM.modules };
  }

  function cloneMatrix(src) {
    var m = new QrMatrix(src.size);
    for (var y = 0; y < src.size; y++) for (var x = 0; x < src.size; x++) {
      m.modules[y][x] = src.modules[y][x];
      m.isReserve[y][x] = src.isReserve[y][x];
    }
    return m;
  }

  global.QRCode = { encode: encode };
})(window);
