/**
 * End-to-end check of the frame-capture feature, driven through a real
 * browser. Requires the dev server running with fixtures:
 *
 *   YT_UI_FIXTURE=1 npm run dev
 *   LD_LIBRARY_PATH=/tmp/allibs/lib node tools/capture-test.mjs
 *
 * With YT_UI_FIXTURE the server serves a synthetic 5x5 storyboard whose tiles
 * are flat, unique colours, so the captured image's centre pixel identifies
 * exactly which tile was cropped. That turns "did it grab the right frame?"
 * into an assertion instead of a judgement call - the real sheets on
 * i.ytimg.com are unreachable from the sandbox.
 */
import puppeteer from "puppeteer-core";

// Must match fixtures.ts tileColor()
const tile = (n) => [40 + ((n * 37) % 200), 30 + ((n * 91) % 200), 50 + ((n * 53) % 190)].join(",");
const DURATION = 1123,
  FRAMES = 25;
const expectedTile = (t) => Math.min(FRAMES - 1, Math.floor((t / DURATION) * FRAMES));

const browser = await puppeteer.launch({
  executablePath: "/tmp/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--single-process",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto("http://127.0.0.1:3000/watch?v=dQw4w9WgXcQ", {
  waitUntil: "networkidle2",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 6000));

async function captureAt(seconds) {
  // Simulate the YouTube iframe reporting playback progress.
  await page.evaluate((t) => {
    window.postMessage(
      JSON.stringify({ event: "infoDelivery", info: { currentTime: t, playerState: 1 } }),
      "*",
    );
  }, seconds);
  await new Promise((r) => setTimeout(r, 1200));

  // close any open dialog first
  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((b) => {
      if ((b.getAttribute("aria-label") || "").match(/close|إغلاق/i)) b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 400));

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      /screenshot|لقطة/i.test(x.textContent || ""),
    );
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) return { error: "no button" };
  await new Promise((r) => setTimeout(r, 3000));

  return await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")].filter((i) =>
      i.src.startsWith("data:image/png"),
    );
    if (!imgs.length) return { error: "no capture image" };
    const img = imgs[imgs.length - 1];
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const p = c
      .getContext("2d")
      .getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    const label = [...document.querySelectorAll("*")]
      .map((e) => e.textContent)
      .filter(Boolean)
      .pop();
    return { centre: [p[0], p[1], p[2]].join(","), w: img.naturalWidth, h: img.naturalHeight };
  });
}

let pass = 0,
  fail = 0;
for (const t of [0, 300, 600, 1000]) {
  const got = await captureAt(t);
  const want = tile(expectedTile(t));
  const ok = got.centre === want;
  ok ? pass++ : fail++;
  console.log(
    `t=${String(t).padStart(4)}s  expect tile ${String(expectedTile(t)).padStart(2)} (${want.padEnd(12)})  got ${String(got.centre).padEnd(12)}  ${ok ? "PASS" : "FAIL"}`,
  );
}
console.log(`\n${pass} passed, ${fail} failed`);

// The store now notifies on every whole second of playback, which re-renders
// the tree that owns the player. Guard against that rebuilding the iframe
// src or remounting the node, which would restart the video once a second.
await page.evaluate(() => {
  const f = document.querySelector("#persistent-player iframe") || document.querySelector("iframe");
  if (f) f.dataset.probe = "original";
});
const before = await page.evaluate(() => {
  const f = document.querySelector("#persistent-player iframe") || document.querySelector("iframe");
  return { src: f?.src, probe: f?.dataset.probe };
});
for (let i = 0; i <= 48; i++) {
  await page.evaluate((t) => {
    window.postMessage(
      JSON.stringify({ event: "infoDelivery", info: { currentTime: t, playerState: 1 } }),
      "*",
    );
  }, i * 0.25);
  await new Promise((r) => setTimeout(r, 25));
}
await new Promise((r) => setTimeout(r, 1500));
const after = await page.evaluate(() => {
  const f = document.querySelector("#persistent-player iframe") || document.querySelector("iframe");
  return { src: f?.src, probe: f?.dataset.probe };
});
console.log("iframe src unchanged :", before.src === after.src ? "PASS" : "FAIL");
console.log("iframe not remounted :", after.probe === "original" ? "PASS" : "FAIL");

await browser.close();
