/**
 * Find out which YouTube hosts this particular network will actually talk to,
 * and route the player at one that answers.
 *
 * A blocked network is not one thing. Measured from the browser, the cases
 * that matter are different and need different answers:
 *
 *   - `www.youtube.com` refuses to resolve or connect, while
 *     `www.youtube-nocookie.com` — the privacy embed domain, serving the exact
 *     same player — answers fine. Most domain blocklists and DNS filters only
 *     carry the obvious name, so this is the common case and it costs one
 *     hostname to fix.
 *   - Both embed hosts are gone. Nothing this app serves can bring the player
 *     back, so the only honest move is to name the block and hand over the fix
 *     that matches it rather than spin forever on a black rectangle.
 *   - Nothing at all is reachable, including this very origin. That is not a
 *     YouTube block, it is the network being down, and blaming an ISP filter
 *     for it would send the user chasing the wrong thing.
 *
 * The probe is `fetch(..., { mode: "no-cors" })`: the response is opaque, so
 * the status code is invisible, but a *network-level* failure — DNS failure,
 * connection reset, dropped TLS handshake — rejects the promise, and that is
 * exactly the distinction being measured. A 404 resolves, and a host that
 * answers 404 is a host that is reachable.
 */

export type Reach = "ok" | "blocked" | "unknown";

/** Both serve the identical embedded player; only the hostname differs. */
export const EMBED_HOSTS = ["www.youtube.com", "www.youtube-nocookie.com"] as const;
export type EmbedHost = (typeof EMBED_HOSTS)[number];

export const DEFAULT_EMBED_HOST: EmbedHost = "www.youtube.com";

export interface ReachReport {
  /** The ordinary embed host. */
  youtube: Reach;
  /** The privacy embed host, which filters routinely forget. */
  nocookie: Reach;
  /** Thumbnails. Blocked here means the grid looks broken, not the player. */
  thumbs: Reach;
  /** This app's own origin, used as the control for the whole measurement. */
  self: Reach;
  at: number;
}

const HOST_KEY = "yt:embed-host";
const CACHE_KEY = "yt:reach";
/** Long enough not to re-probe on every navigation, short enough to notice a
 *  network changing from mobile data to a filtered Wi-Fi. */
const CACHE_MS = 5 * 60 * 1000;
const PROBE_MS = 6000;

const isHost = (v: unknown): v is EmbedHost =>
  typeof v === "string" && (EMBED_HOSTS as readonly string[]).includes(v);

/** The host that worked last time, so a filtered network pays the detection
 *  cost once rather than on every page load. */
export function storedEmbedHost(): EmbedHost | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(HOST_KEY);
    return isHost(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rememberEmbedHost(host: EmbedHost): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(HOST_KEY, host);
  } catch {
    /* private mode */
  }
}

async function probeOne(url: string, timeoutMs: number): Promise<Reach> {
  if (typeof fetch !== "function" || typeof AbortController === "undefined") return "unknown";
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: control.signal,
    });
    return "ok";
  } catch {
    // Rejection here is a network-level refusal, or a host so slow it is
    // indistinguishable from one. Both mean the player cannot load.
    return "blocked";
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): ReachReport | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReachReport;
    if (!parsed || typeof parsed.at !== "number") return null;
    return Date.now() - parsed.at < CACHE_MS ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(report: ReachReport): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(report));
  } catch {
    /* private mode */
  }
}

export function forgetReach(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* private mode */
  }
}

/**
 * Measure the four hosts at once.
 *
 * @param videoId probed against a real thumbnail when given, so the check is
 *   the same request the grid makes rather than a stand-in.
 */
export async function probeReach(
  videoId?: string,
  { timeoutMs = PROBE_MS }: { timeoutMs?: number } = {},
): Promise<ReachReport> {
  if (typeof window === "undefined") {
    return { youtube: "unknown", nocookie: "unknown", thumbs: "unknown", self: "unknown", at: 0 };
  }
  const bust = `?_=${Date.now()}`;
  const thumb = videoId
    ? `https://i.ytimg.com/vi/${videoId}/default.jpg${bust}`
    : `https://i.ytimg.com/favicon.ico${bust}`;

  const [youtube, nocookie, thumbs, self] = await Promise.all([
    probeOne(`https://www.youtube.com/favicon.ico${bust}`, timeoutMs),
    probeOne(`https://www.youtube-nocookie.com/favicon.ico${bust}`, timeoutMs),
    probeOne(thumb, timeoutMs),
    probeOne(`${window.location.origin}/favicon.ico${bust}`, timeoutMs),
  ]);

  // Our own origin is the control. If that is unreachable the browser is
  // offline or something is eating every request, and nothing can be
  // concluded about YouTube specifically.
  const report: ReachReport =
    self === "ok"
      ? { youtube, nocookie, thumbs, self, at: Date.now() }
      : { youtube: "unknown", nocookie: "unknown", thumbs: "unknown", self, at: Date.now() };

  writeCache(report);
  return report;
}

/** Cached measurement, so several players on one page probe once. */
export async function reachReport(videoId?: string): Promise<ReachReport> {
  return readCache() ?? (await probeReach(videoId));
}

/**
 * The host to load the embed from, or null to leave the current one alone.
 * Never guesses: an unmeasured host is not a reason to move.
 */
export function pickEmbedHost(report: ReachReport): EmbedHost | null {
  if (report.youtube === "ok") return "www.youtube.com";
  if (report.youtube === "blocked" && report.nocookie === "ok") return "www.youtube-nocookie.com";
  return null;
}

/** True when no embed host answered and the player therefore cannot load. */
export function embedIsUnreachable(report: ReachReport | null): boolean {
  return !!report && report.youtube === "blocked" && report.nocookie === "blocked";
}
