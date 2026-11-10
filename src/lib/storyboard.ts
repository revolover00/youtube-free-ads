/**
 * Storyboard spec parsing and frame addressing.
 *
 * Kept free of imports and I/O so the maths can be tested directly
 * (tools/storyboard-test.mjs) without standing up the server data layer.
 *
 * Spec format (`playerStoryboardSpecRenderer.spec`):
 *
 *   <baseUrl with $L/$N placeholders>|<level 0>|<level 1>|…
 *   level := width#height#frameCount#cols#rows#intervalMs#nameReplacement#sigh
 *
 * Levels are listed low → high quality; the last one is the biggest. The base
 * URL keeps a `$M` placeholder for the sheet index, substituted per request.
 */

export interface StoryboardLevel {
  url: string;
  width: number;
  height: number;
  frameCount: number;
  cols: number;
  rows: number;
  /** Milliseconds between consecutive frames (0 on the single-sheet level 0). */
  intervalMs: number;
}

export function parseStoryboardSpec(spec: string): StoryboardLevel[] {
  if (!spec) return [];
  const parts = spec.split("|");
  const base = parts.shift();
  if (!base) return [];

  const levels: StoryboardLevel[] = [];
  parts.forEach((raw, i) => {
    const args = raw.split("#");
    if (args.length < 8) return;
    const [width, height, frameCount, cols, rows, intervalMs] = args.slice(0, 6).map(Number);
    const nameReplacement = args[6];
    const sigh = args[7];
    if (!width || !height || !frameCount || !cols || !rows) return;

    let url = base.replace("$L", String(i)).replace("$N", nameReplacement ?? "M$M");
    url += `${url.includes("?") ? "&" : "?"}sigh=${sigh}`;
    levels.push({
      url,
      width,
      height,
      frameCount,
      cols,
      rows,
      intervalMs: Number.isFinite(intervalMs) ? intervalMs! : 0,
    });
  });
  return levels;
}

export interface FrameAddress {
  /** Sheet URL with `$M` resolved. */
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Timestamp the addressed tile actually represents. */
  at: number;
}

/**
 * Locate the tile covering `time` within a level.
 *
 * Prefers the level's own frame interval. Deriving the index from the video
 * duration instead drifts whenever the reported length and the storyboard's
 * frame count disagree, which lands on the wrong tile near the end of longer
 * videos.
 */
export function addressFrame(level: StoryboardLevel, time: number, duration: number): FrameAddress {
  const at = Math.max(0, Number.isFinite(time) ? time : 0);
  const perSheet = level.cols * level.rows;

  const rawIndex =
    level.intervalMs > 0
      ? Math.floor((at * 1000) / level.intervalMs)
      : duration > 0
        ? Math.floor((at / duration) * level.frameCount)
        : 0;

  const frameIndex = Math.min(level.frameCount - 1, Math.max(0, rawIndex));
  const sheetIndex = Math.floor(frameIndex / perSheet);
  const withinSheet = frameIndex % perSheet;

  return {
    url: level.url.replace("$M", String(sheetIndex)),
    x: (withinSheet % level.cols) * level.width,
    y: Math.floor(withinSheet / level.cols) * level.height,
    width: level.width,
    height: level.height,
    at:
      level.intervalMs > 0
        ? (frameIndex * level.intervalMs) / 1000
        : duration > 0
          ? (frameIndex / level.frameCount) * duration
          : at,
  };
}
