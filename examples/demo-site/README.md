# Demo page／示範頁

[← README](../../README.md)

## 繁體中文

一個假的商店頁，用來試跑 tablet-qa，也是 README 範例對比圖的來源。

- `before/`：平板寬度（744–1023px）時商品卡片是單欄；搜尋按鈕 32px（小於 44px）；促銷列固定 880px 寬，比 iPad 直向寬，標籤文字也被切掉。
- `after/`：744px 起三欄，搜尋按鈕 44px，促銷列跟著畫面寬度換行。

最簡單的試法：在 Claude Code 或 Codex 裡說「用 tablet-qa 的 `examples/demo-site` 試跑一次」，讓它處理下面的步驟。

自己跑的話：

1. 需要 Python 3。在這個資料夾起一個靜態伺服器，這個終端機分頁要一直開著：

   ```bash
   python3 -m http.server 4810 --bind 127.0.0.1
   ```

2. 另開一個終端機分頁，從**裝了 Playwright 的專案資料夾**執行（腳本會從目前資料夾往上找 Playwright；也可以在 `tablet-qa.json` 加 `"playwrightFrom": "<那個專案的路徑>"`）：

   ```bash
   node ~/.claude/skills/tablet-qa/scripts/shots.mjs ~/.claude/skills/tablet-qa/examples/demo-site/tablet-qa.json --site=both --run=demo-shots
   ```

結果在 `examples/demo-site/tablet-qa-runs/`（已在 `.gitignore`）。設定與參數見[完整說明](../../docs/guide.zh-Hant.md)。

## English

A fake store page for trying tablet-qa. It is also where the README's example comparison image comes from.

- `before/`: at tablet widths (744–1023px) the product cards are a single column; the search button is 32px (below 44px); the promo bar is a fixed 880px wide, wider than an iPad in portrait, and its tag text is cut off.
- `after/`: three columns from 744px, a 44px search button, and a promo bar that wraps to fit.

Easiest way: in Claude Code or Codex, say "Do a test run of tablet-qa on `examples/demo-site`" and let it handle the steps below.

To run it yourself:

1. You need Python 3. Start a static server in this folder and keep this terminal tab open:

   ```bash
   python3 -m http.server 4810 --bind 127.0.0.1
   ```

2. In a second terminal tab, run from **a project folder that has Playwright installed** (the scripts look for Playwright from the current folder upward; or add `"playwrightFrom": "<path to that project>"` to `tablet-qa.json`):

   ```bash
   node ~/.claude/skills/tablet-qa/scripts/shots.mjs ~/.claude/skills/tablet-qa/examples/demo-site/tablet-qa.json --site=both --run=demo-shots
   ```

Results go to `examples/demo-site/tablet-qa-runs/` (already in `.gitignore`). For config and options, see the [full guide](../../docs/guide.en.md).
