// Draws the "tests" badge in the same style as docs/badge-*.svg.
//   node .github/make-badge.mjs passing|failing > badge-tests.svg
const state = process.argv[2] === "passing" ? "passing" : "failing";
const value = state === "passing" ? { text: "passing", color: "#7ee2a8" } : { text: "failing", color: "#ff8a80" };
const L = 40; // label width, same as the node badge
const R = state === "passing" ? 54 : 48;
const W = L + R;
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" viewBox="0 0 ${W} 20" role="img" aria-label="tests: ${value.text}">
  <title>tests: ${value.text}</title>
  <rect x="0.5" y="0.5" width="${W - 1}" height="19" rx="3.5" fill="#0e0f10" stroke="#2c3035"/>
  <line x1="${L}" y1="4" x2="${L}" y2="16" stroke="#2c3035"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle">
    <text x="${L / 2}" y="14" fill="#9aa0a6">tests</text>
    <text x="${L + R / 2}" y="14" fill="${value.color}">${value.text}</text>
  </g>
</svg>
`);
