// PNG 比對：只用 node:zlib，不依賴套件。結果只用來「排序」，不判通過。
import zlib from "node:zlib";
import crypto from "node:crypto";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 只讀檔頭：回傳 { w, h, depth, colorType, interlace } 或 null（不是 PNG）
export function readHeader(buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(SIG) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], interlace: buf[28] };
}

// 解碼 8-bit RGB／RGBA、非交錯。其他格式丟 Error("unsupported: ...")
export function decodePng(buf) {
  const hd = readHeader(buf);
  if (!hd) throw new Error("unsupported: 不是 PNG");
  if (hd.depth !== 8 || (hd.colorType !== 2 && hd.colorType !== 6) || hd.interlace !== 0)
    throw new Error(`unsupported: 位元深度 ${hd.depth}、色彩類型 ${hd.colorType}、交錯 ${hd.interlace}`);
  const ch = hd.colorType === 6 ? 4 : 3;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = hd.w * ch;
  if (raw.length < (stride + 1) * hd.h) throw new Error("unsupported: 資料長度不足");
  const out = Buffer.alloc(stride * hd.h);
  for (let y = 0; y < hd.h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? out[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error("unsupported: filter " + f);
      out[dst + x] = v & 255;
    }
  }
  return { w: hd.w, h: hd.h, ch, data: out };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
// 編碼 RGB 或 RGBA（filter 0）
export function encodePng({ w, h, ch, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// 差異像素的外框，最多 maxBlocks 個：先依「列」切成帶（空白列間隔大的切開），帶太多就把間隔最小的併起來，再各自求左右邊界
export function regionsOf(rowCounts, colMinMax, maxBlocks = 3, minGap = 40) {
  const bands = [];
  for (let y = 0; y < rowCounts.length; y++) {
    if (!rowCounts[y]) continue;
    const last = bands[bands.length - 1];
    if (last && y - last.y1 <= minGap) last.y1 = y;
    else bands.push({ y0: y, y1: y });
  }
  while (bands.length > maxBlocks) {
    let bi = 0, bg = Infinity;
    for (let i = 0; i < bands.length - 1; i++) {
      const g = bands[i + 1].y0 - bands[i].y1;
      if (g < bg) { bg = g; bi = i; }
    }
    bands.splice(bi, 2, { y0: bands[bi].y0, y1: bands[bi + 1].y1 });
  }
  return bands.map((b) => {
    let x0 = Infinity, x1 = -1;
    for (let y = b.y0; y <= b.y1; y++) {
      const m = colMinMax[y];
      if (m && m[0] <= m[1]) { x0 = Math.min(x0, m[0]); x1 = Math.max(x1, m[1]); }
    }
    return { x: x0, y: b.y0, w: x1 - x0 + 1, h: b.y1 - b.y0 + 1 };
  });
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// 比對兩張圖（Buffer）。回傳：
//  { status: "ok", md5Same, sizeChanged, from:[w,h], to:[w,h], ratio, regions, diffImage? }
//  { status: "unsupported", reason, sizeChanged, from, to }（尺寸能讀但不能算像素差）
// a＝舊（基準）、b＝新。尺寸不同時不算像素差（ratio 為 null）
export function compareImages(a, b, { makeDiffImage = false, threshold = 16 } = {}) {
  const ha = readHeader(a), hb = readHeader(b);
  if (!ha || !hb) return { status: "unsupported", reason: "讀不到 PNG 檔頭", sizeChanged: false, from: null, to: null };
  const from = [ha.w, ha.h], to = [hb.w, hb.h];
  const md5 = (x) => crypto.createHash("md5").update(x).digest("hex");
  const md5Same = md5(a) === md5(b);
  if (ha.w !== hb.w || ha.h !== hb.h) return { status: "ok", md5Same: false, sizeChanged: true, from, to, ratio: null, regions: [] };
  if (md5Same) return { status: "ok", md5Same, sizeChanged: false, from, to, ratio: 0, regions: [] };
  let A, B;
  try {
    A = decodePng(a);
    B = decodePng(b);
  } catch (e) {
    return { status: "unsupported", reason: e.message.replace(/^unsupported: /, ""), sizeChanged: false, from, to };
  }
  const { w, h } = A;
  const rowCounts = new Array(h).fill(0);
  const colMinMax = new Array(h).fill(null);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * w + x) * A.ch, ib = (y * w + x) * B.ch;
      if (Math.abs(lum(A.data, ia) - lum(B.data, ib)) > threshold) {
        n++;
        rowCounts[y]++;
        const m = colMinMax[y];
        if (!m) colMinMax[y] = [x, x];
        else { if (x < m[0]) m[0] = x; if (x > m[1]) m[1] = x; }
      }
    }
  }
  const regions = n ? regionsOf(rowCounts, colMinMax) : [];
  const res = { status: "ok", md5Same: false, sizeChanged: false, from, to, ratio: n / (w * h), regions };
  if (makeDiffImage && regions.length) res.diffImage = drawRegions(B, regions);
  return res;
}

// 在新圖上畫紅框（3px），回傳 PNG Buffer
export function drawRegions(img, regions) {
  const { w, h, ch } = img;
  const data = Buffer.from(img.data);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * ch;
    data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
    if (ch === 4) data[i + 3] = 255;
  };
  for (const r of regions) {
    const x0 = r.x - 2, y0 = r.y - 2, x1 = r.x + r.w + 1, y1 = r.y + r.h + 1;
    for (let t = 0; t < 3; t++) {
      for (let x = x0 - t; x <= x1 + t; x++) { put(x, y0 - t); put(x, y1 + t); }
      for (let y = y0 - t; y <= y1 + t; y++) { put(x0 - t, y); put(x1 + t, y); }
    }
  }
  return encodePng({ w, h, ch, data });
}

// 前後幾乎相同：pairs 為 compareImages 的結果陣列（只放 before 對 after）。≥ 50% 對差異 < 0.1%（或 md5 相同）就算
export function nearIdentical(pairs, { ratio = 0.001, share = 0.5 } = {}) {
  const usable = pairs.filter((p) => p && p.status === "ok");
  const same = usable.filter((p) => !p.sizeChanged && (p.md5Same || p.ratio < ratio)).length;
  return { warn: usable.length > 0 && same / usable.length >= share, same, total: usable.length, md5Same: usable.filter((p) => p.md5Same).length };
}

// 基準的網址跟本次的網址相同 → 回傳 [{ baselineSite, label, url }]
export function sameUrlSites(baselineSites, currentSites) {
  const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
  const cur = new Set(Object.values(currentSites).map((s) => norm(s.url)));
  return Object.entries(baselineSites || {}).filter(([, s]) => cur.has(norm(s.url))).map(([k, s]) => ({ baselineSite: k, label: s.label || "", url: s.url }));
}

// 排序用：尺寸不同在前，然後依像素比例由大到小
export function sortDiffs(items) {
  return [...items].sort((x, y) => (y.d.sizeChanged ? 1 : 0) - (x.d.sizeChanged ? 1 : 0) || (y.d.ratio ?? -1) - (x.d.ratio ?? -1));
}
