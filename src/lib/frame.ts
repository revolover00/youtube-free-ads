/**
 * In-page frame capture.
 *
 * Playback happens inside a cross-origin `youtube.com/embed` iframe, so the
 * browser refuses to hand us its pixels — `canvas.drawImage(iframe)` throws and
 * `html2canvas` paints an empty rectangle. Two routes remain:
 *
 * 1. **Quick** (default): ask our own server for the frame YouTube itself
 *    decoded for that timestamp (its scrub-preview storyboard), returned as
 *    base64 so the canvas is never tainted, then crop and compose it here.
 * 2. **HD** (opt-in): `getDisplayMedia({ preferCurrentTab: true })` — one
 *    permission prompt, one `ImageBitmap`, track stopped immediately. True
 *    resolution, straight off the compositor.
 *
 * Both paths end at the same composer so the output is identical in shape.
 */

import { captureFrame } from "./api";
import { fmtDuration } from "./format";

export type CaptureTier = "quick" | "hd";
export type CaptureSource = "storyboard" | "poster" | "display";

export interface CaptureOptions {
  videoId: string;
  /** Playback position to capture, in seconds. */
  time: number;
  /** Rendered onto the caption card when `captionCard` is on. */
  title?: string;
  channel?: string;
  /** Compose a titled card instead of returning the bare frame. */
  captionCard?: boolean;
  /**
   * Element the HD path should crop the shared surface down to. Without it a
   * tab capture returns the entire page - masthead, guide and all - which is
   * not what "screenshot this video" means.
   */
  cropSelector?: string;
  /**
   * Called with `true` before the shared surface is opened and `false` once
   * the frame is in hand.
   *
   * A tab capture photographs the live page, so anything the app paints over
   * the player ends up in the shot. The screenshot dialog is a full-viewport
   * scrim with a panel in the middle of it, directly over the player, so
   * without this the "HD" frame is the video dimmed by 60% black with the
   * dialog box sitting on top of it. The caller uses this to get out of the
   * way for the duration.
   */
  onCapturing?: (capturing: boolean) => void;
  /**
   * Live playback position, sampled at the moment the frame is actually read.
   * The share prompt sits open for seconds, so the position the dialog was
   * opened at is not the position that gets photographed.
   */
  getTime?: () => number;
}

export interface CaptureResult {
  /** PNG data URL of the finished image. */
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
  /** Timestamp the frame actually represents. */
  at: number;
  source: CaptureSource;
  /** Native resolution of the frame before any upscale, for honest labelling. */
  nativeWidth: number;
  nativeHeight: number;
  /** Why a poster was substituted for the real frame, when that happened. */
  note?: string;
  /** What the user actually shared: "browser" (a tab), "window", "monitor". */
  surface?: string;
  /** False when the frame is the whole shared surface rather than the player. */
  cropped?: boolean;
}

/** Why a capture could not be produced, in terms the UI can act on. */
export type CaptureFailureCode = "declined" | "unsupported" | "no-track" | "failed";

export class CaptureError extends Error {
  readonly code: CaptureFailureCode;
  constructor(code: CaptureFailureCode, message: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

/** Normalise anything thrown by the capture pipeline into a CaptureError. */
export function asCaptureError(e: unknown): CaptureError {
  if (e instanceof CaptureError) return e;
  if (e instanceof DOMException) {
    // The user closed the picker, or the browser refused outright.
    if (e.name === "NotAllowedError") return new CaptureError("declined", e.message);
    return new CaptureError("failed", `${e.name}: ${e.message}`);
  }
  return new CaptureError("failed", e instanceof Error ? e.message : String(e));
}

const TARGET_WIDTH = 1280;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("frame image failed to decode"));
    img.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas export failed"))), "image/png");
  });
}

/** Draw rounded-rectangle path (Safari < 16 has no `roundRect`). */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Compose the final artefact from an already-decoded source.
 *
 * `captionCard` wraps the frame in YouTube-dark chrome with the timestamp,
 * title and channel burned in — the thing people actually want to send to a
 * friend. Off, you get the clean frame and nothing else.
 */
async function compose(
  source: CanvasImageSource,
  crop: { x: number; y: number; width: number; height: number },
  opts: CaptureOptions,
  meta: { at: number; source: CaptureSource; note?: string },
): Promise<CaptureResult> {
  const aspect = crop.height / crop.width;
  // Blowing a 320x180 storyboard tile up to 1280 adds no detail, it just makes
  // the blur four times bigger. Allow at most a 2x upscale, and never
  // downscale a source that is already larger (the HD path can be 1920 wide).
  const frameW = crop.width >= TARGET_WIDTH ? crop.width : Math.min(TARGET_WIDTH, crop.width * 2);
  const frameH = Math.round(frameW * aspect);

  const card = !!opts.captionCard;
  const pad = card ? Math.round(frameW * 0.03) : 0;
  const barH = card ? Math.round(frameW * 0.115) : 0;

  const canvas = document.createElement("canvas");
  canvas.width = frameW + pad * 2;
  canvas.height = frameH + pad * 2 + barH;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (card) {
    ctx.fillStyle = "#0f0f0f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.save();
  if (card) {
    roundedRect(ctx, pad, pad, frameW, frameH, Math.round(frameW * 0.012));
    ctx.clip();
  }
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, pad, pad, frameW, frameH);
  ctx.restore();

  if (card) {
    const baseY = pad + frameH;
    const stamp = fmtDuration(Math.round(meta.at)) || "0:00";

    // timestamp pill
    const pillH = Math.round(barH * 0.46);
    const pillFont = Math.round(pillH * 0.62);
    ctx.font = `700 ${pillFont}px Roboto, Arial, sans-serif`;
    const stampW = ctx.measureText(stamp).width;
    const pillW = stampW + pillH;
    ctx.fillStyle = "#272727";
    roundedRect(ctx, pad, baseY + Math.round(barH * 0.22), pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = "#f1f1f1";
    ctx.textBaseline = "middle";
    ctx.fillText(stamp, pad + pillH / 2, baseY + Math.round(barH * 0.22) + pillH / 2);

    const textX = pad + pillW + Math.round(barH * 0.18);
    const maxTextW = frameW - (textX - pad);

    const clip = (s: string, font: string) => {
      ctx.font = font;
      if (ctx.measureText(s).width <= maxTextW) return s;
      let out = s;
      while (out.length > 1 && ctx.measureText(`${out}…`).width > maxTextW) out = out.slice(0, -1);
      return `${out}…`;
    };

    if (opts.title) {
      const font = `500 ${Math.round(barH * 0.3)}px Roboto, Arial, sans-serif`;
      ctx.fillStyle = "#f1f1f1";
      ctx.fillText(clip(opts.title, font), textX, baseY + Math.round(barH * 0.37));
    }
    if (opts.channel) {
      const font = `400 ${Math.round(barH * 0.24)}px Roboto, Arial, sans-serif`;
      ctx.fillStyle = "#aaaaaa";
      ctx.fillText(clip(opts.channel, font), textX, baseY + Math.round(barH * 0.72));
    }
  }

  const blob = await toBlob(canvas);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    blob,
    width: canvas.width,
    height: canvas.height,
    at: meta.at,
    source: meta.source,
    nativeWidth: crop.width,
    nativeHeight: crop.height,
    ...(meta.note ? { note: meta.note } : {}),
  };
}

/** Server-resolved storyboard tile — instant, no permission prompt. */
async function captureQuick(opts: CaptureOptions): Promise<CaptureResult> {
  const frame = await captureFrame(opts.videoId, opts.time);
  const img = await loadImage(frame.sheet);
  return compose(img, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, opts, {
    at: frame.at,
    source: frame.source,
    ...(frame.note ? { note: frame.note } : {}),
  });
}

type DisplayMediaConstraints = MediaStreamConstraints & {
  preferCurrentTab?: boolean;
  video?: MediaTrackConstraints | boolean;
};

export function isHdCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * Resolve once the surface has actually presented a frame.
 *
 * `requestVideoFrameCallback` fires on presentation, which is the only honest
 * signal that there is something to draw; the rAF pair covers browsers without
 * it, and the timeout keeps a surface that never repaints (a paused video in a
 * still page presents nothing) from hanging the dialog forever.
 */
function presentedFrame(video: HTMLVideoElement): Promise<void> {
  const rvfc = (
    video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
  ).requestVideoFrameCallback;

  const presented =
    typeof rvfc === "function"
      ? new Promise<void>((resolve) => {
          rvfc.call(video, () => resolve());
          setTimeout(resolve, 600);
        })
      : Promise.resolve();

  return presented.then(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/**
 * True-resolution grab of whatever the user shares (prompt defaults to this
 * tab where the browser supports `preferCurrentTab`). The track is stopped the
 * moment a single frame has been read.
 */
/**
 * A frame with no tonal range at all is the capture pipeline not having caught
 * up — the surface opens before it has composited anything. Worth one more
 * frame rather than handing the user a black rectangle.
 */
function frameLooksBlank(
  video: HTMLVideoElement,
  crop: { x: number; y: number; width: number; height: number },
): boolean {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 18;
  const ctx = probe.getContext("2d");
  if (!ctx) return false;
  try {
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    return max - min < 6;
  } catch {
    return false;
  }
}

async function captureHd(opts: CaptureOptions): Promise<CaptureResult> {
  if (!isHdCaptureSupported()) {
    throw new CaptureError("unsupported", "this browser cannot capture the screen");
  }

  const constraints: DisplayMediaConstraints = {
    preferCurrentTab: true,
    video: { frameRate: { ideal: 30 } },
    audio: false,
  };

  // Before the surface is opened, not after: the picker is modal browser UI,
  // so the page has the whole of the user's deliberation to repaint cleanly
  // and the very first captured frame is already free of our own dialog.
  opts.onCapturing?.(true);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (e) {
    opts.onCapturing?.(false);
    throw asCaptureError(e);
  }

  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new CaptureError("no-track", "the shared surface has no video track");

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await presentedFrame(video);

    const width = video.videoWidth || track.getSettings().width || 1280;
    const height = video.videoHeight || track.getSettings().height || 720;

    // A tab capture is the viewport, 1:1 with CSS pixels after scaling, so the
    // player's bounding box can be mapped straight onto it. Any other surface
    // (a whole screen or another window) has browser chrome and desktop
    // offsets in the way, so there is no honest mapping and the full frame is
    // returned instead of a confidently wrong crop.
    const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string })
      .displaySurface;
    let crop = { x: 0, y: 0, width, height };
    let cropped = false;

    if (surface === "browser" && opts.cropSelector) {
      const el = document.querySelector(opts.cropSelector);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        const scale = width / window.innerWidth;
        const x = Math.max(0, Math.round(r.left * scale));
        const y = Math.max(0, Math.round(r.top * scale));
        crop = {
          x,
          y,
          width: Math.min(width - x, Math.round(r.width * scale)),
          height: Math.min(height - y, Math.round(r.height * scale)),
        };
        cropped = true;
      }
    }

    // The first frame off a freshly opened surface is routinely empty. Spend
    // a few frames waiting rather than returning a black rectangle.
    for (let i = 0; i < 5 && frameLooksBlank(video, crop); i += 1) {
      await presentedFrame(video);
    }

    const note = !cropped
      ? surface === "browser"
        ? "Could not locate the player on the page, so this is the whole tab."
        : "You shared a whole screen or window, so this is everything that was shared. Choose the tab itself for just the video."
      : undefined;

    const result = await compose(video, crop, opts, {
      // The frame on the compositor is the one from *now*, which is seconds
      // after the dialog was opened if the prompt sat waiting.
      at: opts.getTime?.() ?? opts.time,
      source: "display",
      ...(note ? { note } : {}),
    });
    video.pause();
    video.srcObject = null;
    return {
      ...result,
      cropped,
      ...(surface ? { surface } : {}),
    };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    opts.onCapturing?.(false);
  }
}

export async function capture(tier: CaptureTier, opts: CaptureOptions): Promise<CaptureResult> {
  return tier === "hd" ? captureHd(opts) : captureQuick(opts);
}

/** `My Video - 12-34.png`, safe on every filesystem. */
export function frameFileName(title: string | undefined, at: number): string {
  const stamp = (fmtDuration(Math.round(at)) || "0-00").replace(/:/g, "-");
  const base = (title || "frame")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${base || "frame"} - ${stamp}.png`;
}

export async function downloadCapture(result: CaptureResult, fileName: string): Promise<void> {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke on the next tick so Safari has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyCapture(result: CaptureResult): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("clipboard images unsupported");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": result.blob })]);
}

export function canShareCapture(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export async function shareCapture(result: CaptureResult, fileName: string, title?: string) {
  const file = new File([result.blob], fileName, { type: "image/png" });
  const data: ShareData = { files: [file], title };
  if (navigator.canShare && !navigator.canShare(data)) {
    throw new Error("sharing this file is not supported");
  }
  await navigator.share(data);
}
