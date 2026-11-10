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
