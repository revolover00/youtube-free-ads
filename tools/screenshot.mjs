import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Always repo-root/.tmp-shots, whatever directory this is invoked from.
const OUT = fileURLToPath(new URL("../.tmp-shots/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const pages = [
  ["home", "http://127.0.0.1:3000/", 1440, 1400],
  ["home-wide", "http://127.0.0.1:3000/", 1920, 1100],
  ["watch", "http://127.0.0.1:3000/watch?v=dQw4w9WgXcQ", 1440, 1500],
  ["results", "http://127.0.0.1:3000/results?search_query=music", 1440, 1200],
  ["mobile", "http://127.0.0.1:3000/", 390, 844],
];

const browser = await puppeteer.launch({
  executablePath: "/tmp/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--single-process",
    "--hide-scrollbars",
    "--font-render-hinting=none",
  ],
});

for (const [name, url, w, h] of pages) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  await new Promise((r) => setTimeout(r, 5000));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
  await page.close();
}
await browser.close();
console.log("DONE");
