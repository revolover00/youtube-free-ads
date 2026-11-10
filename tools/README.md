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

`getDisplayMedia` can't be driven headlessly, but `captureHd` only ever
consumes a `MediaStream` — so the test swaps in a canvas `captureStream()`
painted green everywhere except the rectangle where `#persistent-player` sits,
which is pink. A correct capture is therefore pink in the middle. That runs the
real code: video element, decode wait, `videoWidth`, the
`displaySurface === "browser"` crop, and `compose`. 6 assertions.

It also covers the dismissal path: `getDisplayMedia` rejecting with
`NotAllowedError` must fall back to the server frame rather than leave a
spinner, and must not re-open the prompt on the next capture.

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
