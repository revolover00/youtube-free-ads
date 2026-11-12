/**
 * Playing a video on a network that blocks YouTube outright.
 *
 * Everything else was measured and ruled out first, and the measurements are
 * worth keeping because they are what makes this the only remaining design:
 *
 *   - Our own server cannot fetch the media. YouTube answers this server's IP
 *     with `playabilityStatus: LOGIN_REQUIRED` and the bot wall, 6 attempts
 *     out of 6 with a fresh session each time, and strips `streamingData`
 *     entirely. There is nothing to relay, so a server-side proxy has nothing
 *     to proxy.
 *   - The public YouTube front-ends refuse this server too: 403 "Endpoint
 *     disabled", 403 access_denied, or no route at all. They turn away
 *     datacentre addresses on purpose.
 *
 * What is left is the one network that is neither of those: the user's own.
 * Their connection blocks `youtube.com`, not `pipedapi.*` or an Invidious
 * host, and those front-ends already do the signature work and serve the
 * bytes from their own domain. So the browser asks them directly — no
 * bandwidth through us, and the request comes from a residential address,
 * which is the address those instances actually serve.
 *
 * Public instances come and go constantly, so nothing here is trusted: the
 * candidates are tried in order, and the real arbiter is the `<video>`
 * element. If it cannot play what an instance handed over, the next candidate
 * is tried. A list that rots degrades one entry at a time instead of
 * breaking.
 */

/** Piped's API: progressive streams are already proxied through the instance. */
const PIPED_HOSTS = [
  "pipedapi.kavin.rocks",
  "pipedapi.adminforge.de",
  "api.piped.yt",
  "pipedapi.ducks.party",
  "pipedapi.reallyaweso.me",
];

/**
 * Invidious: `/latest_version` with `local=true` redirects to the instance's
 * own proxy rather than googlevideo, which matters because googlevideo is
 * exactly as blocked as youtube.com on the networks this exists for.
 */
const INVIDIOUS_HOSTS = [
  "inv.nadeko.net",
  "invidious.nerdvpn.de",
  "yewtu.be",
  "iv.ggtyler.dev",
  "invidious.privacyredirect.com",
];

/** itag 18: 360p, audio muxed in, one file, plays in a bare <video>. */
const PROGRESSIVE_ITAG = 18;

export interface MirrorSource {
  /** Shown to the user, because they are owed the name of who is serving it. */
  instance: string;
  url: string;
}

interface PipedStream {
  url?: unknown;
  videoOnly?: unknown;
  itag?: unknown;
  quality?: unknown;
}

function pipedProgressive(body: unknown): string | null {
  const streams = (body as { videoStreams?: unknown })?.videoStreams;
  if (!Array.isArray(streams)) return null;
  const usable = (streams as PipedStream[]).filter(
    (s) => typeof s.url === "string" && s.url && s.videoOnly === false,
  );
  if (!usable.length) return null;
  // Prefer the 360p muxed file: the smallest thing that still carries sound,
  // on a connection that is already fighting its own network.
  const best =
    usable.find((s) => Number(s.itag) === PROGRESSIVE_ITAG) ??
    usable.find((s) => String(s.quality).startsWith("360")) ??
    usable[0];
  return typeof best?.url === "string" ? best.url : null;
}

/** How long the whole Piped round gets before Invidious is tried instead. */
export const MIRROR_TIMEOUT_MS = 7000;

/**
 * Ask every Piped instance at once and take the first usable answer.
 *
 * Sequentially would mean five timeouts stacked end to end -- half a minute
 * of nothing on screen -- and these are independent hosts, so there is no
 * reason to wait on them one at a time.
 */
async function racePiped(videoId: string, timeoutMs: number): Promise<MirrorSource | null> {
  if (typeof AbortController === "undefined" || typeof fetch !== "function") return null;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  const id = encodeURIComponent(videoId);

  const attempts = PIPED_HOSTS.map(async (host): Promise<MirrorSource> => {
    const res = await fetch(`https://${host}/streams/${id}`, {
      signal: control.signal,
      mode: "cors",
      credentials: "omit",
    });
    if (!res.ok) throw new Error(String(res.status));
    const url = pipedProgressive(await res.json());
    if (!url) throw new Error("no progressive stream");
    return { instance: host, url };
  });

  try {
    // Promise.any resolves on the first success and only rejects if they all
    // fail, which is exactly the semantics wanted here.
    return await Promise.any(attempts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    control.abort();
  }
}

/**
 * Invidious needs no asking: `/latest_version` with `local=true` is itself
 * the media, redirected through the instance's own proxy rather than
 * googlevideo -- which matters, because googlevideo is exactly as blocked as
 * youtube.com on the networks this exists for. Whether it plays is decided by
 * the video element, which is the only honest test available from here.
 */
function invidiousSources(videoId: string): MirrorSource[] {
  const id = encodeURIComponent(videoId);
  return INVIDIOUS_HOSTS.map((host) => ({
    instance: host,
    url: `https://${host}/latest_version?id=${id}&itag=${PROGRESSIVE_ITAG}&local=true`,
  }));
}

/**
 * Everything worth handing to a <video>, best first. The Piped winner comes
 * first because its URL is a stream that was confirmed to exist; the
 * Invidious entries are promises that only resolve by playing.
 */
export async function mirrorSources(
  videoId: string,
  timeoutMs = MIRROR_TIMEOUT_MS,
): Promise<MirrorSource[]> {
  const piped = await racePiped(videoId, timeoutMs);
  return piped ? [piped, ...invidiousSources(videoId)] : invidiousSources(videoId);
}
