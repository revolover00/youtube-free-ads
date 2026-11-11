/**
 * Prepare the page so the phone's own screenshot button captures the frame.
 *
 * Every route to the pixels is closed on a phone, and each one was measured
 * rather than assumed:
 *
 *   - `getDisplayMedia` is implemented by no mobile browser at all — not
 *     Chrome on Android, not Safari on iOS, not Samsung Internet.
 *   - Every InnerTube client (WEB, MWEB, ANDROID, ANDROID_VR, IOS, the TV and
 *     embedded players) answers a datacentre IP with "Sign in to confirm
 *     you're not a bot", so the server cannot read a storyboard spec.
 *   - Storyboard sheets on i.ytimg.com are 403 without the signature that
 *     only that spec carries.
 *   - The player is a cross-origin iframe, so its pixels are unreadable from
 *     JavaScript, and the muxed streams are signature-locked.
 *
 * So the phone's own screenshot is the capture, and everything here exists to
 * make what it photographs worth keeping: no player chrome over the frame, no
 * upscaling, and the real moment.
 */

const ATTR = "data-shot-mode";
const LAYER_ID = "yt-shot-layer";
const CARD_ID = "yt-shot-card";
const BACKDROP_ID = "yt-shot-backdrop";
const STAGE_ID = "yt-shot-stage";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** YouTube reports quality by name; these are the line counts behind the names. */
const QUALITY_LINES: Record<string, number> = {
  tiny: 144,
  small: 240,
  medium: 360,
  large: 480,
  hd720: 720,
  hd1080: 1080,
  hd1440: 1440,
  hd2160: 2160,
  highres: 2160,
};

/**
 * Assumed when the player never reports a quality. Guessing low and
 * downscaling stays sharp; guessing high and upscaling is the exact defect
 * this module keeps being blamed for.
 */
const ASSUMED_LINES = 720;

function send(target: Window | null | undefined, event: string, extra: object = {}): void {
  target?.postMessage(JSON.stringify({ event, ...extra }), "*");
}

function command(target: Window | null | undefined, func: string, args: unknown[] = []): void {
  send(target, "command", { func, args });
}

export function isShotModeActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);
}

export function exitShotMode(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(ATTR);
  document.documentElement.style.removeProperty("--yt-shot-w");
  document.documentElement.style.removeProperty("--yt-shot-h");
  [LAYER_ID, BACKDROP_ID, STAGE_ID].forEach((id) => document.getElementById(id)?.remove());
  if (document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {
      /* already gone */
    });
  }
}

/**
 * Size the stage so one video pixel lands on one device pixel.
 *
 * Stretching a 720p video across a 2400px-wide landscape screen does not add
 * detail, it interpolates — which is what "the quality is rubbish" looks
 * like. Rendering at the source's own resolution, or smaller when the screen
 * is smaller, is the sharpest a screenshot can be.
 *
 * @returns the device-pixel size the frame will occupy in the screenshot.
 */
export function sizeToNative(lines: number): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  let h = lines / dpr;
  let w = (h * 16) / 9;

  // Never grow past the screen; downscaling stays sharp, upscaling does not.
  const shrink = Math.min(1, window.innerWidth / w, window.innerHeight / h);
  w *= shrink;
  h *= shrink;

  document.documentElement.style.setProperty("--yt-shot-w", `${Math.round(w)}px`);
  document.documentElement.style.setProperty("--yt-shot-h", `${Math.round(h)}px`);
  return { width: Math.round(w * dpr), height: Math.round(h * dpr) };
}

/**
 * A 16:9 video in a portrait phone has no room to be shown at full size.
 * Landscape does, so it is worth asking for.
 */
async function faceLandscape(): Promise<boolean> {
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    await orientation.lock?.("landscape");
    return true;
  } catch {
    // iOS has no orientation lock, and Android refuses it outside fullscreen.
    return false;
  }
}

const isPortrait = () => window.innerHeight > window.innerWidth;

/**
 * Swap the text without remounting, so each stage reports itself in place and
 * only the final message counts down to invisibility.
 */
function setLayerMessage(message: string, { fade } = { fade: true }): void {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  card.textContent = message;
  if (!fade) return;
  window.setTimeout(() => {
    card.style.opacity = "0";
  }, 3200);
}

/**
 * A second, deliberately bare player.
 *
 * The page's own embed runs with `controls=1`, and a paused YouTube embed
 * draws its control bar, its progress bar and a large play button straight
 * over the frame — all of which land in the screenshot. Those are iframe
 * parameters, so they cannot be turned off after load; the only way to a
 * clean frame is a player that never had them. It starts shortly before the
 * moment and plays into it, because seeking makes YouTube refill its buffer
 * from a low-quality segment and pausing right after freezes exactly that.
 */
function mountStage(videoId: string, at: number): HTMLIFrameElement {
  const stage = document.createElement("div");
  stage.id = STAGE_ID;

  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    controls: "0",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    iv_load_policy: "3",
    disablekb: "1",
    fs: "0",
    enablejsapi: "1",
    origin: window.location.origin,
    start: String(Math.max(0, Math.floor(at - 2))),
    vq: "hd1080",
  });

  const frame = document.createElement("iframe");
  frame.allow = "autoplay; encrypted-media";
  frame.setAttribute("frameborder", "0");
  frame.src = `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
  Object.assign(frame.style, {
    width: "100%",
    height: "100%",
    border: "0",
    display: "block",
  } satisfies Partial<CSSStyleDeclaration>);
  frame.addEventListener("load", () => {
    send(frame.contentWindow, "listening", { id: 1, channel: "widget" });
    command(frame.contentWindow, "setPlaybackQuality", ["highres"]);
  });

  stage.appendChild(frame);
  document.body.appendChild(stage);
  return frame;
}

export interface ShotCopy {
  /** Shown while the frame is being brought up to its best resolution. */
  preparing: string;
  /** Built once the real resolution is known. */
  ready: (size: string) => string;
  /** Appended when the phone is still portrait and could not be turned. */
  rotate: string;
  dir: "rtl" | "ltr";
}

/**
 * The instruction has to be read and then be gone, because anything still on
 * screen lands in the photo. It leaves an invisible catcher behind so a tap
 * anywhere returns to the app.
 */
function mountChrome(message: string, dir: "rtl" | "ltr"): void {
  const backdrop = document.createElement("div");
  backdrop.id = BACKDROP_ID;
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "2147482999",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(backdrop);

  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("role", "status");
  layer.dir = dir;
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    // Nothing here may tint the screenshot, only catch the exit tap.
    background: "transparent",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);

  const card = document.createElement("div");
  card.id = CARD_ID;
  card.textContent = message;
  Object.assign(card.style, {
    maxWidth: "min(88vw, 420px)",
    margin: "0 24px",
    padding: "14px 18px",
    borderRadius: "14px",
    background: "rgba(0,0,0,0.82)",
    color: "#f1f1f1",
    font: '500 15px/22px "Roboto","Tajawal",Arial,sans-serif',
    textAlign: "center",
    transition: "opacity 420ms ease-out",
    opacity: "1",
  } satisfies Partial<CSSStyleDeclaration>);

  layer.appendChild(card);
  layer.addEventListener("click", exitShotMode, { once: true });
  document.body.appendChild(layer);
}

/**
 * @param at seconds to land on — the moment the user actually asked for.
 */
export async function enterShotMode(videoId: string, at: number, copy: ShotCopy): Promise<void> {
  if (typeof document === "undefined") return;

  // Two videos must not play at once, and the page's own player is about to
  // be hidden behind the backdrop anyway.
  const pageFrame = document.querySelector("#persistent-player iframe") as HTMLIFrameElement | null;
  command(pageFrame?.contentWindow, "pauseVideo");

  document.documentElement.setAttribute(ATTR, "");
  mountChrome(copy.preparing, copy.dir);
  const frame = mountStage(videoId, at);

  // Fullscreen takes the address bar out of the shot and, on Android, is what
  // makes the orientation lock legal. iOS refuses both for a non-video
  // element, so neither is load-bearing.
  try {
    await document.getElementById(STAGE_ID)?.requestFullscreen?.({ navigationUI: "hide" });
  } catch {
    /* the CSS layout stands on its own */
  }
  const turned = await faceLandscape();

  /*
    Take the best quality ever reported rather than the latest: the number
    dips while any new segment is being fetched, and sizing the stage from a
    dip would shrink the frame for no reason.
  */
  let bestLines = 0;
  let currentTime = -1;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    try {
      const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const info = data?.info;
      if (!info) return;
      if (typeof info.currentTime === "number") currentTime = info.currentTime;
      bestLines = Math.max(bestLines, QUALITY_LINES[info.playbackQuality ?? ""] ?? 0);
    } catch {
      /* not a player message */
    }
  };
  window.addEventListener("message", onMessage);

  try {
    // Let it play into the moment so that stretch is buffered at full quality.
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && currentTime < at) {
      await wait(200);
    }
    command(frame.contentWindow, "pauseVideo");
    await wait(250);

    const size = sizeToNative(bestLines || ASSUMED_LINES);
    const needsTurn = !turned && isPortrait();
    const text = copy.ready(`${size.width}×${size.height}`);
    setLayerMessage(needsTurn ? `${text} ${copy.rotate}` : text);
  } finally {
    window.removeEventListener("message", onMessage);
  }
}
