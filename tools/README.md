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
