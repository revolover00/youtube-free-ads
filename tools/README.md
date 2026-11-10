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
