import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Copy, Download, Loader2, Share2, Sparkles, X } from "lucide-react";
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
      try {
        const r = await capture(nextTier, {
          videoId,
          time,
          title,
          channel,
          captionCard: nextCard,
        });
        setResult(r);
      } catch (e) {
        // A declined share prompt is a user choice, not a failure to report.
        const aborted = e instanceof DOMException && e.name === "NotAllowedError";
        if (!aborted) setFailed(e instanceof Error ? e.message : String(e));
        if (nextTier === "hd") setTier("quick");
      } finally {
        setBusy(false);
      }
    },
    [videoId, time, title, channel],
  );

  // Capture once per opening; re-run only when a knob actually changes.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopied(false);
    setTier("quick");
    setCaptionCard(false);
    void run("quick", false);
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
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("screenshotTitle")}
        className="w-full max-w-[720px] max-h-[92vh] overflow-y-auto rounded-xl bg-yt-raised text-yt-text shadow-2xl shadow-black/70"
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

          <p className="mt-2.5 text-[13px] text-yt-sub">
            {result ? (
              <>
                {fmtDuration(Math.round(result.at)) || "0:00"}
                {" · "}
                {result.nativeWidth}×{result.nativeHeight}
                {result.source === "poster" && ` · ${t("screenshotSourcePoster")}`}
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
