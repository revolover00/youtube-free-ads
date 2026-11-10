import { RefreshCw } from "lucide-react";
import { useAuth } from "../lib/AuthContext";
import { useLanguage } from "../lib/i18n";

/**
 * Sign-in / sync prompt above the feed.
 *
 * This used to be a marketing hero — gradient wash, blurred glow blobs, a
 * pinging ring, a "Personalized Feed" pill and a 24px headline. YouTube has no
 * such element anywhere; its equivalent prompt is a line of 14px text and a
 * text button on the plain page background. This is that.
 */
export function YouTubeSyncBanner() {
  const { user, signIn, syncYouTubeData, importingYouTube } = useAuth();
  const { isAr } = useLanguage();

  const message = user
    ? isAr
      ? "لم نجد اشتراكات. تأكد من تفعيل YouTube Data API v3 ثم أعد المزامنة."
      : "No subscriptions found. Make sure YouTube Data API v3 is enabled, then sync again."
    : isAr
      ? "سجّل الدخول لمزامنة اشتراكاتك وبناء موجز يناسب ما تشاهده."
      : "Sign in to sync your subscriptions and build a feed from the channels you watch.";

  const action = importingYouTube
    ? isAr
      ? "جارٍ المزامنة…"
      : "Syncing…"
    : user
      ? isAr
        ? "مزامنة"
        : "Sync"
      : isAr
        ? "تسجيل الدخول"
        : "Sign in";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-yt-border pb-4">
      <p className="min-w-0 flex-1 text-sm leading-5 text-yt-sub">{message}</p>
      <button
        onClick={() => (user ? syncYouTubeData().catch(() => {}) : signIn().catch(() => {}))}
        disabled={importingYouTube}
        className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-yt-border px-4 text-sm font-medium text-yt-blue transition-colors hover:bg-yt-blue/10 disabled:opacity-50"
      >
        {user && <RefreshCw className={`h-4 w-4 ${importingYouTube ? "animate-spin" : ""}`} />}
        <span>{action}</span>
      </button>
    </div>
  );
}
