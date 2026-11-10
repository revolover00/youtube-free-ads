import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  Download,
  Loader2,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import {
  canShareCapture,
  capture,
  copyCapture,
  downloadCapture,
  frameFileName,
  isHdCaptureSupported,
  shareCapture,
  type CaptureResult,
  type CaptureTier,
} from "../lib/frame";
import { fmtDuration } from "../lib/format";
import { useLanguage } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  videoId: string;
  /** Playback position when the dialog was opened. */
  time: number;
  title?: string;
  channel?: string;
  notify: (m: string) => void;
}

/**
 * Whether to reach for the screen-capture path first.
 *
 * YouTube answers `youtubei/v1/player` with a bot check ("LOGIN_REQUIRED") for
 * most videos when the caller is a datacentre IP, which is every request our
 * server makes. Measured against the live deployment, four of four real feed
 * videos came back with no storyboard at all — so the server path silently
 * degrades to the poster and the user gets the thumbnail instead of the frame
 * they were looking at. `getDisplayMedia` reads the already-decoded frame off
 * the compositor, so it cannot be rate-limited or bot-gated, and it is the
 * only path that returns the actual moment on screen.
 *
 * Remembered per browser: dismissing the share prompt turns it off so nobody
 * is nagged twice, and picking "HD" explicitly turns it back on.
 */
const HD_FIRST_KEY = "yt:screenshot-hd-first";

function prefersHdFirst(): boolean {
  try {
    return localStorage.getItem(HD_FIRST_KEY) !== "0";
  } catch {
    return true;
  }
}

function setPrefersHdFirst(on: boolean): void {
  try {
    localStorage.setItem(HD_FIRST_KEY, on ? "1" : "0");
  } catch {
    /* private mode — fall back to the in-memory default */
  }
}

/**
 * Preview + export surface for an in-page frame grab.
 *
 * Deliberately built out of the same tokens as the rest of the app
 * (`yt-raised` surface, 36px pills, 12px radii) so it reads as part of the
 * player chrome rather than a bolted-on modal.
 */
export default function ScreenshotDialog({
  open,
  onClose,
  videoId,
  time,
  title,
  channel,
  notify,
}: Props) {
  const { t, isAr } = useLanguage();
  const [tier, setTier] = useState<CaptureTier>("quick");
  const [captionCard, setCaptionCard] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const run = useCallback(
    async (nextTier: CaptureTier, nextCard: boolean) => {
      setBusy(true);
      setFailed(null);
      const opts = {
        videoId,
        time,
        title,
        channel,
        captionCard: nextCard,
        // The player is rendered once at the app root and moved around, so
        // this is the element the HD path crops a tab capture down to.
        cropSelector: "#persistent-player",
      };
      try {
        setResult(await capture(nextTier, opts));
      } catch (e) {
        const declined = e instanceof DOMException && e.name === "NotAllowedError";
        if (nextTier === "hd") {
          // Dismissing the share prompt must not leave an empty dialog — drop
          // to the server frame, and stop opening the prompt automatically.
          if (declined) setPrefersHdFirst(false);
          setTier("quick");
          try {
            setResult(await capture("quick", opts));
          } catch (inner) {
            setFailed(inner instanceof Error ? inner.message : String(inner));
          }
        } else if (!declined) {
          setFailed(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [videoId, time, title, channel],
  );

  // Capture once per opening; re-run only when a knob actually changes.
  // Opening the dialog came from a click, so the screen-capture prompt still
  // has transient activation here.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopied(false);
    setCaptionCard(false);
    const startTier: CaptureTier = isHdCaptureSupported() && prefersHdFirst() ? "hd" : "quick";
    setTier(startTier);
    void run(startTier, false);
  }, [open, run]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const fileName = frameFileName(title, result?.at ?? time);
  const hdAvailable = isHdCaptureSupported();

  const onPickTier = (next: CaptureTier) => {
    if (next === tier || busy) return;
    // An explicit pick is also a standing preference for the next capture.
    setPrefersHdFirst(next === "hd");
    setTier(next);
    void run(next, captionCard);
  };

  const onToggleCard = () => {
    if (busy) return;
    const next = !captionCard;
    setCaptionCard(next);
    void run(tier, next);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("screenshotTitle")}
        className="w-full max-w-[720px] max-h-[92vh] overflow-y-auto rounded-xl bg-yt-raised text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.5)] shadow-black/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <h2 className="flex items-center gap-2 text-[17px] font-medium">
            <Camera className="h-5 w-5 shrink-0" />
            {t("screenshotTitle")}
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label={t("close")}
            className="grid h-10 w-10 place-items-center rounded-full hover:bg-yt-surface"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 pb-1">
          <div className="relative grid min-h-[200px] place-items-center overflow-hidden rounded-xl bg-black">
            {result ? (
              <img
                src={result.dataUrl}
                alt={t("screenshotTitle")}
                className="h-auto w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 py-16 text-yt-sub">
                {busy ? (
                  <>
                    <Loader2 className="h-7 w-7 animate-spin" />
                    <span className="text-sm">{t("screenshotWorking")}</span>
                  </>
                ) : (
                  <span className="px-6 text-center text-sm">
                    {failed ? t("screenshotFailed") : t("screenshotHint")}
                  </span>
                )}
              </div>
            )}

            {busy && result && (
              <div className="absolute inset-0 grid place-items-center bg-black/50">
                <Loader2 className="h-7 w-7 animate-spin text-white" />
              </div>
            )}
          </div>

          {/*
            When the storyboard fetch fails we fall back to the video poster.
            That still produces an image, so without a clear notice it looks
            like a successful capture of the wrong moment — worse than an error.
          */}
          {result?.source === "poster" && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-[#3a2e00] px-3 py-2 text-[13px] leading-[18px] text-[#ffd95c]">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span className="min-w-0">
                {t("screenshotSourcePoster")}
                {/* The server reports why it had to substitute the poster;
                    without it a failure is indistinguishable from "this video
                    just has no storyboard". */}
                {result.note && <span className="block opacity-70">{result.note}</span>}
                {/* The poster is never what was asked for, so offer the one
                    path that cannot be refused by YouTube. */}
                {hdAvailable && (
                  <button
                    type="button"
                    onClick={() => onPickTier("hd")}
                    disabled={busy}
                    className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-[#ffd95c] px-3 text-[13px] font-medium text-[#3a2e00] hover:bg-[#ffe484] disabled:opacity-50"
                  >
                    <Camera className="h-4 w-4" />
                    {isAr ? "التقط الإطار الحقيقي" : "Capture the real frame"}
                  </button>
                )}
              </span>
            </div>
          )}

          <p className="mt-2.5 text-[13px] text-yt-sub">
            {result ? (
              <>
                {fmtDuration(Math.round(result.at)) || "0:00"}
                {" · "}
                {result.nativeWidth}×{result.nativeHeight}
              </>
            ) : (
              t("screenshotHint")
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <div className="flex h-9 items-center rounded-full bg-yt-surface p-0.5">
            {(["quick", "hd"] as const).map((k) => (
              <button
                key={k}
                onClick={() => onPickTier(k)}
                disabled={k === "hd" && !hdAvailable}
                title={k === "hd" ? t("screenshotHdHint") : undefined}
                className={`h-8 rounded-full px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  tier === k ? "bg-yt-text text-yt-bg" : "text-yt-text hover:bg-yt-hover"
                }`}
              >
                {k === "quick" ? t("screenshotQuick") : t("screenshotHd")}
              </button>
            ))}
          </div>

          <button
            onClick={onToggleCard}
            className={`flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors ${
              captionCard ? "bg-yt-text text-yt-bg" : "bg-yt-surface text-yt-text hover:bg-yt-hover"
            }`}
          >
            <Sparkles className="h-4 w-4" />
            {t("screenshotWatermark")}
          </button>

          <span className="flex-1" />

          {canShareCapture() && (
            <button
              disabled={!result || busy}
              onClick={() => {
                if (!result) return;
                shareCapture(result, fileName, title).catch(() => {});
              }}
              className="flex h-9 items-center gap-2 rounded-full bg-yt-surface px-3.5 text-sm font-medium hover:bg-yt-hover disabled:opacity-40"
            >
              <Share2 className="h-4 w-4" />
              <span className="hidden sm:inline">{t("screenshotShare")}</span>
            </button>
          )}

          <button
            disabled={!result || busy}
            onClick={() => {
              if (!result) return;
              copyCapture(result)
                .then(() => {
                  setCopied(true);
                  notify(t("screenshotCopied"));
                  setTimeout(() => setCopied(false), 1800);
                })
                .catch(() => notify(t("screenshotFailed")));
            }}
            className="flex h-9 items-center gap-2 rounded-full bg-yt-surface px-3.5 text-sm font-medium hover:bg-yt-hover disabled:opacity-40"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="hidden sm:inline">{t("screenshotCopy")}</span>
          </button>

          <button
            disabled={!result || busy}
            onClick={() => {
              if (!result) return;
              void downloadCapture(result, fileName);
            }}
            className="flex h-9 items-center gap-2 rounded-full bg-yt-text px-4 text-sm font-medium text-yt-bg hover:bg-white disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            {t("screenshotDownload")}
          </button>
        </div>

        {tier === "hd" && (
          <p className="px-5 pb-4 text-[12px] text-yt-sub">
            {isAr ? "ℹ︎ " : "ℹ "}
            {t("screenshotHdHint")}
          </p>
        )}
      </div>
    </div>
  );
}
