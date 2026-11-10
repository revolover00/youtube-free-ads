# tools

## screenshot.mjs

Captures the app at several viewports into `.tmp-shots/` so the UI can actually
be reviewed. This sandbox has no system Chrome and cannot reach Google's
download CDN, so the browser comes from the `@sparticuz/chromium` npm package,
which ships a Chromium build plus the shared libraries it needs.

First-time setup in a fresh sandbox:

```sh
# extract the bundled shared libs (libnspr4 / libnss3 / ...) that Chromium needs
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("/tmp/al2023.tar",z.brotliDecompressSync(f.readFileSync("node_modules/@sparticuz/chromium/bin/al2023.tar.br")))'
mkdir -p /tmp/allibs && tar -xf /tmp/al2023.tar -C /tmp/allibs
```

Then, with the dev server running **with fixtures enabled** (the sandbox cannot
reach YouTube, so without them every page is an empty skeleton):

```sh
YT_UI_FIXTURE=1 npm run dev          # in one process
LD_LIBRARY_PATH=/tmp/allibs/lib node tools/screenshot.mjs
```

Both details matter: the script must run from the repo root so Node can resolve
`@sparticuz/chromium`, and `LD_LIBRARY_PATH` must point at the extracted libs or
Chromium fails with `libnspr4.so: cannot open shared object file`.

## storyboard-test.mjs

Asserts the storyboard spec parsing and frame addressing in
`src/lib/storyboard.ts` against a real YouTube spec string. Pure logic, no
browser and no network:

```sh
node tools/storyboard-test.mjs
```

This path matters because it cannot be exercised any other way from here —
the sandbox has no route to `i.ytimg.com`, so the only honest way to check
that `$L`/`$N`/`$M` substitution and the tile maths are right is to assert
them directly.

## capture-test.mjs

Drives the Screenshot button in a real browser and checks that the captured
image is the frame for the requested timestamp:

```sh
YT_UI_FIXTURE=1 npm run dev
LD_LIBRARY_PATH=/tmp/allibs/lib node tools/capture-test.mjs
```

The fixture storyboard is a 5x5 sheet of flat, uniquely coloured tiles, so the
centre pixel of the result says exactly which tile was cropped. It also
simulates ~12 seconds of playback progress and asserts the player iframe is
neither re-`src`-ed nor remounted, since the store now notifies subscribers
once per second and a mistake there would restart the video continuously.

## `live-storyboard-test.mjs`

```bash
node tools/live-storyboard-test.mjs
```

No browser, no network, no dev server. Drives the real `src/lib/storyboard.ts`
parser with a `playerStoryboardSpecRenderer.spec` string captured verbatim from
YouTube, and asserts it reconstructs the exact sheet URLs that `i.ytimg.com` was
observed to serve. 29 assertions.

Each URL asserted here was confirmed on the wire with a `HEAD` from a datacentre
IP:

| URL the parser builds | CDN response |
| --- | --- |
| `storyboard3_L3/M0.jpg?sqp=…&sigh=…` (t=0) | `200 image/webp` 21 228 B |
| `storyboard3_L3/M5.jpg?sqp=…&sigh=…` (t=100) | `200 image/webp` 28 138 B |
| `storyboard3_L3/M11.jpg?sqp=…&sigh=…` (t=213) | `200 image/webp` 13 536 B |
| `storyboard3_L2/M0.jpg?sqp=…&sigh=…` | `200 image/webp` 25 152 B |
| `storyboard3_L1/M0.jpg?sqp=…&sigh=…` | `200 image/webp` 42 240 B |
| same L3 URL carrying L1's `sigh` | `403` |
| same L3 URL with `&sigh=` omitted | `403` |

The two `403`s are the point: `sigh` is a per-level signature, it is mandatory,
and the parser pairs the right one with each level.

## `extract-json-test.mjs`

Unit tests for `extractJsonVar()` in `src/lib/htmljson.ts`, the brace-matching
scraper that lifts `ytInitialData` out of a watch page.

```
node tools/extract-json-test.mjs
```

18 assertions, no network. The cases that matter are the ones a lazy regex
(`/var ytInitialData = (\{.*?\});/`) gets wrong — a literal `};` inside a
string value, a multi-line blob, and the `window["…"]` assignment form. That
naive implementation fails 4 of the 18, which is exactly why they are there.

## Why `youtubei/v1/next` needs a fallback

YouTube answers **403 to `youtubei/v1/next` from Vercel's serverless IP ranges**
while still serving `youtubei/v1/search` from the very same host. The home feed
is built on `search`, so it kept working while *every* watch page died with
`youtube next → HTTP 403`. Verified in production on fresh ids
(`jNQXAC9IVRw`, `9bZkp7q19f0`, `kJQP7kiw5Fk`): 206-byte error payloads before
the fix, full 32–37 KB `StreamData` after it.

Two additive layers in `src/lib/youtube.server.ts` handle it:

1. `innertube()` sends the bare request first — the unchanged fast path, so
   nothing that already works can regress — and only on 401/403 retries as an
   attributed web-player session: scraped `visitorData`, `x-goog-visitor-id`,
   the real client headers and the `SOCS` consent cookie.
2. `videoDetails()` falls back to the watch page's `ytInitialData`, which is the
   same renderer tree `next` returns, so every parser downstream is untouched.

Note the asymmetry when testing: the InnerTube endpoints and the `/watch` HTML
are both reachable from Supabase's egress but **not** from this sandbox, so
production checks go through `supabase.execute_query` + `public.http()` rather
than curl.

## How the storyboard source was diagnosed

`youtubei/v1/player` was called directly from a cloud host (Postgres `http`
extension) to find out what the server actually receives in production:

| request shape | result |
| --- | --- |
| `POST /player` — no `key`, no `origin`/`referer` (**what the app used to send**) | `200` but `playabilityStatus: UNPLAYABLE`, **no `storyboards` key**, 11 kB |
| `POST /player` — `?key=…` + `origin` + `referer` + `x-youtube-client-*` | `200 OK`, 43 kB, **full spec** |
| `GET /watch?v=…` with a browser UA | `200 OK`, 1.4 MB, **full spec** |
| `POST /player` as `ANDROID` / `IOS` | `400` |
| `POST /player` as `WEB_EMBEDDED_PLAYER` / `TVHTML5…` | `200` but `playabilityStatus: ERROR` |

So the poster fallback was not a bug in the capture pipeline — the server was
simply never being given a storyboard spec. `playerMeta()` now sends the
browser-shaped request first and scrapes the watch page as a second attempt.

**Caveat worth knowing:** YouTube bot-gates datacentre IPs by request volume.
After roughly 25 requests in a few minutes from one address, every shape above
degrades to `playabilityStatus: LOGIN_REQUIRED`, including shapes that had just
succeeded from that same address. In one back-to-back comparison on the same IP
and the same video, the watch page returned `LOGIN_REQUIRED` while the keyed API
call returned `OK` with the spec — which is why the keyed call is tried first.
`i.ytimg.com` itself is never gated, so once a spec is in hand the sheets always
fetch.

## Verifying the deployed `videoFrameFn` end to end

The production server function can be invoked directly, which proves the whole
chain (deployed server → YouTube → storyboard sheet → base64 → client payload)
without a browser:

```
POST https://youtubiy.vercel.app/_serverFn/<serverFnMeta.id>
Sec-Fetch-Site: same-origin          ← CSRF middleware checks this first
Content-Type: application/json
<seroval-encoded { data, context }>
```

Two details make or break the call:

- The id is **not** the function name. Grep the built server bundle for
  `videoFrameFn_createServerFn_handler = createServerRpc` and read the `id`
  field next to it.
- The body is **seroval**, not plain JSON, and it decodes to `{ data, context }`
  — not to an array of arguments. Generate it with the project's own copy:

  ```bash
  node -e "console.log(JSON.stringify(require('seroval').toJSON(
    { data: { id: 'dQw4w9WgXcQ', time: 100 }, context: {} })))"
  ```

Results against the live deployment for `dQw4w9WgXcQ` (213 s), decoding the
returned `sheet` back to bytes:

| requested `time` | returned `x`,`y` | sheet bytes | sheet the CDN serves | `source` |
| --- | --- | --- | --- | --- |
| 0 | 0, 0 | 21 228 | `L3/M0` 21 228 B | `storyboard` |
| 100 | 640, 180 | 28 138 | `L3/M5` 28 138 B | `storyboard` |
| 212 | 320, 360 | 13 536 | `L3/M11` 13 536 B | `storyboard` |

Three different timestamps return three different sheets, each byte-for-byte
the size measured independently against `i.ytimg.com`, with the offsets
`tools/live-storyboard-test.mjs` predicts — and `source` is `storyboard`, not
`poster`.

## `hd-capture-test.mjs`

```bash
YT_UI_FIXTURE=1 npm run dev          # terminal 1
LD_LIBRARY_PATH=/tmp/allibs/lib node tools/hd-capture-test.mjs
```

`getDisplayMedia` cannot be driven here: the headless shell has no surface to
capture and answers `NotReadableError`. `--headless=new` without
`--single-process`/`--no-zygote`, plus `--auto-accept-this-tab-capture`, does
not help either — the prompt is auto-accepted and the capture still fails to
start. Both were tried; don't retry them.

**The first version of this test stubbed the surface with a canvas it painted
itself, and that is exactly how a real defect shipped.** A tab capture
photographs the *live page*, and this dialog is a full-viewport `bg-black/60`
scrim with a panel in the middle of it, painted at `z-120` directly over the
player at `z-20`. So the "HD" frame was the video dimmed to 40 % with the
dialog box sitting in the shot. A hand-painted surface can never show that; the
test passed while the feature was broken in the user's hands.

So the surface is now **a real render of the real page**: `page.exposeFunction`
hands the page a binding that calls Puppeteer's `page.screenshot()` at the
exact moment `captureHd` opens the surface, and those pixels become the
`MediaStream`. Only the transport is faked — DOM, layout, paint, crop maths and
`compose` are all the production path.

To make the crop measurable, `#persistent-player` is tinted `rgb(0,200,255)`
through an injected `::after` rule. It has to be a stylesheet, not
`element.style`: React owns that element's inline style and re-applies it on
the next render, silently undoing a direct mutation. Under the scrim that
colour becomes `rgb(0,80,102)`, so the two are trivially distinguishable.

20 assertions across three scenarios — a browser where capture has worked
before (prompts straight away), a first visit (must *not* prompt unannounced,
must offer the explained button, and must remember once it works), and a
refusal (must explain itself, keep offering the retry, and never disable
anything). The pixels are sampled at two points — the centre (where the dialog *panel*
would land) and an off-centre point inside the player (where the bare *scrim*
would land), because those are different failure modes at different pixels.
Also covered: the overlay's computed `visibility` at the instant the surface is
opened, that it is restored afterwards on both the happy and the refused path,
and that a `NotAllowedError` falls back to the server frame rather than leaving
a spinner without re-opening the prompt next time.

**Verified to fail on purpose.** With `onCapturing` stubbed out to a no-op (the
pre-fix behaviour) the suite reports 7 failures, including the scrim colour and
the overlay visibility; with the fix in place, 20/20. A test for this that has
never been seen to fail is worth nothing.

Waits are on observed state, never on a sleep: `settle()` polls until the
dialog has an image, the overlay is visible again and no spinner is left. Every
frame here costs a CDP screenshot round-trip, so a capture that is instant in a
real browser takes about five seconds in this harness — a fixed sleep made the
suite report failures that were really just impatience.

## Why HD is the default capture

Measured against the live deployment, asking the server for the storyboard of
four real feed videos returned **`source: "poster"` four times out of four** —
YouTube answers `youtubei/v1/player` with `playabilityStatus: LOGIN_REQUIRED`
("sign in to confirm you're not a bot") for datacentre IPs. Every request shape
tried from a cloud host was gated:

| client | result |
| --- | --- |
| `WEB` + API key + `origin`/`referer` | `LOGIN_REQUIRED` |
| `ANDROID_VR` 1.60.19 | `LOGIN_REQUIRED` |
| `TVHTML5` 7.20240304.10.00 | `LOGIN_REQUIRED` |
| `WEB_EMBEDDED_PLAYER` + `thirdParty.embedUrl` | `ERROR` |
| `GET /watch?v=…` with a browser UA | `LOGIN_REQUIRED` |

So the server path cannot be relied on, no matter how the request is shaped —
it degrades to the poster, which looks like a successful capture of the wrong
moment. `getDisplayMedia` reads the frame off the compositor, needs nothing
from YouTube, and cannot be rate-limited, so the dialog now reaches for it
first wherever it exists and keeps the storyboard as the fallback.

Unsigned frames that are *not* gated, if a better no-prompt fallback is ever
wanted: `https://i.ytimg.com/vi/<id>/hq1.jpg`, `hq2.jpg`, `hq3.jpg` — real
frames at roughly 25 %, 50 % and 75 % of the video (verified `200 image/jpeg`).

### Routes that were measured and ruled out

Don't spend another round on these; each was tested against a real feed video,
not a cached one.

| route | result |
| --- | --- |
| `youtubei/v1/player` **from the browser** (`Origin: youtubiy.vercel.app`) | **403** Google abuse page, no `access-control-allow-origin`. The user's own residential IP cannot help: the origin is refused before the IP matters. |
| `i.ytimg.com/vi/<id>/*.jpg` from the browser | **200**, `access-control-allow-origin: *` — readable into a canvas untainted. Only the poster and `hq1..3` live here, so it cannot give an arbitrary timestamp. |
| `i.ytimg.com/sb/...` without `sigh` | 403, as before. The signature only comes from the gated player response. |
| Piped `pipedapi.ducks.party` | 200 for a *cached* `dQw4w9WgXcQ`, **500** for real feed videos. The 200 is the same cache lie that burned round 6. |
| Piped kavin.rocks / adminforge / drgns / private.coffee | 502 · 403 · NXDOMAIN · DNS timeout |
| Invidious yewtu.be / nerdvpn / nadeko / ggtyler / f5.si / artemislena | 403 · 403 · 403 · refused · 530 · TLS error |

So there is no server-side or browser-side *data* route to an arbitrary frame.
The pixels already decoded on the user's screen are the only source, which is
why screen capture is the primary path and why the dialog now spends words
explaining the prompt instead of springing it.
