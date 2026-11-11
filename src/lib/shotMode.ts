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
function commandPlayer(func: string): void {
  const iframe = document.querySelector("#persistent-player iframe") as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*");
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
function mountLayer(message: string, dir: "rtl" | "ltr"): void {
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

  // Long enough to read, short enough that nobody is still waiting for it.
  window.setTimeout(() => {
    card.style.opacity = "0";
  }, 2600);
}

export async function enterShotMode(message: string, dir: "rtl" | "ltr"): Promise<void> {
  if (typeof document === "undefined") return;

  // A moving frame cannot be photographed, and the paused frame is precisely
  // the moment the user asked for.
  commandPlayer("pauseVideo");
  document.documentElement.setAttribute(ATTR, "");
  mountLayer(message, dir);

  // Real fullscreen also takes the browser's address bar out of the shot.
  // iOS Safari refuses it for anything but a video element, which is exactly
  // why the CSS below stands on its own rather than depending on this.
  try {
    await document.getElementById("persistent-player")?.requestFullscreen?.({
      navigationUI: "hide",
    });
  } catch {
    /* the full-viewport CSS is already applied */
  }
}
