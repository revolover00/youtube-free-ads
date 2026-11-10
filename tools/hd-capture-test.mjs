/**
 * Browser E2E for the HD (screen-capture) path.
 *
 * `getDisplayMedia` cannot be driven in this environment — the headless shell
 * has no surface to capture and answers `NotReadableError`. The previous
 * version of this test stubbed it with a canvas it painted itself, which is
 * how a real defect shipped: the capture photographs the *live page*, and this
 * dialog is a full-viewport `bg-black/60` scrim with a panel in the middle of
 * it sitting right on top of the player. A hand-painted surface can never show
 * that, so the test passed while users got a dimmed frame with the dialog in
 * the shot.
 *
 * So the surface here is a real render of the real page: the stub asks
 * Puppeteer for an actual screenshot at the exact moment `captureHd` opens the
 * surface, and hands those pixels back as the MediaStream. Everything after
 * that point is the untouched production path — video element, presentation
 * wait, `videoWidth`, the `displaySurface === "browser"` crop against
 * `#persistent-player`, and `compose`.
 *
 * Covers:
 *   1. HD is attempted automatically when the dialog opens.
 *   2. The dialog is out of its own photograph (the regression that shipped).
 *   3. The crop lands on the player, not the whole page.
 *   4. The dialog comes back afterwards, on both the happy and refused paths.
 *   5. A dismissed prompt falls back to the server frame instead of hanging.
 *
 * Requires a dev server started with YT_UI_FIXTURE=1.
 *   LD_LIBRARY_PATH=/tmp/allibs/lib node tools/hd-capture-test.mjs
 */
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIDEO = "dQw4w9WgXcQ";
const HD_KEY = "yt:screenshot-hd-first-v2";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
/** Painted into the real player box so the crop can be identified by colour. */
const PLAYER_RGB = [0, 200, 255];
/** What PLAYER_RGB turns into under this dialog's own bg-black/60 scrim. */
const SCRIMMED_RGB = PLAYER_RGB.map((c) => Math.round(c * 0.4));

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

const near = (rgb, target, tol = 14) =>
  !!rgb && rgb.every((c, i) => Math.abs(c - target[i]) <= tol);

/**
 * Give the player an unmistakable colour. The fixture player is a black box
 * behind an iframe that cannot load offline, and black under a 60% black scrim
 * is still black — there would be nothing to measure.
 */
async function markPlayer(page) {
  // Through a stylesheet, not element.style: React owns that element's inline
  // style and re-applies it on the very next render, which silently undoes a
  // direct mutation.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #persistent-player::after {
        content: "";
        position: absolute;
        inset: 0;
        background: rgb(0,200,255);
        z-index: 9999;
      }
    `;
    document.head.appendChild(style);
  });
}

/**
 * Replace getDisplayMedia with a stream of genuine screenshots of this page,
 * taken when the production code opens the surface.
 */
async function installPageSurface(page, { reject = false } = {}) {
  await page.exposeFunction("__surfacePng", async () => {
    if (reject) return null;
    return page.screenshot({ encoding: "base64", optimizeForSpeed: true });
  });

  await page.evaluate((shouldReject) => {
    const md = navigator.mediaDevices ?? {};
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", { value: md, configurable: true });
    }

    window.__overlayAtCapture = "never-called";

    md.getDisplayMedia = async () => {
      // Recorded from the live DOM at the instant the surface is opened —
      // this is the invariant the shipped bug violated.
      const overlay = document.querySelector("[data-screenshot-overlay]");
      window.__overlayAtCapture = overlay ? getComputedStyle(overlay).visibility : "absent";

      if (shouldReject) throw new DOMException("Permission denied", "NotAllowedError");

      const b64 = await window.__surfacePng();
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      // Keep the track producing frames without disturbing the pixels.
      setInterval(() => ctx.drawImage(img, 0, 0), 50);

      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0];
      const original = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...original(),
        displaySurface: "browser",
        width: canvas.width,
        height: canvas.height,
      });
      return stream;
    };
  }, reject);
}

/** Centre pixel and size of the rendered preview image. */
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
    const at = (fx, fy) => {
      const d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    // Centre: where the dialog *panel* would land. Corner: inside the player
    // but clear of the panel, so it sees the bare scrim. The two failure
    // modes are different pixels and need separate probes.
    return {
      rgb: at(0.5, 0.5),
      corner: at(0.06, 0.06),
      w: probe.naturalWidth,
      h: probe.naturalHeight,
    };
  });
}

async function openDialog(page, key) {
  await page.evaluate((k) => localStorage.setItem(k, "1"), key);
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
  await new Promise((r) => setTimeout(r, 400));
}

async function newWatchPage() {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`${BASE}/watch?v=${VIDEO}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#persistent-player", { timeout: 20000 });
  return page;
}

const browser = await puppeteer.launch({
  args: [...chromium.args, "--no-sandbox"],
  executablePath: process.env.CHROME_PATH ?? (await chromium.executablePath()),
  headless: "shell",
  defaultViewport: VIEWPORT,
});

try {
  // ---- 1. The dialog is not in its own screenshot ------------------------
  console.log("\nHD capture photographs the player, not the dialog");
  let page = await newWatchPage();
  await markPlayer(page);
  await installPageSurface(page);
  await openDialog(page, HD_KEY);

  const hd = await previewCentre(page);
  check("preview rendered", hd !== null, true);
  check(`centre pixel is the undimmed player (${PLAYER_RGB})`, near(hd?.rgb, PLAYER_RGB), true);
  check(
    "centre pixel is not the dialog panel sitting in the shot",
    near(hd?.rgb, PLAYER_RGB),
    true,
  );
  check(
    `off-centre pixel is not the player seen through the dialog scrim (${SCRIMMED_RGB})`,
    near(hd?.corner, SCRIMMED_RGB),
    false,
  );
  check("off-centre pixel is the undimmed player too", near(hd?.corner, PLAYER_RGB), true);
  check(
    "dialog was hidden at the moment the surface was opened",
    await page.evaluate(() => window.__overlayAtCapture),
    "hidden",
  );
  check(
    "dialog is visible again once the frame is in hand",
    await page.evaluate(() => {
      const el = document.querySelector("[data-screenshot-overlay]");
      return el ? getComputedStyle(el).visibility : "absent";
    }),
    "visible",
  );

  const playerBox = await page.evaluate(() => {
    const r = document.querySelector("#persistent-player").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const expectedW = Math.round(playerBox.w * VIEWPORT.deviceScaleFactor);
  // compose() caps upscaling at 2x and never downscales a larger source.
  const target = expectedW >= 1280 ? expectedW : Math.min(1280, expectedW * 2);
  check(
    "output width tracks the player crop, not the whole surface",
    hd && Math.abs(hd.w - target) <= 4,
    true,
  );
  await page.close();

  // ---- 2. A dismissed prompt still produces an image ---------------------
  console.log("\ndismissed prompt falls back to the server frame");
  page = await newWatchPage();
  await markPlayer(page);
  await installPageSurface(page, { reject: true });
  await openDialog(page, HD_KEY);

  const fallback = await previewCentre(page);
  check("fallback preview rendered instead of an endless spinner", fallback !== null, true);
  check(
    "fallback is the fixture storyboard, not the page surface",
    !near(fallback?.rgb, PLAYER_RGB) && !near(fallback?.corner, PLAYER_RGB),
    true,
  );
  check(
    "dialog is restored after a refusal, not left invisible",
    await page.evaluate(() => {
      const el = document.querySelector("[data-screenshot-overlay]");
      return el ? getComputedStyle(el).visibility : "absent";
    }),
    "visible",
  );
  check(
    "prompt is not re-opened automatically next time",
    await page.evaluate((k) => localStorage.getItem(k), HD_KEY),
    "0",
  );
  await page.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
