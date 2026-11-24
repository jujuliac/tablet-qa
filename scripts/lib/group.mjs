// sweep 後處理：分類（已接受／刻意設計／環境／要看）→ 分組 → 排序 → 白話描述
// 所有函式都在 Node 端跑，不進瀏覽器。

export const CHECK_NAME = {
  overflow: "橫向溢出",
  clipped: "文字被裁切",
  scrollbox: "內捲區",
  shortLastLine: "最後一行太短",
  lineJump: "行數突變",
  sizeJump: "尺寸突變",
  tap: "點擊範圍",
  invisible: "捲完還透明",
  fixedCover: "固定列佔高",
  env: "觸控環境不成立",
};

export const ALL_CHECKS = ["overflow", "clipped", "scrollbox", "tap", "invisible", "fixedCover", "lineJump", "sizeJump", "shortLastLine"];
export const REGRESSION_CHECKS = ["overflow", "clipped", "scrollbox", "tap", "invisible", "fixedCover"];
// --checks：沒給 = 全部；regression = 回歸預設集；其他是逗號列表（regression 可以和別的混用）
export function parseChecks(v) {
  if (v === undefined) return [...ALL_CHECKS];
  if (typeof v !== "string" || !v.trim()) throw new Error(`--checks 要給檢查名稱（逗號分隔）：${ALL_CHECKS.join("、")}，或 regression`);
  const set = new Set();
  for (const n of v.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (n === "regression") REGRESSION_CHECKS.forEach((c) => set.add(c));
    else if (ALL_CHECKS.includes(n)) set.add(n);
    else throw new Error(`--checks 沒有「${n}」。可用：${ALL_CHECKS.join("、")}，或 regression（= ${REGRESSION_CHECKS.join("、")}）`);
  }
  return ALL_CHECKS.filter((c) => set.has(c));
}

// 嚴重度（數字小的先看）：overflow > clipped(無備註) > scrollbox > tap 重疊 > tap 太小 > invisible > lineJump/sizeJump > fixedCover > shortLastLine
export function tapKind(f) {
  return f.value?.overlap?.length || (f.note || "").includes("蓋住") ? "overlap" : "size";
}
export function severity(check, kind) {
  if (check === "env") return 0;
  if (check === "overflow") return 1;
  if (check === "clipped") return 2;
  if (check === "scrollbox") return 2.5;
  if (check === "tap") return kind === "overlap" ? 3 : 4;
  if (check === "invisible") return 5;
  if (check === "lineJump" || check === "sizeJump") return 6;
  if (check === "fixedCover") return 7;
  return 8; // shortLastLine
}

// ---------- 分類 ----------
// match 的寫法：
//   "字串"          元素文字完全相等，或 id／class／標籤名／data-testid 其中一個完全相等（不是子字串，select 不會吃到 selected）
//   { css: "..." }  元素本身符合這個 CSS 選擇器（量測時用 element.matches 記下）
//   { text: "..." } 元素文字（前 40 字）包含這段
function matchOk(m, f) {
  if (m === undefined) return true;
  if (typeof m === "string") return f.text === m || (f.tokens || []).includes(m);
  if (m.css !== undefined && !(f.matches || []).includes(m.css)) return false;
  if (m.text !== undefined && !(f.text || "").includes(m.text)) return false;
  return true;
}

// 回傳 { cls: "accepted"|"intentional"|"env"|"reference"|"review", reason }
// isRef：這筆量測的寬度低於 tabletMin（手機版），線索只當參考
export function classify(f, pageId, exceptions, isRef = false) {
  if (f.check === "env") return { cls: "env", reason: "觸控環境不成立" };
  for (const e of exceptions) {
    if (e.check !== f.check) continue;
    if (!(e.page === "*" || [].concat(e.page).includes(pageId))) continue;
    if (!matchOk(e.match, f)) continue;
    if (e.min !== undefined && f.check === "tap") {
      // 尺寸例外只管「點擊範圍夠不夠大」：跟鄰近目標重疊、或被蓋住的，一律不吃例外
      if (tapKind(f) === "overlap") continue;
      const hw = f.value?.hitW, hh = f.value?.hitH;
      if (typeof hw !== "number" || typeof hh !== "number") continue; // 舊格式沒有數值，不敢接受
      if (Math.min(hw, hh) < e.min) continue;
    } else if (f.check === "tap" && tapKind(f) === "overlap") {
      continue; // 沒寫 min 的 tap 例外也不蓋重疊
    }
    return { cls: "accepted", reason: (e.reason || "已接受") + (e.min !== undefined ? `（下限 ${e.min}px）` : "") };
  }
  if (isRef) return { cls: "reference", reason: "手機版（參考）" };
  if (f.check === "invisible" && f.stackedToggle) return { cls: "stack", reason: "切換堆疊（參考）：同位置有一個完全顯示的兄弟" };
  if (f.check === "invisible" && f.pointerNone) return { cls: "intentional", reason: "不接收點擊的透明層（pointer-events: none）" };
  if (f.check === "invisible" && f.fadingIn) return { cls: "timing", reason: "進場動畫時間差（參考）：祖先 opacity 介於 0.05–0.99，淡入進行中" };
  if (f.check === "tap" && f.sameHrefCover) return { cls: "intentional", reason: "同一連結的外層覆蓋整張卡，點旁邊一樣有效" };
  // note 只在每個有超出的方向都有對應的刻意處理時才會有（見 sweep 的 clipped）
  if (f.check === "clipped" && f.note) return { cls: "intentional", reason: f.note };
  return { cls: "review", reason: "" };
}

// 取證重測時已看得見的「捲完還透明」組（g.reappeared 由 evidence 設定）：
// 同一個元素（selector＋text）在所有寬度的 review 線索一起改成 cls "timing"（進場動畫時間差，參考）。
// 回傳 { kept: 留在主清單的組, demoted: 被移走的組, moved: 改類別的線索數 }
export function demoteReappeared(groups, records) {
  const isD = (g) => g.check === "invisible" && g.reappeared;
  const keys = new Set();
  for (const g of groups) if (isD(g)) for (const m of g.members) keys.add(`${m.selector}\u0001${m.text}`);
  let moved = 0;
  for (const r of records)
    for (const f of r.findings)
      if (f.check === "invisible" && f.cls === "review" && keys.has(`${f.selector}\u0001${f.text}`)) {
        f.cls = "timing";
        f.reason = "進場動畫時間差（參考）：取證重測時已看得見";
        moved++;
      }
  return { kept: groups.filter((g) => !isD(g)), demoted: groups.filter(isD), moved };
}

// ---------- 嚴重程度分數（同一組裡越大越糟，用來挑最差寬度） ----------
function parseWH(s) {
  const m = String(s).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function worstScore(f, minTap) {
  const v = f.value || {};
  switch (f.check) {
    case "overflow":
      return (v.right ?? v.scrollWidth ?? 0) - (v.viewport ?? 0);
    case "clipped":
      return Math.max((v.scrollWidth || 0) - (v.clientWidth || 0), (v.scrollHeight || 0) - (v.clientHeight || 0));
    case "scrollbox":
      return (v.scrollHeight || 0) - (v.clientHeight || 0);
    case "tap":
      return tapKind(f) === "overlap" ? 100 + (v.overlap?.length || 1) : minTap - Math.min(v.hitW ?? 0, v.hitH ?? 0);
    case "lineJump": {
      const n = Object.values(v).map(Number);
      return Math.max(...n) - Math.min(...n);
    }
    case "sizeJump": {
      const ws = Object.values(v).map(parseWH).filter(Boolean);
      if (ws.length < 2) return 1;
      const rw = ws[1][0] / ws[0][0], rh = ws[1][1] / ws[0][1];
      return Math.max(rw, 1 / rw, rh, 1 / rh);
    }
    case "fixedCover":
      return v.ratio || 0;
    case "shortLastLine":
      return 1 - (v.lastLineWidth || 0) / Math.max(1, v.blockWidth || 1);
    default:
      return 1;
  }
}

// ---------- 白話描述 ----------
export function worstPhrase(f, rec, minTap) {
  const v = f.value || {};
  switch (f.check) {
    case "overflow":
      if (f.selector === "html") return `整頁寬 ${v.scrollWidth}px，視窗只有 ${v.viewport}px（多出 ${v.scrollWidth - v.viewport}px）`;
      return `右緣超出視窗 ${v.right - v.viewport}px`;
    case "clipped": {
      const dx = (v.scrollWidth || 0) - (v.clientWidth || 0), dy = (v.scrollHeight || 0) - (v.clientHeight || 0);
      return [dx > 1 ? `橫向多出 ${dx}px` : "", dy > 1 ? `直向多出 ${dy}px` : ""].filter(Boolean).join("、") + "，被框切掉" + (f.axisNote ? `（${f.axisNote}）` : "");
    }
    case "scrollbox":
      return `內容 ${v.scrollHeight}px、框 ${v.clientHeight}px，要確認看得出還有內容、最後一項到得了`;
    case "shortLastLine":
      return `最後一行只剩「${v.lastLine}」（${v.lines} 行）`;
    case "tap": {
      if (f.sameHrefCover) return "旁邊是同一連結的外層覆蓋，實際可點";
      if (tapKind(f) === "overlap") {
        if ((f.note || "").includes("蓋住")) return "中心點被別的元素蓋住，點不到";
        if (v.extended) return "擴大的點擊區蓋到旁邊的可點元素，會搶走它的點擊";
        const names = (v.overlapText || []).filter(Boolean).map((t) => `「${t}」`).join("、");
        return `點擊範圍跟旁邊的${names || "其他可點元素"}重疊`;
      }
      const w = v.hitW, h = v.hitH;
      if (h < minTap - 0.5 && w < minTap - 0.5) return `點擊範圍 ${Math.floor(w)}×${Math.floor(h)}px（要 ${minTap}）`;
      if (h < minTap - 0.5) return `點擊範圍高 ${Math.floor(h)}px（要 ${minTap}）`;
      return `點擊範圍寬 ${Math.floor(w)}px（要 ${minTap}）`;
    }
    case "invisible":
      return `捲完還是看不見（${v.visibility === "hidden" ? "visibility: hidden" : `opacity ${v.opacity}`}）`;
    case "lineJump":
      return "行數 " + Object.entries(v).map(([w, n]) => `${w}px=${n}行`).join(" → ");
    case "sizeJump":
      return "尺寸 " + Object.entries(v).map(([w, s]) => `${w}px=${s}`).join(" → ");
    case "fixedCover":
      return `固定在頂端的東西佔畫面 ${Math.round((v.ratio || 0) * 100)}%（${v.height}px／${v.viewportHeight}px）`;
    default:
      return JSON.stringify(v);
  }
}

// ---------- 分組 ----------
// records：同一個網站的量測紀錄（findings 已有 cls，records 要有 idx）。回傳指定類別（預設 review）的群組陣列（已排序）
// 每組 members 記每個成員的 selector、rect、profile、頁面、寬度、原始紀錄索引（record）與該紀錄內第幾條（finding）
export function groupReview(records, minTap, { cls = "review", prefix = "G" } = {}) {
  const map = new Map();
  for (const r of records) {
    for (const [fi, f] of r.findings.entries()) {
      if (f.cls !== cls) continue;
      const kind = f.check === "tap" ? tapKind(f) : "";
      const key = [f.check, kind, f.selector, f.text].join("\u0001");
      let g = map.get(key);
      if (!g) {
        g = { check: f.check, kind, selector: f.selector, text: f.text, sev: severity(f.check, kind), pages: new Map(), cells: new Map(), count: 0, worst: null, score: -Infinity };
        map.set(key, g);
      }
      g.count++;
      // cells：這組的每條線索按「頁|寬度」放（給 --compare 逐寬度比用，不寫進輸出檔）
      const ck = `${r.page}|${r.width}`;
      if (!g.cells.has(ck)) g.cells.set(ck, []);
      g.cells.get(ck).push(f);
      if (!g.pages.has(r.page)) g.pages.set(r.page, new Set());
      g.pages.get(r.page).add(r.width);
      const sc = worstScore(f, minTap);
      if (sc > g.score) {
        g.score = sc;
        g.worst = { page: r.page, width: r.width, profile: r.profile, height: r.height, kind: r.kind, f, idx: r.idx, fi };
      }
    }
  }
  const groups = [...map.values()].map((g) => {
    const w = g.worst;
    return {
      ...g,
      pages: [...g.pages.entries()].map(([page, ws]) => ({ page, widths: [...ws].sort((a, b) => a - b) })),
      members: [{ selector: g.selector, text: g.text, rect: w.f.rect, profile: w.profile, page: w.page, width: w.width, record: w.idx, finding: w.fi }],
    };
  });
  // 第二輪合併：
  //  1. 同一父層的兄弟（pid 相同）、同頁同寬度、同檢查、同描述，只差 nth-* 的並排元素 → 「同類 N 個」；
  //     tap 重疊是整排的事，描述不含鄰居名字，合成「同列 N 個」。不同區塊的同名元件（父層不同）不合併。
  //  2. 跑馬燈等套件複製出來的同一元素（同大小、同 src／文字，其中有祖先是複製容器的）→ 合成一組
  const strip = (x) => (x || "").replace(/:nth-(of-type|child)\(\d+\)/g, "");
  const pw = (g) => `${g.worst.page}|${g.worst.width}|${g.worst.kind}`;
  const cloneSigs = new Set(groups.filter((g) => g.worst.f.clone && g.worst.f.sig).map((g) => `${g.check}|${pw(g)}|${g.worst.f.sig}`));
  const merged = new Map();
  const out = [];
  for (const g of groups) {
    const f = g.worst.f;
    const isClone = f.sig && cloneSigs.has(`${g.check}|${pw(g)}|${f.sig}`);
    const phrase = g.kind === "overlap" ? "overlap-row" : worstPhrase(f, g.worst, minTap);
    let key = null;
    if (isClone) key = ["clone", g.check, g.kind, f.sig, phrase, pw(g), JSON.stringify(g.pages)].join("\u0001");
    else if (f.pid !== undefined) key = ["sib", g.check, g.kind, strip(g.selector), g.kind === "overlap" ? "" : g.text, phrase, pw(g), f.pid, JSON.stringify(g.pages)].join("\u0001");
    const m = key && merged.get(key);
    if (m) {
      m.same++;
      m.count += g.count;
      m.members.push(...g.members);
      for (const [k, arr] of g.cells) m.cells.set(k, [...(m.cells.get(k) || []), ...arr]);
      if (isClone) m.cloneOf = true;
    } else {
      Object.assign(g, { same: 1, row: g.kind === "overlap", cloneOf: !!isClone });
      if (key) merged.set(key, g);
      out.push(g);
    }
  }
  out.sort((a, b) =>
    a.sev - b.sev ||
    b.pages.length - a.pages.length ||
    b.pages.reduce((n, p) => n + p.widths.length, 0) - a.pages.reduce((n, p) => n + p.widths.length, 0) ||
    b.score - a.score
  );
  out.forEach((g, i) => (g.id = prefix + String(i + 1).padStart(2, "0")));
  return out;
}

// 已接受／刻意設計的統計：N 個元素 × M 個寬度（共 K 條）
export function tallyByReason(records, cls) {
  const t = {};
  for (const r of records) for (const f of r.findings) {
    if (f.cls !== cls) continue;
    const e = (t[f.reason] ||= { els: new Set(), widths: new Set(), n: 0 });
    e.els.add([r.page, f.selector, f.text].join("|"));
    e.widths.add(r.width);
    e.n++;
  }
  return Object.fromEntries(Object.entries(t).map(([k, e]) => [k, { elements: e.els.size, widths: e.widths.size, count: e.n }]));
}

// 數字列表縮短：744、768、810… 共 N 個
export function fmtWidths(ws, max = 8) {
  const list = ws.slice(0, max).join("、");
  return ws.length > max ? `${list}…（共 ${ws.length} 個寬度）` : list;
}
export function fmtPages(pages, max = 4) {
  const names = pages.map((p) => p.page);
  return names.length > max ? `${names.slice(0, max).join("、")} 等 ${names.length} 頁` : names.join("、");
}
