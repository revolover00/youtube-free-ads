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
  meta: { at: number; source: CaptureSource },
): Promise<CaptureResult> {
  const aspect = crop.height / crop.width;
  const frameW = Math.max(crop.width, TARGET_WIDTH);
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
  };
}

/** Server-resolved storyboard tile — instant, no permission prompt. */
async function captureQuick(opts: CaptureOptions): Promise<CaptureResult> {
  const frame = await captureFrame(opts.videoId, opts.time);
  const img = await loadImage(frame.sheet);
  return compose(img, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, opts, {
    at: frame.at,
    source: frame.source,
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
 * True-resolution grab of whatever the user shares (prompt defaults to this
 * tab where the browser supports `preferCurrentTab`). The track is stopped the
 * moment a single frame has been read.
 */
async function captureHd(opts: CaptureOptions): Promise<CaptureResult> {
  if (!isHdCaptureSupported()) throw new Error("display capture unsupported");

  const constraints: DisplayMediaConstraints = {
    preferCurrentTab: true,
    video: { frameRate: { ideal: 30 } },
    audio: false,
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("no video track in the shared surface");

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // one compositor tick so the first frame is actually painted
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const width = video.videoWidth || track.getSettings().width || 1280;
    const height = video.videoHeight || track.getSettings().height || 720;

    const result = await compose(video, { x: 0, y: 0, width, height }, opts, {
      at: opts.time,
      source: "display",
    });
    video.pause();
    video.srcObject = null;
    return result;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
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
