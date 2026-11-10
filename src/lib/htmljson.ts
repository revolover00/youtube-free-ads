/**
 * Extracting the JSON blobs YouTube embeds in its HTML pages.
 *
 * Kept free of other imports so the test harness can load it directly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Pull an embedded `var X = {…};` JSON blob out of a YouTube HTML page.
 *
 * Brace-matched rather than regex-matched: these payloads are megabytes of
 * deeply nested JSON that contain `}`, escaped quotes and even `</script>`
 * inside string values, so a lazy regex stops early and a greedy one runs off
 * the end of the document.
 *
 * Returns `null` when the variable is absent (a consent interstitial, say) or
 * when the blob does not parse, so callers can fall through to another source.
 */
export function extractJsonVar(html: string, name: string): Json | null {
  for (const marker of [`var ${name} = `, `window["${name}"] = `, `${name} = `]) {
    const at = html.indexOf(marker);
    if (at === -1) continue;
    const start = html.indexOf("{", at + marker.length);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < html.length; i++) {
      const ch = html[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        // Backslashes only escape inside strings; elsewhere they are noise.
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1)) as Json;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}
