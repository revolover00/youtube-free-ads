import { useEffect, useRef, useMemo, useState } from "react";
import { useAppStore } from "../lib/appStore";
import { useLanguage } from "../lib/i18n";
import {
  DEFAULT_EMBED_HOST,
  embedIsUnreachable,
  forgetReach,
  pickEmbedHost,
  probeReach,
  reachReport,
  rememberEmbedHost,
  storedEmbedHost,
  type EmbedHost,
  type ReachReport,
} from "../lib/reach";

interface Props {
  videoId: string;
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  className?: string;
  title?: string;
  startTime?: number;
  onTimeUpdate?: (currentTime: number) => void;
  onEnded?: () => void;
}

/**
 * Clean, Genuine YouTube Player
 * Directly uses YouTube's official player engine and UI controls
 * Ensures 100% authenticity, zero duplicate layers, and zero sync bugs.
 */
export default function YouTubePlayer({
  videoId,
  autoplay = false,
  muted = false,
  loop = false,
  controls = true,
  className = "w-full h-full",
  title = "مشغّل الفيديو",
  startTime,
  onTimeUpdate,
  onEnded,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { backgroundPlay, preferredQuality } = useAppStore();
  const { lang, t, isAr } = useLanguage();

  /*
    Which YouTube hostname this network is willing to reach. Both hosts serve
    the identical player, and filters routinely carry only the obvious name,
    so this is the difference between a black rectangle and a video. See
    src/lib/reach.ts for what is measured and why.
  */
  const [host, setHost] = useState<EmbedHost>(() => storedEmbedHost() ?? DEFAULT_EMBED_HOST);
  const [reach, setReach] = useState<ReachReport | null>(null);
  const [announceHost, setAnnounceHost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reprobing, setReprobing] = useState(false);
  const hostRef = useRef(host);
  const reachRef = useRef<ReachReport | null>(null);
  const sawPlayerRef = useRef(false);
  const triedFallbackRef = useRef(false);

  const switchHost = (next: EmbedHost, announce: boolean) => {
    hostRef.current = next;
    setHost(next);
    setAnnounceHost(announce);
  };

  const initialStartTime = useRef<{ id: string; time: number | undefined }>({
    id: videoId,
    time: startTime,
  });

  if (initialStartTime.current.id !== videoId) {
    initialStartTime.current = { id: videoId, time: startTime };
  }

  // Handle postMessage to receive playback progress from YouTube JS API
  useEffect(() => {
    const handleMsg = (e: MessageEvent) => {
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (!data) return;

        /*
          Proof that the embed actually booted, which a reachability probe
          cannot give us: a filter that answers with a block page instead of
          dropping the connection looks perfectly reachable. Only our own
          iframe counts -- shot mode runs a second player, and the harness
          simulates progress from the page itself.
        */
        if (e.source && e.source === iframeRef.current?.contentWindow) {
          sawPlayerRef.current = true;
          // A host is only worth remembering once it has spoken to us.
          if (hostRef.current !== DEFAULT_EMBED_HOST) rememberEmbedHost(hostRef.current);
        }

        if (data.event === "infoDelivery" && data.info) {
          const info = data.info;
          if (typeof info.currentTime === "number") {
            onTimeUpdate?.(info.currentTime);
          }
          if (info.playerState === 0) {
            onEnded?.();
          }
          window.dispatchEvent(new CustomEvent("yt:player-info", { detail: info }));
        } else if (data.event === "onStateChange") {
          if (data.info === 0 || data.data === 0 || data.playerState === 0) {
            onEnded?.();
          }
        }
      } catch {
        // Ignore non-json messages
      }
    };

    window.addEventListener("message", handleMsg);
    return () => window.removeEventListener("message", handleMsg);
  }, [onTimeUpdate, onEnded]);

  /*
    Measure the network once per session and move the player to whichever
    host answers. Nothing is guessed: an unmeasured host is never a reason to
    move, and if this origin itself is unreachable the whole measurement is
    discarded rather than blamed on a YouTube filter.
  */
  useEffect(() => {
    let alive = true;
    void reachReport(videoId).then((report) => {
      if (!alive) return;
      reachRef.current = report;
      setReach(report);
      const pick = pickEmbedHost(report);
      if (pick && pick !== hostRef.current) switchHost(pick, pick !== DEFAULT_EMBED_HOST);
    });
    return () => {
      alive = false;
    };
  }, [videoId, attempt]);

  /*
    Second line of detection. A network that answers blocked names with a
    block page probes as reachable, so silence from the player is the only
    remaining signal. The alternate host serves the identical player, so
    trying it costs a dead embed nothing -- and a live one is never touched,
    because a live one has been sending messages all along.
  */
  useEffect(() => {
    sawPlayerRef.current = false;
    const timer = window.setTimeout(() => {
      if (sawPlayerRef.current || triedFallbackRef.current) return;
      if (hostRef.current !== DEFAULT_EMBED_HOST) return;
      if (reachRef.current?.nocookie === "blocked") return;
      triedFallbackRef.current = true;
      switchHost("www.youtube-nocookie.com", true);
    }, 9000);
    return () => window.clearTimeout(timer);
  }, [videoId, host, attempt]);

  // The notice is for the moment of the switch, not for the whole session.
  useEffect(() => {
    if (!announceHost) return undefined;
    const timer = window.setTimeout(() => setAnnounceHost(false), 6000);
    return () => window.clearTimeout(timer);
  }, [announceHost]);

  // Activate YouTube JS API listening on load
  const handleIframeLoad = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        "*",
      );
    }
  };

  // Background play support: keep audio running if enabled.
  // NOTE: a cleanup returned from an event handler is thrown away by the DOM,
  // so the retry timers have to be owned by the effect itself.
  useEffect(() => {
    const timers: number[] = [];

    const play = () => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*",
      );
    };

    const handleVisibility = () => {
      if (!backgroundPlay) return;
      if (document.visibilityState !== "hidden") return;
      if (!iframeRef.current?.contentWindow) return;
      play();
      timers.push(window.setTimeout(play, 200), window.setTimeout(play, 600));
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [backgroundPlay]);

  // Media Session API for lock screen and system media keys
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || "فيديو",
      artist: t ? t("brandName") : "Youtubiy",
      artwork: [
        {
          src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          sizes: "480x360",
          type: "image/jpeg",
        },
        {
          src: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          sizes: "1280x720",
          type: "image/jpeg",
        },
      ],
    });

    navigator.mediaSession.setActionHandler("play", () => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*",
      );
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
        "*",
      );
    });

    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) {
        iframeRef.current?.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: "seekTo", args: [details.seekTime, true] }),
          "*",
        );
      }
    });

    return () => {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, [videoId, title, t]);

  // YouTube IFrame URL parameters
  const params = useMemo(() => {
    const p = new URLSearchParams({
      autoplay: autoplay ? "1" : "0",
      mute: muted ? "1" : "0",
      controls: controls ? "1" : "0",
      playsinline: "1",
      rel: "0",
      modestbranding: "1",
      hl: lang || "ar",
      origin: typeof window !== "undefined" ? window.location.origin : "",
      iv_load_policy: "3",
      disablekb: "0",
      fs: "1",
      enablejsapi: "1",
      widgetid: "1",
    });
    if (preferredQuality && preferredQuality !== "auto") {
      p.set("vq", preferredQuality);
    }
    if (initialStartTime.current.time && initialStartTime.current.time > 0) {
      p.set("start", String(Math.floor(initialStartTime.current.time)));
    }
    if (loop) {
      p.set("loop", "1");
      p.set("playlist", videoId);
    }
    return p;
  }, [videoId, autoplay, muted, controls, lang, loop, preferredQuality]);

  const blocked = embedIsUnreachable(reach);

  const retry = () => {
    if (reprobing) return;
    setReprobing(true);
    forgetReach();
    triedFallbackRef.current = false;
    void probeReach(videoId)
      .then((report) => {
        reachRef.current = report;
        setReach(report);
        const pick = pickEmbedHost(report);
        if (pick) switchHost(pick, pick !== DEFAULT_EMBED_HOST);
        // Remount the embed even when the host is unchanged: the point of a
        // retry is that the network may have changed under it.
        setAttempt((n) => n + 1);
      })
      .finally(() => setReprobing(false));
  };

  return (
    <div className={`relative bg-black overflow-hidden select-none ${className}`}>
      <iframe
        ref={iframeRef}
        key={`${videoId}-${autoplay}-${muted}-${host}-${attempt}`}
        className="w-full h-full border-0 pointer-events-auto"
        src={`https://${host}/embed/${videoId}?${params.toString()}`}
        title={title}
        loading="lazy"
        onLoad={handleIframeLoad}
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowFullScreen
      />

      {/*
        The switch already happened and the video is playing; this only says
        why the player came from somewhere else. It leaves on its own, and it
        never takes a tap away from the player.
      */}
      {announceHost && !blocked && (
        <div
          data-reach-notice
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1.5 text-[12px] leading-[17px] text-yt-text"
        >
          {isAr
            ? "يوتيوب متحجوب على الشبكة دي — بشغّله من نطاق يوتيوب التاني"
            : "YouTube is blocked on this network — playing from YouTube's other domain"}
        </div>
      )}

      {/*
        Both embed hosts are gone, so there is no player to show and no point
        pretending otherwise. What is left is naming the block precisely and
        handing over the fix that matches it: a DNS-level filter is the common
        shape of this, and it is the one the user can actually undo.
      */}
      {blocked && (
        <div
          data-reach-blocked
          dir={isAr ? "rtl" : "ltr"}
          className="absolute inset-0 grid place-items-center overflow-auto bg-yt-bg/95 px-4 py-5"
        >
          <div className="max-w-[460px] text-center">
            <p className="text-[15px] font-medium leading-[22px] text-yt-text">
              {isAr ? "الشبكة دي بتحجب يوتيوب نفسه" : "This network is blocking YouTube itself"}
            </p>
            <p className="mt-1.5 text-[13px] leading-[19px] text-yt-sub">
              {isAr
                ? "جرّبت النطاقين اللي بيشغّلوا الفيديو: youtube.com و youtube-nocookie.com — والاتنين مردّوش، والموقع ده نفسه شغّال عادي. يعني الحجب في الشبكة بتاعتك، مش في التطبيق."
                : "Both hosts that can play the video — youtube.com and youtube-nocookie.com — refused the connection, while this site itself loads fine. The block is on your network, not in this app."}
            </p>
            <div className="mt-3 rounded-lg bg-yt-surface px-3 py-2.5 text-start">
              <p className="text-[13px] font-medium leading-[18px] text-yt-text">
                {isAr
                  ? "أكتر حاجة بتحل ده: غيّر الـ DNS"
                  : "The fix that usually works: change your DNS"}
              </p>
              <p className="mt-1 text-[12px] leading-[17px] text-yt-sub">
                {isAr
                  ? "أغلب الحجب من ده بيكون على مستوى الـ DNS. على أندرويد: الإعدادات ← الشبكة ← Private DNS ← اكتب one.one.one.one. على ويندوز: إعدادات الشبكة ← DNS يدوي ← 1.1.1.1 و 1.0.0.1. لو الحجب على مستوى العنوان نفسه مش هيكفي، وساعتها محتاج VPN."
                  : "Most blocks of this shape are at the DNS level. On Android: Settings → Network → Private DNS → enter one.one.one.one. On Windows: network settings → manual DNS → 1.1.1.1 and 1.0.0.1. If the block is at the address level this will not be enough, and a VPN is the remaining option."}
              </p>
            </div>
            {reach?.thumbs === "blocked" && (
              <p className="mt-2 text-[12px] leading-[17px] text-yt-sub">
                {isAr
                  ? "وكمان i.ytimg.com متحجوب، فصور الفيديوهات نفسها مش هتظهر."
                  : "i.ytimg.com is blocked too, which is why the thumbnails are missing as well."}
              </p>
            )}
            <button
              type="button"
              onClick={retry}
              disabled={reprobing}
              className="mt-3 inline-flex h-9 items-center rounded-full bg-yt-text px-4 text-[13px] font-medium text-yt-bg hover:bg-white disabled:opacity-50"
            >
              {reprobing
                ? isAr
                  ? "بقيس الشبكة…"
                  : "Testing the network…"
                : isAr
                  ? "قِس الشبكة تاني"
                  : "Test the network again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
