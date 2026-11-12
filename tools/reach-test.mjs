/**
 * What the player does on a network that blocks YouTube.
 *
 * The sandbox cannot reach YouTube at all, which is the wrong kind of
 * blocked: everything fails, so nothing is distinguishable. So the network is
 * simulated precisely instead -- `fetch` is shadowed before the app's first
 * script runs, and each host is told to resolve or to reject exactly as a
 * filter would. That makes the four cases separable:
 *
 *   1. nothing blocked        -> stay on youtube.com, say nothing
 *   2. youtube.com blocked    -> move to youtube-nocookie.com and play
 *   3. both embed hosts gone  -> name the block, give the DNS fix, offer a retry
 *   4. this origin unreachable-> conclude nothing; the network is simply down
 *
 * Run with the dev server up:
 *   YT_UI_FIXTURE=1 npm run dev -- --host 0.0.0.0 --port 3000
 *   BASE_URL=http://127.0.0.1:3000 LD_LIBRARY_PATH=/tmp/allibs/lib node tools/reach-test.mjs
 */

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIDEO = "dQw4w9WgXcQ";
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok)
    console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * @param blocked hostname fragments this simulated network refuses.
 * Rejecting is what a DNS failure or a dropped handshake looks like to
 * `fetch`; everything else is delegated to the real one so the app keeps
 * working.
 */
async function newPage(blocked, { piped = null } = {}) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (list, pipedHost) => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* fine */
      }
      // Each mirror attempt is transient by design -- an unplayable source is
      // replaced within milliseconds -- so attempts are recorded as they
      // happen rather than caught by polling afterwards.
      window.__mirrorTries = [];
      const watch = () => {
        for (const v of document.querySelectorAll("[data-mirror-player]")) {
          const src = v.getAttribute("src");
          const instance = v.getAttribute("data-mirror-instance");
          if (src && !window.__mirrorTries.some((t) => t.src === src)) {
            window.__mirrorTries.push({ src, instance });
          }
        }
        if (document.querySelector("[data-mirror-searching]")) window.__searched = true;
      };
      new MutationObserver(watch).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      const real = window.fetch.bind(window);
      // This sandbox genuinely cannot reach any YouTube host, so "not
      // stubbed" would mean "blocked" and the open-network case could not
      // exist. Every YouTube request is therefore answered by the
      // simulation, and only the app's own same-origin traffic reaches the
      // real fetch.
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        if (pipedHost && url.includes(pipedHost)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                videoStreams: [
                  { url: "https://proxy.example/high", videoOnly: true, itag: 137 },
                  {
                    url: "https://proxy.example/muxed360",
                    videoOnly: false,
                    itag: 18,
                    quality: "360p",
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (list.some((h) => url.includes(h))) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (/youtube\.com|youtube-nocookie\.com|i\.ytimg\.com|pipedapi|piped\.yt/.test(url)) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return real(input, init);
      };
    },
    blocked,
    piped,
  );
  page.on("pageerror", (e) => console.error(`  [page error] ${e.message}`));
  await page.setViewport(VIEWPORT);
  await page.goto(`${BASE}/watch?v=${VIDEO}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#persistent-player", { timeout: 20000 });
  return page;
}

/** The probe is four parallel requests; give the app a moment to act on it. */
async function settleReach(page, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = "";
  for (;;) {
    const now = await page.evaluate(
      () => document.querySelector("#persistent-player iframe")?.getAttribute("src") ?? "",
    );
    const blocked = await page.evaluate(() => !!document.querySelector("[data-reach-blocked]"));
    if (blocked) return;
    if (now && now === last) return;
    last = now;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** The mirror search is several network attempts; it needs real time. */
async function waitFor(page, selector, timeout = 45000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

const embedHost = (page) =>
  page.evaluate(() => {
    const src = document.querySelector("#persistent-player iframe")?.getAttribute("src") ?? "";
    try {
      return new URL(src).host;
    } catch {
      return "";
    }
  });

const text = (page) =>
  page.evaluate(() => document.querySelector("[data-reach-blocked]")?.innerText ?? "");

const browser = await puppeteer.launch({
  args: [...chromium.args, "--no-sandbox"],
  executablePath: process.env.CHROME_PATH ?? (await chromium.executablePath()),
  headless: "shell",
  defaultViewport: VIEWPORT,
});

try {
  // ---- 1. An ordinary network -------------------------------------------
  console.log("\nan open network is left exactly as it was");
  let page = await newPage([]);
  await settleReach(page);
  check("the player stays on youtube.com", await embedHost(page), "www.youtube.com");
  check(
    "no block notice is invented",
    await page.evaluate(() => !!document.querySelector("[data-reach-blocked]")),
    false,
  );
  check(
    "and no detour is announced",
    await page.evaluate(() => !!document.querySelector("[data-reach-notice]")),
    false,
  );
  await page.close();

  // ---- 2. The common filter: the obvious hostname only -------------------
  console.log("\nyoutube.com blocked, the privacy embed domain still open");
  page = await newPage(["www.youtube.com"]);
  await settleReach(page);
  check(
    "the player moves to the host that answers",
    await embedHost(page),
    "www.youtube-nocookie.com",
  );
  check(
    "it is not treated as a dead end",
    await page.evaluate(() => !!document.querySelector("[data-reach-blocked]")),
    false,
  );
  check(
    "the detour is said out loud rather than done silently",
    await page.evaluate(
      () => document.querySelector("[data-reach-notice]")?.textContent?.trim() ?? "",
    ),
    "YouTube is blocked on this network — playing from YouTube's other domain",
  );
  check(
    "the embed keeps the parameters it had",
    await page.evaluate(() => {
      const src = document.querySelector("#persistent-player iframe")?.getAttribute("src") ?? "";
      return src.includes("enablejsapi=1") && src.includes(`/embed/${"dQw4w9WgXcQ"}`);
    }),
    true,
  );
  await page.close();

  // ---- 3. Both embed hosts gone -----------------------------------------
  console.log("\nboth embed hosts blocked, and no mirror answers either");
  page = await newPage(["www.youtube.com", "www.youtube-nocookie.com", "i.ytimg.com"]);
  check(
    "the dead embed is not left on screen taking the space",
    await page.evaluate(() => !document.querySelector("#persistent-player iframe")),
    true,
  );
  check(
    "the explanation arrives once every source is spent",
    await waitFor(page, "[data-reach-blocked]"),
    true,
  );
  check(
    "it went looking for another source before giving up",
    await page.evaluate(() => window.__searched === true),
    true,
  );
  const tried = await page.evaluate(() => window.__mirrorTries ?? []);
  check("every mirror was actually tried, not just mentioned", tried.length >= 3, true);
  check(
    "and each was asked to serve the bytes itself, never googlevideo",
    tried.length > 0 && tried.every((t) => /local=true/.test(t.src)),
    true,
  );
  const blockedText = await text(page);
  check(
    "the player says the network is the thing blocking it",
    /blocking YouTube itself/i.test(blockedText),
    true,
  );
  check("both hosts tried are named", /youtube-nocookie\.com/i.test(blockedText), true);
  check(
    "and it says the mirrors were tried too, so the user is not sent round again",
    /mirror/i.test(blockedText),
    true,
  );
  check(
    "the fix that matches a DNS filter is given, with real addresses",
    /1\.1\.1\.1/.test(blockedText) && /one\.one\.one\.one/.test(blockedText),
    true,
  );
  check(
    "a VPN is named as the limit of the DNS fix, not as the first move",
    /VPN/.test(blockedText) && blockedText.indexOf("1.1.1.1") < blockedText.indexOf("VPN"),
    true,
  );
  check(
    "thumbnails are reported separately, since they fail for their own reason",
    /i\.ytimg\.com/i.test(blockedText),
    true,
  );
  check(
    "the measurement can be run again from here",
    await page.evaluate(() =>
      [...document.querySelectorAll("[data-reach-blocked] button")].some((b) =>
        /test the network again/i.test(b.textContent ?? ""),
      ),
    ),
    true,
  );
  await page.close();

  // ---- 4. The whole network is down --------------------------------------
  // The control. Everything fails here, including this origin, so nothing can
  // be concluded about YouTube -- and accusing an ISP filter would send the
  // user to change DNS settings that were never the problem.
  console.log("\na network that is simply down is not blamed on a YouTube filter");
  page = await newPage(["www.youtube.com", "www.youtube-nocookie.com", "i.ytimg.com", "/favicon"]);
  await settleReach(page);
  check(
    "no block is declared when the control fails too",
    await page.evaluate(() => !!document.querySelector("[data-reach-blocked]")),
    false,
  );
  check("and the player is not moved on a guess", await embedHost(page), "www.youtube.com");
  await page.close();

  // ---- 4b. A mirror that does answer ------------------------------------
  // The whole point of the exercise: YouTube is unreachable, but a front-end
  // the network does not block hands over a playable file, and the video
  // plays from there.
  console.log("\na reachable mirror plays the video that YouTube cannot");
  page = await newPage(["www.youtube.com", "www.youtube-nocookie.com", "i.ytimg.com"], {
    piped: "pipedapi.kavin.rocks",
  });
  // The fixture URL is deliberately unplayable, so the element moves past it
  // the moment it fails -- which is the failover doing its job. What matters
  // is what it reached for first, and who it named.
  await waitFor(page, "[data-reach-blocked]");
  const picks = await page.evaluate(() => window.__mirrorTries ?? []);
  check("a real player appeared", picks.length > 0, true);
  check(
    "the instance that answered is tried before the ones that only might",
    picks[0]?.src ?? "",
    "https://proxy.example/muxed360",
  );
  check(
    "the source is named rather than passed off as YouTube",
    picks[0]?.instance ?? "",
    "pipedapi.kavin.rocks",
  );
  check("when one source fails the next is tried, not the whole idea", picks.length >= 2, true);
  await page.close();

  // ---- 5. A filter that answers instead of refusing ----------------------
  // The nastier shape: the network returns a block page, so every host probes
  // as perfectly reachable and only the player's silence gives it away. The
  // embed never speaks here because the sandbox has no YouTube at all, which
  // is exactly the condition being tested.
  console.log("\na player that never boots is moved to the other host anyway");
  page = await newPage([]);
  await settleReach(page);
  check("it starts where it always starts", await embedHost(page), "www.youtube.com");
  await new Promise((r) => setTimeout(r, 11000));
  check(
    "silence from the embed moves it to the other host",
    await embedHost(page),
    "www.youtube-nocookie.com",
  );
  check(
    "and that detour is announced too",
    await page.evaluate(() => !!document.querySelector("[data-reach-notice]")),
    true,
  );
  await page.close();
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
