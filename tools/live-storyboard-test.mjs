/**
 * Live-capture regression for the storyboard addresser.
 *
 * Unlike tools/storyboard-test.mjs (synthetic edge cases), this drives the real
 * shipped parser with a spec string captured verbatim from YouTube over the
 * network, and asserts it reconstructs the exact sheet URLs that the i.ytimg.com
 * CDN was observed to answer with `200 image/webp`.
 *
 * Observed on the wire (HEAD, from a datacentre IP):
 *   …/storyboard3_L3/M0.jpg?sqp=…&sigh=rs$AOn4CLCH…  → 200 image/webp 21228 B
 *   …/storyboard3_L3/M11.jpg?sqp=…&sigh=rs$AOn4CLCH… → 200 image/webp 13536 B
 *   …/storyboard3_L3/M0.jpg?sqp=…  (no &sigh)        → 403  ← signature is mandatory
 *
 * Run: node tools/live-storyboard-test.mjs
 */
import { parseStoryboardSpec, addressFrame } from "../src/lib/storyboard.ts";

/** Captured from `playerStoryboardSpecRenderer.spec` for dQw4w9WgXcQ (213 s). */
const LIVE_SPEC =
  "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=-oaymwENSDfyq4qpAwVwAcABBqLzl_8DBgjXxPfBBg==" +
  "|48#27#100#10#10#0#default#rs$AOn4CLDgtWGAnaqZZSEHsiFathAqjUlfLQ" +
  "|80#45#108#10#10#2000#M$M#rs$AOn4CLBf8GkpJjLT0oNOXNqGg2XsF5MCMg" +
  "|160#90#108#5#5#2000#M$M#rs$AOn4CLClA1jTU48sHENDTij_c2ZcE493TQ" +
  "|320#180#108#3#3#2000#M$M#rs$AOn4CLCHZGerbRu0IiBb-AIyubx5_-E4oQ";

const DURATION = 213;
const SQP = "sqp=-oaymwENSDfyq4qpAwVwAcABBqLzl_8DBgjXxPfBBg==";
const SIGH_L3 = "sigh=rs$AOn4CLCHZGerbRu0IiBb-AIyubx5_-E4oQ";
const BASE_L3 = "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L3";

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  FAIL ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
    return;
  }
  console.log(`  ok   ${label}`);
}

console.log("\nlive spec → levels");
const levels = parseStoryboardSpec(LIVE_SPEC);
check("level count", levels.length, 4);

const top = levels[levels.length - 1];
check("top level width", top.width, 320);
check("top level height", top.height, 180);
check("top level frameCount", top.frameCount, 108);
check("top level cols", top.cols, 3);
check("top level rows", top.rows, 3);
check("top level intervalMs", top.intervalMs, 2000);
check("top level url resolves $L to 3", top.url.includes("/storyboard3_L3/"), true);
check("top level url keeps $M for the sheet", top.url.includes("$M"), true);
check("top level url keeps sqp", top.url.includes(SQP), true);
check("top level url appends sigh with &", top.url.includes(`&${SIGH_L3}`), true);

// Level 0 is the single "default" sheet with no frame interval.
check("level 0 name is default", levels[0].url.includes("/storyboard3_L0/default.jpg"), true);
check("level 0 intervalMs", levels[0].intervalMs, 0);

console.log("\nframe addressing (interval-driven)");

const t0 = addressFrame(top, 0, DURATION);
check("t=0 url", t0.url, `${BASE_L3}/M0.jpg?${SQP}&${SIGH_L3}`);
check("t=0 x", t0.x, 0);
check("t=0 y", t0.y, 0);
check("t=0 at", t0.at, 0);

// 100 s / 2 s = frame 50 → sheet 5 (9 per sheet), tile 5 → col 2, row 1.
const t100 = addressFrame(top, 100, DURATION);
check("t=100 url", t100.url, `${BASE_L3}/M5.jpg?${SQP}&${SIGH_L3}`);
check("t=100 x", t100.x, 640);
check("t=100 y", t100.y, 180);
check("t=100 at", t100.at, 100);

// End of video: 213 s / 2 s = frame 106 → sheet 11, tile 7 → col 1, row 2.
const tEnd = addressFrame(top, DURATION, DURATION);
check("t=213 url", tEnd.url, `${BASE_L3}/M11.jpg?${SQP}&${SIGH_L3}`);
check("t=213 x", tEnd.x, 320);
check("t=213 y", tEnd.y, 360);

// Past the end clamps to the final frame rather than addressing a missing sheet.
const tOver = addressFrame(top, 99999, DURATION);
check("t=99999 clamps to last sheet", tOver.url, `${BASE_L3}/M11.jpg?${SQP}&${SIGH_L3}`);
check("t=99999 clamps to frame 107", tOver.at, 214);

console.log("\nno placeholders survive into a fetchable URL");
for (const [label, addr] of [
  ["t=0", t0],
  ["t=100", t100],
  ["t=213", tEnd],
]) {
  check(`${label} has no $L/$N/$M`, /\$[LNM]/.test(addr.url), false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
