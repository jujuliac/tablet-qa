# Demo page／示範頁

A fake store page for trying tablet-qa and for making the example image in the main README.
一個假的商店頁，用來試跑 tablet-qa、產生主 README 的範例對比圖。

- `before/`: at tablet widths (744–1023px) the product cards are a single column, and the search button is 32px (below 44px).
  平板寬度（744–1023px）時商品卡片是單欄，搜尋按鈕 32px（小於 44px）。
- `after/`: three columns from 744px, and a 44px search button.
  744px 起三欄，搜尋按鈕 44px。

Start any static server in this folder／在這個資料夾起一個靜態伺服器：

```bash
python3 -m http.server 4810
```

Then run (Playwright must be findable; see the main README)／再跑（要找得到 Playwright，見主 README）：

```bash
node ../../scripts/shots.mjs tablet-qa.json --site=both --run=demo-shots
node ../../scripts/sweep.mjs tablet-qa.json --site=both --run=demo-sweep
```

Results go to `tablet-qa-runs/` (already in `.gitignore`)／結果在 `tablet-qa-runs/`（已在 `.gitignore`）。
