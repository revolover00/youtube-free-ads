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
 * What remains is the screenshot button already built into the phone, which
 * captures the real frame at the screen's full resolution. The only thing
 * standing between the user and a good shot is our own interface, so this
 * removes it: pause on the exact moment, fill the screen with the player,
 * and get out of the way.
 */

const ATTR = "data-shot-mode";
const LAYER_ID = "yt-shot-layer";

/** The YouTube embed takes commands over postMessage; this is how Watch.tsx drives it. */
function commandPlayer(func: string, args: unknown[] = []): void {
  const iframe = document.querySelector("#persistent-player iframe") as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 16:9 video inside a portrait phone only gets about a quarter of the
 * screen, so the screenshot is mostly black bars. Landscape hands the same
 * video roughly three times the pixels, which is the difference between a
 * usable frame and a thumbnail.
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

export function isShotModeActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);
}

export function exitShotMode(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(ATTR);
  document.getElementById(LAYER_ID)?.remove();
  if (document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {
      /* already gone */
    });
  }
}

/**
 * The instruction has to be read and then be gone, because anything still on
 * screen lands in the user's photo. It fades itself out and leaves behind an
 * invisible catcher so a tap anywhere returns to the app.
 */
const CARD_ID = "yt-shot-card";

/**
 * Swap the text without remounting, so the preparing notice can become the
 * instruction in place, and only then start counting down to invisibility.
 */
function setLayerMessage(message: string): void {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  card.textContent = message;
  // Long enough to read, short enough that nobody is still waiting for it.
  window.setTimeout(() => {
    card.style.opacity = "0";
  }, 2800);
}

function mountLayer(message: string, dir: "rtl" | "ltr", { fade } = { fade: true }): void {
  document.getElementById(LAYER_ID)?.remove();

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
    background: "transparent",
    // Nothing here may intercept the screenshot itself, only the exit tap.
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

  if (fade) {
    window.setTimeout(() => {
      card.style.opacity = "0";
    }, 2800);
  }
}

export interface ShotCopy {
  /** Shown while the player is being pushed up to a usable resolution. */
  preparing: string;
  /** Shown once the frame is ready to be photographed. */
  ready: string;
  /** Appended when the phone is still portrait and could not be turned for them. */
  rotate: string;
  dir: "rtl" | "ltr";
}

/**
 * @param at seconds to land on — the moment the user actually asked for.
 */
export async function enterShotMode(at: number, copy: ShotCopy): Promise<void> {
  if (typeof document === "undefined") return;

  /*
    Order is the whole trick here, and getting it wrong is what made the first
    version blurry: the embed picks its resolution from the size of the player
    element, so a phone-sized player is being served a phone-sized stream.
    Pausing first -- which is what this used to do -- freezes that low
    resolution and then blows it up. Enlarging first lets YouTube switch up,
    and only then is there a frame worth keeping.
  */
  document.documentElement.setAttribute(ATTR, "");
  mountLayer(copy.preparing, copy.dir, { fade: false });

  // Fullscreen also takes the address bar out of the shot, and on Android it
  // is what makes the orientation lock below legal. iOS refuses both for a
  // non-video element, so neither is allowed to be load-bearing.
  try {
    await document.getElementById("persistent-player")?.requestFullscreen?.({
      navigationUI: "hide",
    });
  } catch {
    /* the full-viewport CSS already applied above is the fallback */
  }
  const turned = await faceLandscape();

  // Deprecated but still honoured as a hint; the size change above is what
  // really moves the needle, and this nudges the player to act on it now
  // rather than after several more seconds of playback.
  commandPlayer("setPlaybackQuality", ["highres"]);
  commandPlayer("playVideo");

  // Long enough for the player to fetch and decode at the new size.
  await wait(1800);

  // Playing on to re-buffer drifted away from the requested moment, so come
  // back to it before freezing.
  commandPlayer("seekTo", [at, true]);
  await wait(700);
  commandPlayer("pauseVideo");

  const needsTurn = !turned && isPortrait();
  setLayerMessage(needsTurn ? `${copy.ready} ${copy.rotate}` : copy.ready);
}
