/**
 * Unit tests for extractJsonVar() — the brace-matching scraper that pulls
 * `ytInitialData` out of a watch page when youtubei/v1/next answers 403.
 *
 * Everything here is adversarial on purpose: real YouTube HTML embeds braces,
 * escaped quotes and `</script>` inside JSON string values, which is exactly
 * where a regex-based extractor silently truncates.
 *
 * Run: node tools/extract-json-test.mjs
 */
import { extractJsonVar } from "../src/lib/htmljson.ts";

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const page = (inner) =>
  `<!DOCTYPE html><html><head><script nonce="x">${inner}</script></head><body></body></html>`;

console.log("extractJsonVar");

// 1. The ordinary shape.
{
  const d = extractJsonVar(page(`var ytInitialData = {"a":1,"b":{"c":2}};`), "ytInitialData");
  check("plain var assignment", d !== null && d.b.c === 2);
}

// 2. window["…"] assignment, the other shape YouTube ships.
{
  const d = extractJsonVar(page(`window["ytInitialData"] = {"ok":true};`), "ytInitialData");
  check("window[] assignment", d !== null && d.ok === true);
}

// 3. A closing brace inside a string value must not end the scan.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"title":"a } b { c","tail":"end"};`),
    "ytInitialData",
  );
  check("brace inside string", d !== null && d.tail === "end", d && JSON.stringify(d));
}

// 4. Escaped quote directly before a brace — the classic off-by-one.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"q":"say \\"}\\" now","tail":"end"};`),
    "ytInitialData",
  );
  check("escaped quote then brace", d !== null && d.tail === "end", d && JSON.stringify(d));
}

// 5. A trailing backslash inside a string must not escape the closing quote.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"path":"C:\\\\","tail":"end"};`),
    "ytInitialData",
  );
  check("trailing backslash in string", d !== null && d.tail === "end", d && JSON.stringify(d));
}

// 6. Script-closing text inside a description, verbatim from real pages.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"desc":"</script> and {nested}","tail":"end"};`),
    "ytInitialData",
  );
  check("</script> inside a string", d !== null && d.tail === "end", d && JSON.stringify(d));
}

// 6b. The decisive case: a literal `};` *inside* a string value. A lazy regex
//     stops dead here, which is precisely how the naive extractor fails.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"desc":"code: function(){ return 1; }; done","tail":"end"};`),
    "ytInitialData",
  );
  check("'};' inside a string", d !== null && d.tail === "end", d && JSON.stringify(d));
}

// 6c. Same hazard, spelled the way a video description actually reads.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"a":{"desc":"see {this}; and {that};"},"tail":"end"};`),
    "ytInitialData",
  );
  check(
    "nested object with '};' in a string",
    d !== null && d.tail === "end",
    d && JSON.stringify(d),
  );
}

// 6d. YouTube pretty-prints some payloads across lines; `.` never matches \n.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {\n  "a": 1,\n  "b": { "c": "x" }\n};`),
    "ytInitialData",
  );
  check("multi-line blob", d !== null && d.b.c === "x", d && JSON.stringify(d));
}

// 7. Deep nesting shaped like the real renderer tree, with the marker appearing
//    as a string earlier in the page (an easy way to grab the wrong offset).
{
  const real = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: { title: { runs: [{ text: "مرحبا { بالعالم }" }] } } },
              { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: "Ch" } } } },
            ],
          },
        },
        secondaryResults: {
          secondaryResults: { results: [{ compactVideoRenderer: { videoId: "x" } }] },
        },
      },
    },
  };
  const html = page(
    `var meta = {"note":"ytInitialData is below"};\nvar ytInitialData = ${JSON.stringify(real)};`,
  );
  const d = extractJsonVar(html, "ytInitialData");
  const title =
    d?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]
      ?.videoPrimaryInfoRenderer?.title?.runs?.[0]?.text;
  check("deep renderer tree + decoy marker", title === "مرحبا { بالعالم }", String(title));
  check(
    "related results survive",
    d?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results?.[0]
      ?.compactVideoRenderer?.videoId === "x",
  );
}

// 8. Trailing content after the blob must be ignored.
{
  const d = extractJsonVar(
    page(`var ytInitialData = {"a":1};var ytInitialPlayerResponse = {"a":2};`),
    "ytInitialData",
  );
  check("stops at its own blob", d !== null && d.a === 1, d && JSON.stringify(d));
}

// 9. Sibling variable is still reachable by name.
{
  const d = extractJsonVar(
    page(
      `var ytInitialData = {"a":1};var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"213"}};`,
    ),
    "ytInitialPlayerResponse",
  );
  check("second variable by name", d?.videoDetails?.lengthSeconds === "213");
}

// 10. Absent / malformed input returns null rather than throwing.
{
  check(
    "missing variable → null",
    extractJsonVar(page(`var other = {"a":1};`), "ytInitialData") === null,
  );
  check(
    "unterminated blob → null",
    extractJsonVar(`var ytInitialData = {"a":1`, "ytInitialData") === null,
  );
  check(
    "non-JSON blob → null",
    extractJsonVar(`var ytInitialData = {oops};`, "ytInitialData") === null,
  );
  check("empty string → null", extractJsonVar("", "ytInitialData") === null);
}

// 11. A consent/redirect page has the marker absent entirely.
{
  const consent = `<html><body>Before you continue to YouTube</body></html>`;
  check("consent page → null", extractJsonVar(consent, "ytInitialData") === null);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
