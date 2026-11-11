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
 *     you're not a bot", so the server can no longer read a storyboard spec.
 *   - Storyboard sheets on i.ytimg.com are 403 without the signature that
 *     only that spec carries.
 *   - The player is a cross-origin iframe, so its pixels are unreadable from
 *     JavaScript, and the muxed streams are signature-locked.
 *
 * What remains is the screenshot button already built into the phone. The
 * work here is to make what it photographs as sharp as the video actually
 * allows — which is a question of resolution, not of screen area.
 */

const ATTR = "data-shot-mode";
const LAYER_ID = "yt-shot-layer";
const CARD_ID = "yt-shot-card";
const BACKDROP_ID = "yt-shot-backdrop";

/** The YouTube embed takes commands over postMessage; this is how Watch.tsx drives it. */
function commandPlayer(func: string, args: unknown[] = []): void {
  const iframe = document.querySelector("#persistent-player iframe") as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

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

interface PlayerInfo {
  currentTime?: number;
  playbackQuality?: string;
  availableQualityLevels?: string[];
}

/** YouTubePlayer.tsx already re-broadcasts every infoDelivery payload. */
function watchPlayerInfo(onInfo: (info: PlayerInfo) => void): () => void {
  const handler = (e: Event) => onInfo((e as CustomEvent<PlayerInfo>).detail ?? {});
  window.addEventListener("yt:player-info", handler);
  return () => window.removeEventListener("yt:player-info", handler);
}

export function isShotModeActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);
}

export function exitShotMode(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(ATTR);
  document.documentElement.style.removeProperty("--yt-shot-w");
  document.documentElement.style.removeProperty("--yt-shot-h");
  document.getElementById(LAYER_ID)?.remove();
  document.getElementById(BACKDROP_ID)?.remove();
  if (document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {
      /* already gone */
    });
  }
}

/**
 * Size the player so one video pixel lands on one device pixel.
 *
 * Stretching a 720p video across a 2400px-wide landscape screen does not add
 * detail, it just interpolates — which is exactly what "the quality is
 * rubbish" looks like. Rendering at the source's own resolution (or smaller,
 * when the screen is smaller) is the sharpest a screenshot can possibly be.
 *
 * @returns the device-pixel size the frame will occupy in the screenshot.
 */
export function sizeToNative(lines: number): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  let h = lines / dpr;
  let w = (h * 16) / 9;

  // Never grow past the screen; downscaling stays sharp, upscaling does not.
  const maxW = window.innerWidth;
  const maxH = window.innerHeight;
  const shrink = Math.min(1, maxW / w, maxH / h);
  w *= shrink;
  h *= shrink;

  document.documentElement.style.setProperty("--yt-shot-w", `${Math.round(w)}px`);
  document.documentElement.style.setProperty("--yt-shot-h", `${Math.round(h)}px`);
  return { width: Math.round(w * dpr), height: Math.round(h * dpr) };
}

/**
 * A 16:9 video inside a portrait phone only gets about a quarter of the
 * screen. Landscape leaves room to show it at full resolution rather than a
 * downscaled slice, so it is worth asking for.
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

function isPortrait(): boolean {
  return window.innerHeight > window.innerWidth;
}

/**
 * Swap the text without remounting, so each stage can report itself in place
 * and only the final message starts counting down to invisibility.
 */
function setLayerMessage(message: string, { fade } = { fade: true }): void {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  card.textContent = message;
  if (!fade) return;
  // Long enough to read, short enough that nobody is still waiting for it.
  window.setTimeout(() => {
    card.style.opacity = "0";
  }, 3000);
}

/**
 * The instruction has to be read and then be gone, because anything still on
 * screen lands in the user's photo. It leaves behind an invisible catcher so
 * a tap anywhere returns to the app.
 */
function mountLayer(message: string, dir: "rtl" | "ltr"): void {
  document.getElementById(LAYER_ID)?.remove();
  document.getElementById(BACKDROP_ID)?.remove();

  // The player no longer covers the whole screen once it is sized to the
  // video's own resolution, so the rest of the app needs hiding behind this.
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

export interface ShotCopy {
  /** Shown while the player is being pushed up to its best resolution. */
  preparing: string;
  /** Built once the real resolution is known. */
  ready: (size: string) => string;
  /** Appended when the phone is still portrait and could not be turned. */
  rotate: string;
  dir: "rtl" | "ltr";
}

/**
 * @param at seconds to land on — the moment the user actually asked for.
 */
export async function enterShotMode(at: number, copy: ShotCopy): Promise<void> {
  if (typeof document === "undefined") return;

  document.documentElement.setAttribute(ATTR, "");
  mountLayer(copy.preparing, copy.dir);

  let latest: PlayerInfo = {};
  const stopWatching = watchPlayerInfo((info) => {
    latest = { ...latest, ...info };
  });

  try {
    // Fullscreen takes the address bar out of the shot and, on Android, is
    // what makes the orientation lock below legal. iOS refuses both for a
    // non-video element, so neither is allowed to be load-bearing.
    try {
      await document.getElementById("persistent-player")?.requestFullscreen?.({
        navigationUI: "hide",
      });
    } catch {
      /* the CSS layout stands on its own */
    }
    const turned = await faceLandscape();

    /*
      Seeking is what made the first attempt blurry in a second way: YouTube
      refills its buffer with a low-quality segment after every seek, so
      pausing straight afterwards freezes exactly that. Playing *through* the
      moment instead leaves it buffered at full quality, and the seek back
      then lands on data already downloaded.
    */
    commandPlayer("setPlaybackQuality", ["highres"]);
    commandPlayer("seekTo", [Math.max(0, at - 3), true]);
    commandPlayer("playVideo");

    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await wait(200);
      if ((latest.currentTime ?? -1) > at + 0.4) break;
    }

    commandPlayer("seekTo", [at, true]);
    await wait(500);
    commandPlayer("pauseVideo");

    // Only now is the real ceiling known, so only now can the frame be sized
    // honestly — and the user told what they are actually getting.
    const lines = QUALITY_LINES[latest.playbackQuality ?? ""] ?? 0;
    const size = lines ? sizeToNative(lines) : null;
    const label = size ? `${size.width}×${size.height}` : "";

    const needsTurn = !turned && isPortrait();
    setLayerMessage(needsTurn ? `${copy.ready(label)} ${copy.rotate}` : copy.ready(label));
  } finally {
    stopWatching();
  }
}
