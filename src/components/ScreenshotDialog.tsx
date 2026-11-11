import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  Download,
  Loader2,
  RotateCw,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import {
  asCaptureError,
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
import { enterShotMode } from "../lib/shotMode";
import { useLanguage } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  videoId: string;
  /** Playback position when the dialog was opened. */
  time: number;
  title?: string;
  channel?: string;
  /**
   * Live playback position. The share prompt can sit open for seconds, so the
   * frame that gets photographed is not the one `time` was pinned to.
   */
  getTime?: () => number;
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
 * Opening that prompt unannounced is the whole problem: a share-your-screen
 * request nobody asked for gets dismissed on reflex, and the dismissal used to
 * be remembered forever, which left the poster as the permanent result. So the
 * prompt is only opened automatically once it has actually worked in this
 * browser; before that the dialog explains what is about to happen and waits
 * for a deliberate click. A refusal is never held against the user.
 */
const HD_OK_KEY = "yt:screenshot-hd-ok";

function hdHasWorked(): boolean {
  try {
    return localStorage.getItem(HD_OK_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberHdWorked(): void {
  try {
    localStorage.setItem(HD_OK_KEY, "1");
  } catch {
    /* private mode — just prompt again next time */
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
  getTime,
  notify,
}: Props) {
  const { t, isAr } = useLanguage();
  const [tier, setTier] = useState<CaptureTier>("quick");
  const [captionCard, setCaptionCard] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** Why the screen grab did not happen, shown verbatim so it is diagnosable. */
  const [hdNotice, setHdNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /*
    The cover image is only ever shown because the user asked for it by name,
    never as the answer to "capture this moment".
  */
  const [posterAccepted, setPosterAccepted] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Read through a ref so an unstable prop can never re-run the capture
  // effect — that would re-open the browser's share prompt.
  const getTimeRef = useRef(getTime);
  useEffect(() => {
    getTimeRef.current = getTime;
  }, [getTime]);

  const run = useCallback(
    async (nextTier: CaptureTier, nextCard: boolean) => {
      setBusy(true);
      setFailed(null);
      setPosterAccepted(false);
      const opts = {
        videoId,
        time,
        title,
        channel,
        captionCard: nextCard,
        // The player is rendered once at the app root and moved around, so
        // this is the element the HD path crops a tab capture down to.
        cropSelector: "#persistent-player",
        getTime: () => getTimeRef.current?.() ?? time,
        // This dialog is a full-viewport scrim with a panel in the middle of
        // it, painted over the player at z-120. A tab capture photographs the
        // live page, so it would photograph *this*. Stepping aside is done
        // imperatively because a state round-trip is not guaranteed to have
        // painted before the frame is read.
        onCapturing: (capturing: boolean) => {
          const el = rootRef.current;
          if (el) el.style.visibility = capturing ? "hidden" : "";
        },
      };
      try {
        const shot = await capture(nextTier, opts);
        setResult(shot);
        setHdNotice(null);
        // Only a real screen grab proves the prompt works here; once it does,
        // stop making the user ask for it.
        if (shot.source === "display") rememberHdWorked();
      } catch (e) {
        const err = asCaptureError(e);
        if (nextTier === "hd") {
          // Say precisely what went wrong. A silent drop to the server frame
          // is indistinguishable from "the screenshot feature is broken".
          setHdNotice(
            err.code === "declined"
              ? isAr
                ? "تم إلغاء مشاركة الصفحة، فعُرض الإطار القادم من الخادم بدلًا منها."
                : "Sharing was cancelled, so the server frame is shown instead."
              : isAr
                ? `تعذّرت قراءة الصفحة (${err.message}).`
                : `Could not read the page (${err.message}).`,
          );
          setTier("quick");
          try {
            setResult(await capture("quick", opts));
          } catch (inner) {
            setFailed(asCaptureError(inner).message);
          }
        } else {
          setFailed(err.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [videoId, time, title, channel, isAr],
  );

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  // Capture once per opening. Opening the dialog came from a click, so the
  // screen-capture prompt still has transient activation here.
  //
  // Keyed on `open` alone, on purpose: every other dependency (the playback
  // position in particular) changes while the dialog is up, and re-running
  // this would re-open the browser's share prompt behind the user's back.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopied(false);
    setPosterAccepted(false);
    setCaptionCard(false);
    setHdNotice(null);
    const canHd = isHdCaptureSupported();
    const startTier: CaptureTier = canHd ? "hd" : "quick";
    setTier(startTier);

    // Where the real frame is reachable, do not open with the storyboard.
    // That tile is 160×90 and sits on a 2–10 second grid, so leading with it
    // presents an approximation as though it were the answer — which is
    // exactly the complaint it generates. Offer the true route first and make
    // the rough preview an explicit choice.
    //
    // A phone has a true route too: its own screenshot button, via shot mode.
    // Applying this rule only where getDisplayMedia exists is what kept
    // opening every phone directly onto a 160×90 scrubber tile, which is the
    // rotten picture this feature keeps being judged by.
    if (!canHd || !hdHasWorked()) return;

    void runRef.current(startTier, false);
  }, [open]);

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

  /*
    The poster is the video's cover image, so at any timestamp past the opening
    seconds it is simply the wrong picture.

    This used to be withheld only where screen capture could replace it, which
    left every phone — no getDisplayMedia anywhere on mobile — still being
    handed a cover image as "your frame" at 56 minutes in. A wrong picture is
    not a better answer than no picture on any device, so now it is withheld
    everywhere and only ever appears if the user asks for it by name.
  */
  const posterIsUseless = result?.source === "poster" && !posterAccepted;

  const onPickTier = (next: CaptureTier) => {
    if (next === tier || busy) return;
    setTier(next);
    void run(next, captionCard);
  };

  /** The one-click path to a true frame, usable even when "HD" is current. */
  const runHd = () => {
    if (busy) return;
    setTier("hd");
    void run("hd", captionCard);
  };

  /*
    On a phone this is the only path that ends in the real frame: no mobile
    browser has screen capture, YouTube refuses the server every frame source,
    and the embed's pixels are cross-origin. The phone's own screenshot button
    still works perfectly -- it just needs our interface out of the picture.
  */
  const prepareForPhoneShot = () => {
    const at = getTimeRef.current?.() ?? time;
    onClose();
    void enterShotMode(videoId, at, {
      dir: isAr ? "rtl" : "ltr",
      preparing: isAr
        ? "بحضّر نسخة نضيفة من غير أزرار يوتيوب، وبأعلى جودة…"
        : "Loading a clean copy with no YouTube controls, at the best quality…",
      ready: (size: string) =>
        isAr
          ? `جاهز على اللحظة دي${size ? ` — الإطار ${size}، وديه أعلى جودة في الفيديو نفسه` : ""}. خد لقطة شاشة دلوقتي، وبعدين دوس في أي حتة ترجع.`
          : `Ready, paused on your moment${size ? ` — the frame is ${size}, which is all the video itself carries` : ""}. Take a screenshot now, then tap anywhere to go back.`,
      rotate: isAr
        ? "لفّ التليفون بالعرض علشان ياخد الإطار بمقاسه الكامل."
        : "Turn the phone sideways so there is room for the frame at full size.",
    });
  };

  /** The rough-but-instant preview, now that it is never forced on anyone. */
  const runQuick = () => {
    if (busy) return;
    setHdNotice(null);
    setTier("quick");
    void run("quick", captionCard);
  };

  const onToggleCard = () => {
    if (busy) return;
    const next = !captionCard;
    setCaptionCard(next);
    void run(tier, next);
  };

  return (
    <div
      ref={rootRef}
      data-screenshot-overlay=""
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
            {result && !posterIsUseless ? (
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
                    {posterIsUseless
                      ? hdAvailable
                        ? isAr
                          ? "يوتيوب مش بيدّي السيرفر اللحظة دي، واللي عنده صورة الغلاف بس — ودي مش اللقطة اللي إنت عايزها. التقطها من شاشتك بالزر اللي تحت."
                          : "YouTube will not give the server this moment — only the cover image, which is not the frame you want. Grab it from your own screen with the button below."
                        : isAr
                          ? "يوتيوب رفض يدّي السيرفر اللحظة دي. على التليفون لسه فيه طريقة تجيبها بدقة كاملة — تحت."
                          : "YouTube refused the server this moment. On a phone there is still a way to get it at full resolution — below."
                      : failed
                        ? t("screenshotFailed")
                        : // Nothing has been fetched yet. On a desktop the
                          // capture button below can still deliver the moment,
                          // so promising it is honest. On a phone it cannot,
                          // and the promise would sit directly above a card
                          // explaining exactly that.
                          !hdAvailable
                          ? isAr
                            ? "اللقطة دي بتتاخد من زرار التليفون نفسه — الخطوات تحت."
                            : "This one is taken with the phone's own button — the steps are below."
                          : t("screenshotHint")}
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
          {result?.source === "poster" && !posterIsUseless && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-[#3a2e00] px-3 py-2 text-[13px] leading-[18px] text-[#ffd95c]">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span className="min-w-0">
                {t("screenshotSourcePoster")}
                {/* The server reports why it had to substitute the poster;
                    without it a failure is indistinguishable from "this video
                    just has no storyboard". */}
                {result.note && <span className="block opacity-70">{result.note}</span>}
              </span>
            </div>
          )}

          {/*
            The storyboard is YouTube's own scrubbing strip, not a frame of the
            video: the largest tile it publishes is about 160×90 and the tiles
            sit on a 2–10 second grid. Handing that over unlabelled reads as a
            broken screenshot, when it is really the best the server is allowed
            to see.
          */}
          {result?.source === "storyboard" && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-yt-surface px-3 py-2 text-[13px] leading-[18px] text-yt-sub">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span className="min-w-0">
                {isAr
                  ? "دي معاينة من شريط التمرير بتاع يوتيوب: أكبر مقاس متاح حوالي 160×90، واللقطات كل ٢ إلى ١٠ ثواني — فهي قريبة من اللحظة مش هي بالظبط."
                  : "This comes from YouTube's scrubbing strip: about 160×90 at best, on a 2–10 second grid — close to your moment, not exactly it."}
              </span>
            </div>
          )}

          {/* The user shared a whole screen or window, so the frame is not the
              player. Saying so beats handing them their desktop in silence. */}
          {result?.source === "display" && result.cropped === false && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-[#3a2e00] px-3 py-2 text-[13px] leading-[18px] text-[#ffd95c]">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span className="min-w-0">
                {isAr
                  ? "شاركت شاشة أو نافذة كاملة، فاللقطة هي كل ما شاركته. اختر «علامة التبويب هذه» للحصول على الفيديو وحده."
                  : "You shared a whole screen or window, so this is all of it. Choose “This tab” to get just the video."}
              </span>
            </div>
          )}

          {/*
            With no screen capture on the device there is nothing true left to
            offer, so the only honest move is to stop and say so. The cover
            image is still one deliberate tap away — named as the cover image,
            never as the moment — so the dialog ends in a choice rather than a
            dead end.
          */}
          {/*
            A phone cannot be given the frame by this app -- measured, not
            assumed; the reasoning is in src/lib/shotMode.ts. It can still get
            the frame, at full screen resolution, from the screenshot button
            it already has. So that is what this leads with, instead of an
            apology with nothing behind it.

            It used to render only when the server fell back to the poster, so
            on every video whose storyboard did come through, the phone was
            shown a 160×90 tile and never told that a real frame was one tap
            away. The route out is offered whatever the server returned --
            only a true screen grab retires it.
          */}
          {!hdAvailable && result?.source !== "display" && (
            <div className="mt-2.5 rounded-lg bg-yt-surface px-3 py-2.5">
              <p className="text-[13px] font-medium leading-[18px] text-yt-text">
                {isAr
                  ? "على التليفون، اللقطة بتتاخد من زراير التليفون نفسه"
                  : "On a phone, the shot comes from the phone's own buttons"}
              </p>
              <p className="mt-1 text-[12px] leading-[17px] text-yt-sub">
                {isAr
                  ? "هفتح نسخة من الفيديو من غير شريط تحكم ولا زرار تشغيل فوق الصورة، بأعلى جودة، وأوقّفها على اللحظة دي وأعرضها بمقاسها الأصلي من غير تكبير يبوّظها. ساعتها خد لقطة شاشة عادي."
                  : "A copy of the video opens with no control bar and no play button over the frame, at the best quality, paused on this moment and shown at its true size — no upscaling to soften it. Then take a screenshot as usual."}
              </p>
              <button
                type="button"
                onClick={prepareForPhoneShot}
                className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-yt-text px-4 text-[13px] font-medium text-yt-bg hover:bg-white"
              >
                <Camera className="h-4 w-4" />
                {isAr ? "جهّز الشاشة للقطة" : "Set up the shot"}
              </button>
              <div className="mt-2.5 border-t border-yt-border pt-2.5">
                <p className="text-[12px] leading-[17px] text-yt-sub">
                  {result
                    ? isAr
                      ? "أو جرّب السيرفر تاني — كل محاولة بتفتح جلسة يوتيوب جديدة، فساعات بتعدّي."
                      : "Or try the server again — each attempt opens a fresh YouTube session, so it sometimes gets through."
                    : isAr
                      ? "أو خد المعاينة السريعة من شريط التمرير: بتيجي في ثانية، بس مقاسها 160×90 وقريبة من اللحظة مش هي بالظبط."
                      : "Or take the quick scrubber preview: it arrives in a second, but it is 160×90 and close to your moment rather than exactly it."}
                </p>
                {/*
                  Without this a phone had no retry at all: the only one lived
                  inside the screen-capture card, which a phone never renders.
                  Before anything has been fetched the same button is the
                  opt-in to the rough preview, named for what it really is so
                  that choosing it is a decision rather than a surprise.
                */}
                <button
                  type="button"
                  onClick={runQuick}
                  disabled={busy}
                  className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-yt-sub hover:bg-yt-hover hover:text-yt-text disabled:opacity-50"
                >
                  <RotateCw className="h-4 w-4" />
                  {result
                    ? isAr
                      ? "حاول تاني"
                      : "Try again"
                    : isAr
                      ? "معاينة تقريبية بدل كده"
                      : "Rough preview instead"}
                </button>
                {/*
                  Only meaningful once the server has actually fallen back to
                  the cover image. Offering it before anything was fetched
                  advertises a failure that has not happened.
                */}
                {result?.source === "poster" && !posterAccepted && (
                  <button
                    type="button"
                    onClick={() => setPosterAccepted(true)}
                    disabled={busy}
                    className="mt-2 ms-1 inline-flex h-9 items-center rounded-full px-3 text-[13px] text-yt-sub hover:bg-yt-hover hover:text-yt-text disabled:opacity-50"
                  >
                    {isAr ? "اعرض صورة الغلاف بدل كده" : "Show the cover image instead"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/*
            Everything except a real screen grab is a guess at the moment the
            user is looking at: the server storyboard is the right frame only
            when YouTube answers us at all, and the poster never is. So
            whenever the image on screen is not a true capture, offer the one
            path that always is — and say plainly what the browser will ask,
            because an unexplained "share your screen" prompt gets dismissed on
            reflex and that dismissal is what made this look broken.
          */}
          {hdAvailable && result?.source !== "display" && (
            <div className="mt-2.5 rounded-lg bg-yt-surface px-3 py-2.5">
              <p className="text-[13px] font-medium leading-[18px] text-yt-text">
                {isAr
                  ? "عايز الإطار اللي واقف عنده بالظبط؟"
                  : "Want the exact frame you are paused on?"}
              </p>
              <p className="mt-1 text-[12px] leading-[17px] text-yt-sub">
                {isAr
                  ? "اضغط الزر، وهيظهر طلب من المتصفح: اختر «علامة التبويب هذه» ثم «مشاركة». تُقرأ لقطة واحدة وتتوقف المشاركة فورًا — لا يُسجَّل أي شيء."
                  : "Press the button and the browser will ask: choose “This tab”, then “Share”. One frame is read and sharing stops immediately — nothing is recorded."}
              </p>
              <button
                type="button"
                onClick={runHd}
                disabled={busy}
                className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-yt-text px-4 text-[13px] font-medium text-yt-bg hover:bg-white disabled:opacity-50"
              >
                <Camera className="h-4 w-4" />
                {isAr ? "التقط الإطار الحقيقي" : "Capture the real frame"}
              </button>
              {/* Without this the no-image state is a dead end for anyone who
                  does not want to share a tab at all. */}
              {!result && (
                <button
                  type="button"
                  onClick={runQuick}
                  disabled={busy}
                  className="mt-2 ms-2 inline-flex h-9 items-center rounded-full px-3 text-[13px] text-yt-sub hover:bg-yt-hover hover:text-yt-text disabled:opacity-50"
                >
                  {isAr ? "معاينة تقريبية بدل كده" : "Rough preview instead"}
                </button>
              )}
              {hdNotice && (
                <p className="mt-2 text-[12px] leading-[17px] text-[#ff8a80]">{hdNotice}</p>
              )}
            </div>
          )}

          {/*
            "Captured from the moment you are watching" is a promise about what
            is coming. Once we have had to say the moment is unreachable it
            becomes a flat contradiction sitting directly under the apology, so
            it is dropped rather than restated. Same on a phone before anything
            is fetched: the card above has just explained that this app cannot
            hand over the frame, and promising it underneath reads as a lie.
          */}
          {!posterIsUseless && (result || hdAvailable) && (
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
          )}
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
              disabled={!result || posterIsUseless || busy}
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
            disabled={!result || posterIsUseless || busy}
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
            disabled={!result || posterIsUseless || busy}
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
