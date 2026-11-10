/**
 * Browser E2E for the HD (screen-capture) path.
 *
 * `getDisplayMedia` cannot be driven headlessly, but the code under test only
 * ever consumes a MediaStream — so a canvas `captureStream()` painted with
 * known colours is a faithful stand-in. That exercises the real `captureHd`:
 * video element, decode wait, `videoWidth`, the `displaySurface === "browser"`
 * crop against `#persistent-player`, and `compose`.
 *
 * Covers:
 *   1. HD is attempted automatically when the dialog opens.
 *   2. The crop lands on the player, not the whole page.
 *   3. A dismissed prompt falls back to the server frame instead of hanging.
 *
 * Requires a dev server started with YT_UI_FIXTURE=1.
 *   LD_LIBRARY_PATH=/tmp/allibs/lib node tools/hd-capture-test.mjs
 */
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIDEO = "dQw4w9WgXcQ";

/** Painted into the fake shared surface so the crop can be located by colour. */
const SURFACE_W = 1280;
const SURFACE_H = 720;
const PLAYER_RGB = [220, 40, 90]; // inside #persistent-player
const PAGE_RGB = [10, 200, 120]; // everywhere else

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  }
}

/**
 * Replace getDisplayMedia with a canvas stream. The canvas is painted green
 * everywhere except the rectangle where #persistent-player sits, which is
 * painted pink — so a correct crop is ~entirely pink.
 */
async function installFakeDisplayMedia(page, { reject = false } = {}) {
  await page.evaluate(
    (w, h, playerRgb, pageRgb, shouldReject) => {
      const md = navigator.mediaDevices ?? {};
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, "mediaDevices", { value: md, configurable: true });
      }
      md.getDisplayMedia = async () => {
        if (shouldReject) {
          throw new DOMException("Permission denied", "NotAllowedError");
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = `rgb(${pageRgb.join(",")})`;
        ctx.fillRect(0, 0, w, h);

        const el = document.querySelector("#persistent-player");
        const r = el.getBoundingClientRect();
        const scale = w / window.innerWidth;
        ctx.fillStyle = `rgb(${playerRgb.join(",")})`;
        ctx.fillRect(r.left * scale, r.top * scale, r.width * scale, r.height * scale);

        // Keep painting so the track produces frames.
        setInterval(() => ctx.fillRect(r.left * scale, r.top * scale, 1, 1), 50);

        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        const original = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...original(),
          displaySurface: "browser",
          width: w,
          height: h,
        });
        return stream;
      };
    },
    SURFACE_W,
    SURFACE_H,
    PLAYER_RGB,
    PAGE_RGB,
    reject,
  );
}

/** Average colour of the centre of the rendered preview image. */
async function previewCentre(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('[role="dialog"] img');
    if (!img) return null;
    const probe = new Image();
    probe.src = img.src;
    await probe.decode();
    const c = document.createElement("canvas");
    c.width = probe.naturalWidth;
    c.height = probe.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(probe, 0, 0);
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { rgb: `${d[0]},${d[1]},${d[2]}`, w: probe.naturalWidth, h: probe.naturalHeight };
  });
}

async function openDialog(page) {
  await page.evaluate(() => {
    localStorage.setItem("yt:screenshot-hd-first", "1");
  });
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /screenshot|لقطة/i.test(b.getAttribute("title") ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("screenshot button not found");
  await page.waitForSelector('[role="dialog"] img', { timeout: 20000 });
  // let the busy overlay settle
  await new Promise((r) => setTimeout(r, 400));
}

const browser = await puppeteer.launch({
  args: [...chromium.args, "--no-sandbox"],
  executablePath: process.env.CHROME_PATH ?? (await chromium.executablePath()),
  headless: "shell",
  defaultViewport: { width: 1440, height: 900 },
});

try {
  // ---- 1. HD path succeeds and crops to the player -----------------------
  console.log("\nHD capture crops to the player");
  let page = await browser.newPage();
  await page.goto(`${BASE}/watch?v=${VIDEO}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#persistent-player", { timeout: 20000 });
  await installFakeDisplayMedia(page);
  await openDialog(page);

  const hd = await previewCentre(page);
  check("preview rendered", hd !== null, true);
  check("centre pixel is the player, not the page", hd?.rgb, PLAYER_RGB.join(","));

  const playerBox = await page.evaluate(() => {
    const r = document.querySelector("#persistent-player").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const scale = SURFACE_W / 1440;
  const expectedW = Math.round(playerBox.w * scale);
  // compose() caps upscaling at 2x and never downscales past the source.
  const within = hd && Math.abs(hd.w - Math.min(1280, expectedW * 2)) <= 4;
  check("output width tracks the player crop, not the 1280px surface", within, true);
  await page.close();

  // ---- 2. A dismissed prompt still produces an image ---------------------
  console.log("\ndismissed prompt falls back to the server frame");
  page = await browser.newPage();
  await page.goto(`${BASE}/watch?v=${VIDEO}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#persistent-player", { timeout: 20000 });
  await installFakeDisplayMedia(page, { reject: true });
  await openDialog(page);

  const fallback = await previewCentre(page);
  check("fallback preview rendered instead of an endless spinner", fallback !== null, true);
  check(
    "fallback is the fixture storyboard, not the fake surface",
    fallback?.rgb !== PLAYER_RGB.join(",") && fallback?.rgb !== PAGE_RGB.join(","),
    true,
  );

  const nagged = await page.evaluate(() => localStorage.getItem("yt:screenshot-hd-first"));
  check("prompt is not re-opened automatically next time", nagged, "0");
  await page.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
