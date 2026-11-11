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
const HD_OK_KEY = "yt:screenshot-hd-ok";

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

/**
 * Wait for a capture to finish rather than sleeping a guessed interval: in
 * this harness every frame costs a CDP screenshot round-trip, so a capture
 * that is instant in a real browser takes seconds here.
 */
async function settle(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const overlay = document.querySelector("[data-screenshot-overlay]");
      return {
        hasImage: !!dialog?.querySelector("img"),
        spinning: !!dialog?.querySelector(".animate-spin"),
        visible: overlay ? getComputedStyle(overlay).visibility === "visible" : false,
        offering: [...(dialog?.querySelectorAll("button") ?? [])].some((b) =>
          /capture the real frame|التقط الإطار الحقيقي/i.test(b.textContent ?? ""),
        ),
        // A device with no screen capture can reach neither of those: it rests
        // on an explanation plus the opt-in to view the cover image.
        explaining: [...(dialog?.querySelectorAll("button") ?? [])].some((b) =>
          /show the cover image instead|اعرض صورة الغلاف بدل كده/i.test(b.textContent ?? ""),
        ),
      };
    });
    // Three legitimate resting states: an image is ready; the dialog is
    // holding nothing but the offer to capture; or capture is impossible here
    // and it is saying so.
    if (
      state.visible &&
      !state.spinning &&
      (state.hasImage || state.offering || state.explaining)
    ) {
      return;
    }
    if (Date.now() > deadline) throw new Error(`capture never settled: ${JSON.stringify(state)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openDialog(page, { proven }) {
  await page.evaluate(
    (k, isProven) => (isProven ? localStorage.setItem(k, "1") : localStorage.removeItem(k)),
    "yt:screenshot-hd-ok",
    proven,
  );
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /screenshot|لقطة/i.test(b.getAttribute("title") ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("screenshot button not found");
  // A first visit on a capable browser deliberately shows no image at all --
  // offering the real capture instead of leading with a 160x90 approximation --
  // so wait for the dialog, then for whichever of the two states it settles in.
  await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return false;
      if (dlg.querySelector("img")) return true;
      return [...dlg.querySelectorAll("button")].some((b) =>
        /capture the real frame|التقط الإطار الحقيقي|show the cover image instead|اعرض صورة الغلاف بدل كده/i.test(
          b.textContent ?? "",
        ),
      );
    },
    { timeout: 20000 },
  );
  await settle(page);
}

/** The opt-in rough preview, used by scenarios that need the server path. */
async function clickQuickPreview(page) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      /rough preview instead|معاينة تقريبية بدل كده/i.test(b.textContent ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error("rough preview button not found");
  await settle(page);
}

/** The explained one-click path shown whenever the image is not a real grab. */
async function clickCaptureCta(page) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      /capture the real frame|التقط الإطار الحقيقي/i.test(b.textContent ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error("capture CTA not found");
  await settle(page);
}

const ctaPresent = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] button')].some((b) =>
      /capture the real frame|التقط الإطار الحقيقي/i.test(b.textContent ?? ""),
    ),
  );

async function newWatchPage(videoId = VIDEO, { noScreenCapture = false } = {}) {
  const page = await browser.newPage();
  if (noScreenCapture) {
    // Every mobile browser is this: mediaDevices exists, getDisplayMedia does
    // not. It has to be gone before the app's first render reads it.
    await page.evaluateOnNewDocument(() => {
      // getDisplayMedia lives on MediaDevices.prototype, so deleting it off
      // the instance is a no-op; shadow it with an own undefined instead.
      const md = navigator.mediaDevices;
      if (md) {
        Object.defineProperty(md, "getDisplayMedia", { value: undefined, configurable: true });
      }
    });
  }
  page.on("pageerror", (e) => console.error(`  [page error] ${e.message}`));
  page.on("console", (m) => {
    // Offline fixtures cannot load thumbnails or the YouTube embed; that noise
    // is expected and would bury a real error.
    const text = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(text)) {
      console.error(`  [console] ${text.slice(0, 200)}`);
    }
  });
  await page.setViewport(VIEWPORT);
  await page.goto(`${BASE}/watch?v=${videoId}`, { waitUntil: "networkidle2", timeout: 60000 });
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
  await openDialog(page, { proven: true });

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
  await openDialog(page, { proven: true });

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
    "the refusal is explained rather than silently swallowed",
    await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"]');
      return /cancelled|أُلغيت|تم إلغاء/i.test(el?.textContent ?? "");
    }),
    true,
  );
  check("the one-click retry is still offered after a refusal", await ctaPresent(page), true);
  await page.close();

  // ---- 3. A first-time browser is never prompted unannounced -------------
  console.log("\nfirst visit explains itself instead of ambushing the user");
  page = await newWatchPage();
  await markPlayer(page);
  await installPageSurface(page);
  await openDialog(page, { proven: false });

  check(
    "no share prompt is opened on its own the first time",
    await page.evaluate(() => window.__overlayAtCapture),
    "never-called",
  );
  check("the explained capture button is offered instead", await ctaPresent(page), true);
  check(
    "nothing is remembered before it has ever worked",
    await page.evaluate((k) => localStorage.getItem(k), HD_OK_KEY),
    null,
  );
  // The whole point of the change: a 160x90 storyboard tile from a 2-10s grid
  // must not be presented as the answer before the real frame is even offered.
  check(
    "no approximation is shown as though it were the screenshot",
    await page.evaluate(() => !document.querySelector('[role="dialog"] img')),
    true,
  );
  check(
    "the rough preview is still reachable for anyone who wants it",
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] button')].some((b) =>
        /rough preview instead|معاينة تقريبية بدل كده/i.test(b.textContent ?? ""),
      ),
    ),
    true,
  );

  await clickCaptureCta(page);
  const viaCta = await previewCentre(page);
  check("the button produces a real capture", near(viaCta?.rgb, PLAYER_RGB), true);
  check(
    "the dialog stayed out of that shot too",
    await page.evaluate(() => window.__overlayAtCapture),
    "hidden",
  );
  check(
    "a working capture is remembered, so later opens go straight through",
    await page.evaluate((k) => localStorage.getItem(k), HD_OK_KEY),
    "1",
  );
  check("the prompt offer disappears once the image is a real grab", await ctaPresent(page), false);
  await page.close();

  // ---- 4. A cover image is never passed off as the captured frame --------
  // YouTube closed the session loophole that briefly made server-side
  // storyboards work, so "no storyboard available" is now the normal answer.
  // What must never happen again is the poster being handed over as if it
  // were the moment the user is paused on.
  console.log("\nan unavailable moment is admitted, not papered over with the poster");
  page = await newWatchPage("poster-fixture");
  await markPlayer(page);
  await installPageSurface(page);
  await openDialog(page, { proven: false });
  await clickQuickPreview(page);

  check(
    "the cover image is not displayed as the capture",
    await page.evaluate(() => !document.querySelector('[role="dialog"] img')),
    true,
  );
  check(
    "the reason is stated in the user's own language",
    await page.evaluate(() =>
      /cover image|صورة الغلاف/i.test(document.querySelector('[role="dialog"]')?.innerText ?? ""),
    ),
    true,
  );
  check(
    "nothing copyable or savable is offered for an image that is not there",
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => /copy|save|download|نسخ|حفظ|تنزيل/i.test(b.textContent ?? ""))
        .every((b) => b.disabled),
    ),
    true,
  );
  check("the real capture is still offered as the way out", await ctaPresent(page), true);
  await page.close();

  // ---- 5. A phone, where screen capture does not exist at all -----------
  // The previous round withheld the poster only where screen capture could
  // replace it, so phones kept being handed a cover image as "your frame".
  // Nothing true is reachable here, and that has to be said rather than
  // covered up with the wrong picture.
  console.log("\na phone is told the truth instead of being handed the cover image");
  page = await newWatchPage("poster-fixture", { noScreenCapture: true });
  await markPlayer(page);
  await openDialog(page, { proven: true });
  await settle(page);

  const phoneText = () =>
    page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");

  check(
    "the cover image is not shown on a phone either",
    await page.evaluate(() => !document.querySelector('[role="dialog"] img')),
    true,
  );
  check(
    "the phone is told why, and where it can be done",
    /computer|كمبيوتر/i.test(await phoneText()),
    true,
  );
  check(
    "no screen-capture button is dangled at a device that cannot do it",
    await ctaPresent(page),
    false,
  );

  // The dialog pasted back by the user ended on "captured from the moment you
  // are watching", sitting directly under the sentence saying that moment is
  // unreachable. A dialog must not contradict itself in its own footer.
  check(
    "the dialog does not re-promise the moment it just said it cannot reach",
    /captured from the moment you are watching|اللقطة من اللحظة التي تشاهدها الآن/i.test(
      await phoneText(),
    ),
    false,
  );
  check(
    "a phone can try again, since every attempt is a fresh session",
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] button')].some((b) =>
        /try again|حاول تاني/i.test(b.textContent ?? ""),
      ),
    ),
    true,
  );

  const revealed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      /show the cover image instead|اعرض صورة الغلاف بدل كده/i.test(b.textContent ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("the cover image is still reachable on purpose", revealed, true);
  await settle(page);
  check(
    "once asked for, it appears and is labelled as the cover image",
    await page.evaluate(
      () =>
        !!document.querySelector('[role="dialog"] img') &&
        /غلاف|cover/i.test(document.querySelector('[role="dialog"]')?.innerText ?? ""),
    ),
    true,
  );
  await page.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
