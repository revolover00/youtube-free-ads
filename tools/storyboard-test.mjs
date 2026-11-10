/**
 * Asserts the storyboard maths in src/lib/storyboard.ts against a real
 * YouTube spec string. Run: node tools/storyboard-test.mjs
 *
 * This path cannot be exercised from a sandbox that has no route to
 * i.ytimg.com, so the addressing is verified here instead of in a browser.
 */
import { parseStoryboardSpec, addressFrame } from "../src/lib/storyboard.ts";

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `  got ${got}, expected ${want}`}`);
};

// Shape of a genuine playerStoryboardSpecRenderer.spec: a base URL carrying
// $L/$N placeholders, then one entry per quality level.
const SPEC =
  "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=-oaymwENSDfyq4qpAwVwAcABBg==" +
  "|48#27#100#10#10#0#default#rs$AOn4CLDvQnqM6yHWTzjFtDYWNlTnJQl1Xw" +
  "|80#45#144#5#5#1000#M$M#rs$AOn4CLABaK1rVr1OzO3LBPu8WSNfTnKnLA" +
  "|160#90#144#5#5#1000#M$M#rs$AOn4CLC9FUqIjmIZDYgYQRvwBJLgEHpQvQ" +
  "|320#180#144#3#3#1000#M$M#rs$AOn4CLAVxLPLdTtLfLTGBTNxYpBnBIOCVQ";

const levels = parseStoryboardSpec(SPEC);

console.log("— parsing —");
check("level count", levels.length, 4);
const top = levels.at(-1);
check("top level size", `${top.width}x${top.height}`, "320x180");
check("top level sheet grid", `${top.cols}x${top.rows}`, "3x3");
check("top level interval", top.intervalMs, 1000);
check("top level frame count", top.frameCount, 144);
check("$L resolved to level index", top.url.includes("storyboard3_L3/"), true);
check("$N resolved to name", top.url.includes("/M$M.jpg"), true);
check("sigh appended to existing query", top.url.includes("&sigh=rs$AOn4CLAVx"), true);
check("$M left for the sheet index", top.url.includes("$M"), true);
check("level 0 uses the default name", levels[0].url.includes("/default.jpg"), true);
check("level 0 has no interval", levels[0].intervalMs, 0);

console.log("\n— addressing (interval driven) —");
const a0 = addressFrame(top, 0, 144);
check("t=0 tile origin", `${a0.x},${a0.y}`, "0,0");
check("t=0 sheet", a0.url.includes("/M0.jpg"), true);

const a10 = addressFrame(top, 10, 144);
check("t=10 sheet is M1", a10.url.includes("/M1.jpg"), true);
check("t=10 tile origin", `${a10.x},${a10.y}`, "320,0");
check("t=10 reported time", a10.at, 10);

const a4 = addressFrame(top, 4, 144);
check("t=4 stays on M0", a4.url.includes("/M0.jpg"), true);
check("t=4 wraps to row 2", `${a4.x},${a4.y}`, "320,180");

const aEnd = addressFrame(top, 99999, 144);
check("far past the end clamps", aEnd.at, 143);
check("last tile lands on M15", aEnd.url.includes("/M15.jpg"), true);
check("no placeholders survive", /\$[LNM](?![A-Za-z0-9])/.test(aEnd.url.split("sigh=")[0]), false);

console.log("\n— addressing (duration driven, level 0 has no interval) —");
const l0 = levels[0];
check("midpoint of a 200s video", addressFrame(l0, 100, 200).x / l0.width, 0);
check("midpoint lands on row 5", addressFrame(l0, 100, 200).y / l0.height, 5);
check("zero duration is survivable", addressFrame(l0, 50, 0).at, 50);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
