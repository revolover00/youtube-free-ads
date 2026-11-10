/**
 * Server-side YouTube data layer.
 *
 * Runs only on the server (never imported by the browser), so there is no CORS
 * problem and no dependency on third-party Piped/Invidious instances: it talks
 * to YouTube's own public InnerTube endpoint directly.
 */

import { addressFrame, parseStoryboardSpec } from "./storyboard";
import { USE_FIXTURE, fixtureVideoDetails, fixtureVideoFrame, fixtureVideos } from "./fixtures";
import { extractJsonVar } from "./htmljson";
import type {
  ChannelData,
  PipedComment,
  PipedVideo,
  PlaylistData,
  SearchChannel,
  SearchPlaylist,
  StreamData,
} from "./types";

const INNERTUBE = "https://www.youtube.com/youtubei/v1";

const CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240401.00.00",
  hl: "ar",
  gl: "EG",
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Public InnerTube key the youtube.com web player itself uses. */
const INNERTUBE_WEB_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/** Decode a raw JSON string body (handles \u0026, \/, \" …) without parsing the whole blob. */
function jsonStringValue(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

const cache = new Map<string, { at: number; data: unknown; inflight?: Promise<unknown> }>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);

  if (entry) {
    const age = now - entry.at;
    if (age < ttlMs) {
      return entry.data as T;
    }
    if (age < ttlMs * 4) {
      // stale-while-revalidate: return stale data immediately, background refresh
      if (!entry.inflight) {
        entry.inflight = fn()
          .then((fresh) => {
            entry.at = Date.now();
            entry.data = fresh;
            return fresh;
          })
          .catch((err) => {
            console.warn(`Background revalidation failed for ${key}:`, err);
            return entry.data;
          })
          .finally(() => {
            entry.inflight = undefined;
          });
      }
      return entry.data as T;
    }
    // Expired beyond ttlMs * 4: if inflight exists, wait for it
    if (entry.inflight) {
      return (await entry.inflight) as T;
    }
  }

  // Deduplicate inflight requests for the same key
  const placeholder: { at: number; data: unknown; inflight?: Promise<unknown> } = entry || {
    at: 0,
    data: undefined,
  };
  const promise = (async () => {
    const data = await fn();
    placeholder.at = Date.now();
    placeholder.data = data;
    return data;
  })();

  placeholder.inflight = promise;
  cache.set(key, placeholder);

  // Evict oldest entries if map exceeds 500 entries
  if (cache.size > 500) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  try {
    const result = await promise;
    return result;
  } finally {
    placeholder.inflight = undefined;
  }
}

/**
 * Consent cookie that skips the EU interstitial. Datacentre egress (Vercel's
 * serverless IPs) is routinely treated as "unknown region", so sending it
 * unconditionally keeps responses in JSON instead of a consent redirect.
 */
const CONSENT_COOKIE = "SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg";

/**
 * A visitor session id.
 *
 * YouTube hands anonymous callers a `visitorData` token and increasingly
 * *requires* it on `next`/`browse` when the request comes from a cloud IP —
 * without one those endpoints answer 403 even though `search` still works.
 * Scraped from the home page's `ytcfg`, cached, and refreshed on demand.
 */
let visitorSession: { at: number; value: string } | null = null;

async function visitorId(force = false): Promise<string> {
  const now = Date.now();
  if (!force && visitorSession && now - visitorSession.at < 30 * 60 * 1000) {
    return visitorSession.value;
  }
  try {
    const res = await fetch("https://www.youtube.com/?hl=en", {
      headers: {
        "user-agent": BROWSER_UA,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: CONSENT_COOKIE,
      },
    });
    if (res.ok) {
      const raw = /"visitorData":"([^"]+)"/.exec(await res.text())?.[1] ?? "";
      if (raw) {
        visitorSession = { at: now, value: jsonStringValue(raw) };
        return visitorSession.value;
      }
    }
  } catch {
    /* fall through to whatever we already had */
  }
  return visitorSession?.value ?? "";
}

export async function innertube<T = Json>(
  endpoint: "search" | "browse" | "next" | "player",
  body: Record<string, unknown>,
): Promise<T> {
  const plain = () =>
    fetch(`${INNERTUBE}/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": "ar,en;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      body: JSON.stringify({ context: { client: CLIENT }, ...body }),
    });

  /** Same call, but as a fully attributed web-player session. */
  const withSession = async () => {
    const visitor = await visitorId(true);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept-language": "ar,en;q=0.8",
      "user-agent": BROWSER_UA,
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": CLIENT.clientVersion,
      cookie: CONSENT_COOKIE,
    };
    if (visitor) headers["x-goog-visitor-id"] = visitor;
    return fetch(`${INNERTUBE}/${endpoint}?key=${INNERTUBE_WEB_KEY}&prettyPrint=false`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        context: { client: visitor ? { ...CLIENT, visitorData: visitor } : CLIENT },
        ...body,
      }),
    });
  };

  // The bare request is what has always worked from most IPs, so it stays the
  // fast path; the session upgrade is only paid for when YouTube pushes back.
  let res = await plain();
  if (res.status === 401 || res.status === 403) res = await withSession();
  if (!res.ok) throw new Error(`youtube ${endpoint} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The watch page's `ytInitialData` — byte-for-byte the same renderer tree that
 * `youtubei/v1/next` returns, so every parser below works on it unchanged.
 */
async function watchPageNextData(videoId: string): Promise<Json | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ar&gl=EG`,
      {
        headers: {
          "user-agent": BROWSER_UA,
          "accept-language": "ar,en;q=0.8",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          cookie: CONSENT_COOKIE,
        },
      },
    );
    if (!res.ok) return null;
    return extractJsonVar(await res.text(), "ytInitialData");
  } catch {
    return null;
  }
}

/**
 * `next` for a watch page, with the HTML scrape as a backstop.
 *
 * YouTube 403s `youtubei/v1/next` from some datacentre ranges while happily
 * serving the very same data inside the watch page, which is why a failure
 * here must not be the end of the road. The thrown message carries the status
 * of every attempt so production failures stay diagnosable.
 */
async function nextPayload(videoId: string): Promise<Json> {
  let apiNote = "";
  try {
    return await innertube("next", { videoId });
  } catch (err) {
    apiNote = err instanceof Error ? err.message.replace("youtube next → ", "") : "failed";
  }
  const scraped = await watchPageNextData(videoId);
  if (scraped) return scraped;
  throw new Error(`video unavailable (api ${apiNote}, watch page unreadable)`);
}

/* ------------------------------------------------------------------ */
/* Generic JSON helpers                                                */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function collect(node: Json, key: string, out: Json[] = [], depth = 0): Json[] {
  // Prevent infinite loops from recursive structures (Youtubei sometimes has them)
  if (!node || typeof node !== "object" || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    else collect(v, key, out, depth + 1);
  }
  return out;
}

function text(node: Json): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.simpleText && typeof node.simpleText === "string") return node.simpleText;
  if (node.content && typeof node.content === "string") return node.content;
  if (Array.isArray(node.runs)) {
    return node.runs
      .map((r: Json) => {
        if (!r) return "";
        if (typeof r === "string") return r;
        return r.text ?? "";
      })
      .join("");
  }
  return "";
}

const WESTERN = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,٬\s]/g, "");

/** "10:15" / "1:02:03" → seconds. Empty (live) → 0. */
function parseDuration(s: string): number {
  const parts = WESTERN(s).split(":").map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const MULTIPLIERS: [RegExp, number][] = [
  [/مليار|مليارات|(?:\d|\s)b\b/i, 1_000_000_000],
  [/مليون|ملايين|(?:\d|\s)m\b/i, 1_000_000],
  [/ألف|آلاف|الاف|الف|(?:\d|\s)k\b/i, 1_000],
];

/** "1.8 مليار مشاهدة" / "43,610 مشاهدات" / "2.67 مليون مشترك" / "6 آلاف من الفيديوهات" → number. */
function parseCount(s: string): number {
  if (!s) return 0;
  let cleaned = s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  cleaned = cleaned.replace(/\u00a0/g, " ");

  const hasMultiplier = MULTIPLIERS.some(([re]) => re.test(cleaned));
  if (hasMultiplier) {
    cleaned = cleaned.replace(/٫/g, ".");
    cleaned = cleaned.replace(/(\d+),(\d+)/g, "$1.$2");
    const match = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    for (const [re, mult] of MULTIPLIERS) {
      if (re.test(cleaned)) return Math.round(val * mult);
    }
    return Math.round(val);
  } else {
    const rawDigits = cleaned.replace(/[^\d]/g, "");
    return rawDigits ? parseInt(rawDigits, 10) : 0;
  }
}

const thumbFor = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/* ------------------------------------------------------------------ */
/* Renderer parsers                                                    */
/* ------------------------------------------------------------------ */

function fromVideoRenderer(r: Json): PipedVideo | null {
  const id: string | undefined = r?.videoId;
  const title = text(r?.title);
  if (!id || !title) return null;
  const byline = r.longBylineText ?? r.ownerText ?? r.shortBylineText;
  const channelId =
    collect(byline, "browseEndpoint")[0]?.browseId ??
    collect(r, "browseEndpoint")[0]?.browseId ??
    "";

  // Robust thumbnail selection
  const thumbs = r.thumbnail?.thumbnails ?? [];
  const thumbnail = thumbs.length > 0 ? thumbs.at(-1)?.url || thumbFor(id) : thumbFor(id);

  const badgesStr = JSON.stringify(r.badges ?? []);
  const overlaysStr = JSON.stringify(r.thumbnailOverlays ?? []);
  const viewStr = text(r.viewCountText);
  const timeStr = text(r.publishedTimeText);
  const durSec = parseDuration(text(r.lengthText));

  // Determine if it is an active Live stream
  const isLive =
    badgesStr.includes("LIVE") ||
    badgesStr.includes("مباشر") ||
    badgesStr.includes("BADGE_STYLE_TYPE_LIVE_NOW") ||
    overlaysStr.includes('"style":"LIVE"') ||
    /watching|مشاهدة حالياً|يشاهد الآن/i.test(viewStr) ||
    /بث مباشر|\blive stream\b/i.test(title);

  // Determine if it is a Short
  const isShort =
    !isLive &&
    (overlaysStr.includes('"style":"SHORTS"') ||
      /#shorts\b|#short\b/i.test(title) ||
      (durSec > 0 &&
        durSec <= 60 &&
        !timeStr.includes("مباشر") &&
        !timeStr.toLowerCase().includes("live")));

  return {
    url: `/watch?v=${id}`,
    type: isLive ? "live" : isShort ? "shorts" : "stream",
    isLive,
    isShort,
    title,
    thumbnail,
    uploaderName: text(byline) || "YouTube",
    uploaderUrl: channelId ? `/channel/${channelId}` : undefined,
    uploaderAvatar: collect(r, "channelThumbnailSupportedRenderers")[0]
      ? collect(r, "thumbnails")[1]?.[0]?.url
      : undefined,
    uploaderVerified: JSON.stringify(r.ownerBadges ?? []).includes("VERIFIED"),
    uploadedDate: isLive ? "مباشر" : timeStr,
    duration: isLive ? 0 : durSec,
    views: parseCount(viewStr),
    description: text(r.detailedMetadataSnippets?.[0]?.snippetText),
  };
}

/** Newer "lockup" cards (related videos, channel grids). */
function fromLockup(r: Json): PipedVideo | null {
  const id: string | undefined = r?.contentId;
  const meta = r?.metadata?.lockupMetadataViewModel;
  const title = text(meta?.title);
  if (!id || !title || r?.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;

  const rows: Json[] = collect(meta?.metadata, "metadataRows")[0] ?? [];
  const parts = (i: number): Json[] => rows[i]?.metadataParts ?? [];

  let channelName = "";
  let views = 0;
  let uploadedDate = "";

  if (rows.length >= 2) {
    // Search / Home: Row 0 is channel name, Row 1 is views and uploaded date
    channelName = text(parts(0)[0]?.text);
    views = parseCount(text(parts(1)[0]?.text));
    uploadedDate = text(parts(1)[1]?.text);
  } else if (rows.length === 1) {
    // Channel videos tab: Row 0 has views and uploaded date!
    const row0 = parts(0);
    views = parseCount(text(row0[0]?.text));
    uploadedDate = text(row0[1]?.text);
  }

  const badge = collect(r.contentImage, "thumbnailBadgeViewModel")[0];
  const badgeText = (badge?.text ?? "").trim();
  const contentImageStr = JSON.stringify(r.contentImage ?? "");

  const isLive =
    /LIVE|مباشر|بث مباشر/i.test(badgeText) ||
    contentImageStr.includes('"style":"LIVE"') ||
    /بث مباشر|\blive stream\b/i.test(title);

  const durSec = isLive ? 0 : parseDuration(badgeText);
  const isShort =
    !isLive &&
    (r.contentType === "LOCKUP_CONTENT_TYPE_SHORTS" ||
      /#shorts\b|#short\b/i.test(title) ||
      (durSec > 0 && durSec <= 60));

  const channelId = collect(meta?.image, "browseEndpoint")[0]?.browseId ?? "";

  return {
    url: `/watch?v=${id}`,
    type: isLive ? "live" : isShort ? "shorts" : "stream",
    isLive,
    isShort,
    title,
    thumbnail: collect(r.contentImage, "sources")[0]?.at(-1)?.url ?? thumbFor(id),
    uploaderName: channelName,
    uploaderUrl: channelId ? `/channel/${channelId}` : undefined,
    uploaderAvatar: collect(meta?.image, "sources")[0]?.[0]?.url,
    uploadedDate: isLive ? "مباشر" : uploadedDate,
    duration: isLive ? 0 : durSec,
    views,
  };
}

const https = (u?: string) => (u ? (u.startsWith("//") ? `https:${u}` : u) : "");

function fromChannelRenderer(r: Json): SearchChannel | null {
  const id: string | undefined = r?.channelId;
  const name = text(r?.title);
  if (!id || !name) return null;
  const subsLabel = [text(r.videoCountText), text(r.subscriberCountText)].find((s) =>
    /مشترك|subscrib/i.test(s),
  );
  return {
    id,
    name,
    avatar: https(r?.thumbnail?.thumbnails?.at(-1)?.url),
    subscribers: parseCount(subsLabel ?? text(r.subscriberCountText)),
    description: text(r.descriptionSnippet),
    verified: JSON.stringify(r.ownerBadges ?? []).includes("VERIFIED"),
  };
}

function fromPlaylistRenderer(r: Json): SearchPlaylist | null {
  const id: string | undefined = r?.playlistId;
  const title = text(r?.title);
  if (!id || !title) return null;
  const firstVideoId = collect(r, "videoId")[0];
  return {
    id,
    title,
    thumbnail:
      https(collect(r, "thumbnails")[0]?.at?.(-1)?.url) ||
      (firstVideoId ? thumbFor(firstVideoId) : ""),
    videoCount: parseCount(String(r.videoCount ?? text(r.videoCountText) ?? "")),
    uploaderName: text(r.longBylineText ?? r.shortBylineText),
    firstVideoId,
  };
}

/** Newer playlist "lockup" cards. */
function fromPlaylistLockup(r: Json): SearchPlaylist | null {
  const id: string | undefined = r?.contentId;
  const meta = r?.metadata?.lockupMetadataViewModel;
  const title = text(meta?.title);
  if (!id || !title || r?.contentType !== "LOCKUP_CONTENT_TYPE_PLAYLIST") return null;
  const rows: Json[] = collect(meta?.metadata, "metadataRows")[0] ?? [];
  const badge = collect(r.contentImage, "thumbnailOverlayBadgeViewModel")[0];
  return {
    id,
    title,
    thumbnail: https(collect(r.contentImage, "sources")[0]?.at(-1)?.url),
    videoCount: parseCount(text(collect(badge, "text")[0]) || ""),
    uploaderName: text(rows[0]?.metadataParts?.[0]?.text),
  };
}

/** Channel cards inside any search response. */
function extractChannels(payload: Json): SearchChannel[] {
  const out: SearchChannel[] = [];
  const seen = new Set<string>();
  for (const r of collect(payload, "channelRenderer")) {
    const c = fromChannelRenderer(r);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** Playlist cards inside any search response. */
function extractPlaylists(payload: Json): SearchPlaylist[] {
  const out: SearchPlaylist[] = [];
  const seen = new Set<string>();
  const push = (p: SearchPlaylist | null) => {
    if (!p || seen.has(p.id) || !p.thumbnail) return;
    seen.add(p.id);
    out.push(p);
  };
  for (const r of collect(payload, "playlistRenderer")) push(fromPlaylistRenderer(r));
  for (const r of collect(payload, "gridPlaylistRenderer")) push(fromPlaylistRenderer(r));
  for (const r of collect(payload, "lockupViewModel")) push(fromPlaylistLockup(r));
  return out;
}

function fromReelItem(r: Json): PipedVideo | null {
  const id: string | undefined = r?.videoId;
  const title = text(r?.headline);
  if (!id || !title) return null;
  return {
    url: `/watch?v=${id}`,
    type: "shorts",
    isShort: true,
    isLive: false,
    title,
    thumbnail: r.thumbnail?.thumbnails?.at(-1)?.url ?? thumbFor(id),
    uploaderName: text(r.navigationEndpoint?.reelWatchEndpoint?.channelName) || "Shorts",
    duration: 30,
    views: parseCount(text(r.viewCountText)),
  };
}

function fromShortsLockup(s: Json): PipedVideo | null {
  if (!s) return null;
  const videoId: string =
    s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
    s.entityId?.replace("shorts-shelf-item-", "") ||
    "";
  if (!videoId) return null;
  const title = text(s.overlayMetadata?.primaryText?.content) || "Shorts";
  const views = parseCount(text(s.overlayMetadata?.secondaryText?.content));
  const thumb =
    s.thumbnail?.sources?.at(-1)?.url ||
    s.onTap?.innertubeCommand?.reelWatchEndpoint?.thumbnail?.thumbnails?.at(-1)?.url ||
    thumbFor(videoId);

  return {
    url: `/watch?v=${videoId}`,
    type: "shorts",
    isShort: true,
    isLive: false,
    title,
    thumbnail: thumb,
    uploaderName: "Shorts",
    duration: 30,
    views,
  };
}

/** Pull every playable video card out of any InnerTube response. */
function extractVideos(payload: Json): PipedVideo[] {
  const out: PipedVideo[] = [];
  const seen = new Set<string>();
  const push = (v: PipedVideo | null) => {
    if (!v) return;
    const id = v.url.includes("=") ? v.url.slice(v.url.indexOf("=") + 1) : v.url.split("/").at(-1);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(v);
  };
  for (const r of collect(payload, "videoRenderer")) push(fromVideoRenderer(r));
  for (const r of collect(payload, "gridVideoRenderer")) push(fromVideoRenderer(r));
  for (const r of collect(payload, "compactVideoRenderer")) push(fromVideoRenderer(r));
  for (const r of collect(payload, "lockupViewModel")) push(fromLockup(r));
  for (const r of collect(payload, "playlistVideoRenderer")) push(fromVideoRenderer(r));
  for (const r of collect(payload, "reelItemRenderer")) push(fromReelItem(r));
  for (const r of collect(payload, "shortsLockupViewModel")) push(fromShortsLockup(r));
  return out;
}

/* ------------------------------------------------------------------ */
/* Public operations                                                   */
/* ------------------------------------------------------------------ */

/** filter=videos */
const SEARCH_VIDEOS = "EgIQAQ%3D%3D";
/** filter=videos + sort by view count + uploaded this week */
const SEARCH_HOT = "CAMSBQgDEAE%3D";

export interface Page {
  items: PipedVideo[];
  /** Token for the next page, or null when exhausted. */
  continuation: string | null;
  /** Channel cards found on this page (search only). */
  channels: SearchChannel[];
  /** Playlist cards found on this page (search only). */
  playlists: SearchPlaylist[];
}

function continuationToken(payload: Json): string | null {
  // 1. Look for continuationItemRenderer first (standard for list pagination)
  const items = collect(payload, "continuationItemRenderer");
  for (const item of items) {
    const token =
      item?.continuationEndpoint?.continuationCommand?.token ?? item?.continuationCommand?.token;
    if (typeof token === "string" && token.length > 10) return token;
  }

  // 2. Fallback to any continuationCommand
  const tokens = collect(payload, "continuationCommand")
    .map((c: Json) => c?.token)
    .filter((t: unknown): t is string => typeof t === "string" && t.length > 10);
  if (tokens.length) return tokens.at(-1) ?? null;

  // 3. Legacy fallbacks
  const legacy = collect(payload, "nextContinuationData");
  if (legacy.length) return legacy[0]?.continuation ?? null;

  return null;
}

export async function search(query: string, params = SEARCH_VIDEOS): Promise<PipedVideo[]> {
  const key = `search:${JSON.stringify([query, params])}`;
  return cached(key, 10 * 60 * 1000, async () => {
    return (await searchPage(query, params)).items;
  });
}

/**
 * One page of search results; pass `continuation` to get the next page.
 * With no `params` the results are mixed (videos + channels + playlists),
 * exactly like youtube.com.
 */
export async function searchPage(
  query: string,
  params = "",
  continuation?: string | null,
): Promise<Page> {
  const key = `searchPage:${JSON.stringify([query, params, continuation ?? null])}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const data = await innertube(
      "search",
      continuation ? { continuation } : { query, ...(params ? { params } : {}) },
    );
    return {
      items: extractVideos(data),
      continuation: continuationToken(data),
      channels: extractChannels(data),
      playlists: extractPlaylists(data),
    };
  });
}

/** All videos of a playlist. */
export async function playlist(id: string): Promise<PlaylistData> {
  const key = `playlist:${id}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const browseId = id.startsWith("VL") ? id : `VL${id}`;
    const data = await innertube("browse", { browseId });
    const header =
      collect(data, "playlistHeaderRenderer")[0] ?? collect(data, "pageHeaderViewModel")[0] ?? {};
    const meta = collect(data, "microformatDataRenderer")[0] ?? {};
    const videos = extractVideos(data);
    const title =
      text(header.title) ||
      text(collect(header, "dynamicTextViewModel")[0]?.text) ||
      meta.title ||
      "قائمة تشغيل";
    return {
      id: browseId.replace(/^VL/, ""),
      title,
      thumbnail:
        https(collect(header, "thumbnails")[0]?.at?.(-1)?.url) || videos[0]?.thumbnail || "",
      videoCount: parseCount(text(header.numVideosText)) || videos.length,
      uploaderName: text(header.ownerText) || text(collect(header, "ownerText")[0]),
      description: meta.description ?? text(header.descriptionText),
      videos,
    };
  });
}

const TRENDING_QUERIES = ["مصر", "الأكثر مشاهدة", "trailer", "music"];

export interface TrendingPage {
  items: PipedVideo[];
  /** One continuation per source query (null = exhausted). */
  cursors: (string | null)[];
}

function interleave(lists: PipedVideo[][]): PipedVideo[] {
  const merged: PipedVideo[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const v = list[i];
      if (!v || seen.has(v.url)) continue;
      seen.add(v.url);
      merged.push(v);
    }
  }
  return merged;
}

/**
 * YouTube retired the public "trending" browse feed for anonymous clients, so
 * the hot list is rebuilt from most-viewed uploads of the last week.
 * `cursors` (from a previous page) fetches the next page of every source.
 */

export async function trendingPage(cursors?: (string | null)[]): Promise<TrendingPage> {
  if (USE_FIXTURE) return { items: fixtureVideos(24), cursors: [null] };
  const key = `trendingPage:${JSON.stringify(cursors ?? null)}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const batches = await Promise.allSettled(
      TRENDING_QUERIES.map((q, i) => {
        if (cursors) {
          const c = cursors[i];
          return c
            ? searchPage(q, SEARCH_HOT, c)
            : Promise.resolve<Page>({ items: [], continuation: null, channels: [], playlists: [] });
        }
        return searchPage(q, SEARCH_HOT);
      }),
    );
    const pages = batches.map((b) =>
      b.status === "fulfilled"
        ? b.value
        : ({ items: [], continuation: null, channels: [], playlists: [] } as Page),
    );
    const items = interleave(pages.map((p) => p.items));
    if (!items.length && !cursors) throw new Error("trending unavailable");
    return { items, cursors: pages.map((p) => p.continuation) };
  });
}

export async function trending(): Promise<PipedVideo[]> {
  const key = "trending";
  return cached(key, 10 * 60 * 1000, async () => {
    return (await trendingPage()).items;
  });
}

export async function suggest(query: string): Promise<string[]> {
  const key = `suggest:${query}`;
  return cached(key, 60 * 60 * 1000, async () => {
    // `oe=utf-8` is required: without it YouTube answers in windows-1256 and
    // every Arabic suggestion comes back as mojibake.
    const res = await fetch(
      `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=ar&gl=eg&oe=utf-8&q=${encodeURIComponent(query)}`,
    );
    if (!res.ok) return [];
    const body = await res.text();
    const json = body.slice(body.indexOf("(") + 1, body.lastIndexOf(")"));
    try {
      const parsed = JSON.parse(json) as [string, [string][]];
      return (parsed[1] || []).map((row) => row[0]).slice(0, 10);
    } catch {
      return [];
    }
  });
}

function parseCommentEntities(data: Json): PipedComment[] {
  const fromEntities = collect(data, "commentEntityPayload")
    .map((c: Json) => ({
      author: c?.author?.displayName ?? "",
      thumbnail: c?.author?.avatarThumbnailUrl ?? "",
      commentText: c?.properties?.content?.content ?? "",
      commentedTime: c?.properties?.publishedTime ?? "",
      likeCount: parseCount(c?.toolbar?.likeCountLiked ?? c?.toolbar?.likeCountNotliked ?? ""),
      replyCount: parseCount(c?.toolbar?.replyCount ?? ""),
    }))
    .filter((c) => c.commentText);

  if (fromEntities.length > 0) return fromEntities;

  return collect(data, "commentRenderer")
    .map((c: Json) => ({
      author: text(c?.authorText) || "",
      thumbnail: c?.authorThumbnail?.thumbnails?.at(-1)?.url || "",
      commentText: text(c?.contentText) || "",
      commentedTime: text(c?.publishedTimeText) || "",
      likeCount: parseCount(text(c?.voteCount) || ""),
      replyCount: parseCount(text(c?.replyCount) || ""),
    }))
    .filter((c) => c.commentText);
}

function extractCommentsTotalCount(data: Json): number {
  const header = collect(data, "commentsHeaderRenderer")[0];
  if (header) {
    const countText = text(header?.countText) || text(header?.commentsCount);
    const count = parseCount(countText);
    if (count > 0) return count;
  }
  try {
    const str = JSON.stringify(data);
    const m =
      str.match(/"countText":\{"runs":\[\{"text":"([^"]+)"\}/) ||
      str.match(/"commentsCount":\{"runs":\[\{"text":"([^"]+)"\}/);
    if (m && m[1]) {
      const c = parseCount(m[1]);
      if (c > 0) return c;
    }
  } catch {
    // ignore parse error
  }
  return 0;
}

function isNextCommentsToken(rawToken: unknown): boolean {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 10) return false;
  try {
    const decoded = decodeURIComponent(rawToken);
    // Exclude reply threads continuation
    if (decoded.includes("comment-replies") || decoded.includes("replies-item")) return false;
    const bufStr = Buffer.from(decoded, "base64").toString("latin1");
    if (bufStr.includes("comment-replies") || bufStr.includes("replies_stream")) return false;
    // Positive matches for root comments feed
    if (
      bufStr.includes("get_ranked_streams") ||
      bufStr.includes("comments-section") ||
      bufStr.includes("engagement-panel-comments-section") ||
      bufStr.includes("comments")
    ) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function findNextCommentsToken(data: Json): string | undefined {
  const items = collect(data, "continuationItemRenderer");
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const token =
      item?.continuationEndpoint?.continuationCommand?.token || item?.continuationCommand?.token;
    if (isNextCommentsToken(token)) return token;
  }
  const commands = collect(data, "continuationCommand");
  for (let i = commands.length - 1; i >= 0; i--) {
    const token = commands[i]?.token;
    if (isNextCommentsToken(token)) return token;
  }
  return undefined;
}

export async function fetchComments(
  token: string,
  targetCount = 40,
): Promise<{ items: PipedComment[]; totalCount: number; nextContinuation?: string }> {
  try {
    const items: PipedComment[] = [];
    let curToken: string | undefined = token;
    let totalCount = 0;
    let iterations = 0;

    while (curToken && items.length < targetCount && iterations < 4) {
      iterations++;
      const p = await innertube("next", { continuation: curToken });
      if (!totalCount) {
        totalCount = extractCommentsTotalCount(p);
      }
      const pageItems = parseCommentEntities(p);
      if (!pageItems.length) {
        // If no comments returned, check if there is another continuation or stop
        const next = findNextCommentsToken(p);
        if (!next || next === curToken) break;
        curToken = next;
        continue;
      }
      items.push(...pageItems);
      const nextToken = findNextCommentsToken(p);
      if (!nextToken || nextToken === curToken) {
        curToken = undefined;
        break;
      }
      curToken = nextToken;
    }

    return { items, totalCount, nextContinuation: curToken };
  } catch {
    return { items: [], totalCount: 0 };
  }
}

/** Everything the watch page needs. Playback itself uses the YouTube player. */
export async function videoDetails(videoId: string): Promise<StreamData> {
  if (USE_FIXTURE) return fixtureVideoDetails();
  const key = `videoDetails:${videoId}`;
  return cached(key, 60 * 60 * 1000, async () => {
    const next = await nextPayload(videoId);

    const primary = collect(next, "videoPrimaryInfoRenderer")[0] ?? {};
    const secondary = collect(next, "videoSecondaryInfoRenderer")[0] ?? {};
    const owner = collect(secondary, "videoOwnerRenderer")[0] ?? {};

    const title = text(primary.title);
    if (!title) throw new Error("video unavailable");

    // Accurate like count extraction from modern InnerTube view models, entities, and factoids
    let likes = 0;
    const likeEntities = collect(next, "likeCountEntity");
    for (const ent of likeEntities) {
      if (ent.likeCountIfIndifferentNumber != null) {
        likes = Number(ent.likeCountIfIndifferentNumber) || 0;
        if (likes > 0) break;
      }
      if (ent.expandedLikeCountIfIndifferent?.content) {
        likes = parseCount(ent.expandedLikeCountIfIndifferent.content);
        if (likes > 0) break;
      }
      if (ent.likeCountIfIndifferent?.content) {
        likes = parseCount(ent.likeCountIfIndifferent.content);
        if (likes > 0) break;
      }
      if (ent.likeCountIfLikedNumber != null) {
        likes = Number(ent.likeCountIfLikedNumber) || 0;
        if (likes > 0) break;
      }
      if (ent.likeButtonA11yText?.content) {
        likes = parseCount(ent.likeButtonA11yText.content);
        if (likes > 0) break;
      }
    }

    // Check likeButtonViewModel & segmentedLikeDislikeButtonViewModel
    if (!likes) {
      const likeButtonVMs = collect(next, "likeButtonViewModel");
      for (const vm of likeButtonVMs) {
        const buttonVMs = collect(vm, "buttonViewModel");
        for (const b of buttonVMs) {
          if (b.accessibilityText && /\d/.test(b.accessibilityText)) {
            const v = parseCount(b.accessibilityText);
            if (v > 0) {
              likes = v;
              break;
            }
          }
          if (b.title && /\d/.test(b.title)) {
            const v = parseCount(b.title);
            if (v > 0) {
              likes = v;
              break;
            }
          }
        }
        if (likes > 0) break;
      }
    }

    // Check any buttonViewModel with like ID or action
    if (!likes) {
      const allButtons = collect(next, "buttonViewModel");
      for (const b of allButtons) {
        if (b.accessibilityId === "id.video.like.button" || /like/i.test(b.accessibilityId ?? "")) {
          if (b.accessibilityText && /\d/.test(b.accessibilityText)) {
            const v = parseCount(b.accessibilityText);
            if (v > 0) {
              likes = v;
              break;
            }
          }
          if (b.title && /\d/.test(b.title)) {
            const v = parseCount(b.title);
            if (v > 0) {
              likes = v;
              break;
            }
          }
        }
      }
    }

    // Check FactoidRenderer
    if (!likes) {
      const factoids = collect(next, "factoidRenderer");
      for (const f of factoids) {
        const lbl = f?.label?.simpleText || f?.accessibilityText || "";
        if (/معجب|إعجاب|like/i.test(lbl)) {
          likes = parseCount(f?.value?.simpleText || f?.accessibilityText);
          if (likes > 0) break;
        }
      }
    }

    // Check Legacy toggleButtonRenderer / likeButton
    if (!likes) {
      const legacyButtons = collect(primary, "likeButton");
      for (const lb of legacyButtons) {
        const label =
          text(lb?.toggleButtonRenderer?.defaultText) ??
          text(lb?.toggleButtonRenderer?.accessibility?.label);
        const v = parseCount(label ?? "");
        if (v > 0) {
          likes = v;
          break;
        }
      }
    }

    // Accurate date extraction (exact date & relative date)
    const rawRelDate =
      text(primary.relativeDateText?.accessibility?.accessibilityData?.label) ||
      text(primary.relativeDateText);
    const rawDateText = text(collect(primary, "dateText")[0]) || text(primary.dateText);

    // Check factoid date for clean spelled-out date (e.g. "24 أكتوبر 2009")
    const factoids = collect(next, "factoidRenderer");
    let factoidDate = "";
    for (const f of factoids) {
      const val = text(f?.value);
      const lbl = text(f?.label);
      if (/\d{4}/.test(val) && lbl) {
        factoidDate = `${lbl} ${val}`.trim();
        break;
      }
    }

    const uploadDate = factoidDate || rawDateText || rawRelDate || "";
    const relativeDate = rawRelDate || "";

    const channelId = owner?.navigationEndpoint?.browseEndpoint?.browseId ?? "";

    const related = extractVideos(collect(next, "secondaryResults")[0] ?? {});

    const allTokens = collect(next, "continuationItemRenderer")
      .map((c: Json) => c?.continuationEndpoint?.continuationCommand?.token)
      .filter(Boolean);

    const commentToken =
      allTokens.find((t: string) => {
        try {
          return decodeURIComponent(t).includes("comments-section");
        } catch {
          return false;
        }
      }) || allTokens[0];

    const [commentsData, meta] = await Promise.all([
      commentToken
        ? fetchComments(commentToken, 30)
        : Promise.resolve({
            items: [] as PipedComment[],
            totalCount: 0,
            nextContinuation: undefined as string | undefined,
          }),
      // Duration + storyboard spec. Never allowed to fail the watch page.
      playerMeta(videoId).catch(() => ({ duration: 0, storyboardSpec: "" })),
    ]);

    const category =
      text(collect(next, "playerMicroformatRenderer")[0]?.category) ||
      text(collect(next, "microformatDataRenderer")[0]?.category) ||
      "";

    return {
      title,
      description:
        text(collect(secondary, "attributedDescription")[0]) || text(secondary.description),
      uploadDate,
      relativeDate,
      duration: meta.duration,
      category,
      likes,
      views: parseCount(text(collect(primary, "videoViewCountRenderer")[0]?.viewCount)),
      uploader: text(owner.title),
      uploaderUrl: channelId ? `/channel/${channelId}` : "",
      uploaderAvatar: owner?.thumbnail?.thumbnails?.at(-1)?.url ?? "",
      uploaderVerified: JSON.stringify(owner.badges ?? []).includes("VERIFIED"),
      uploaderSubscriberCount: parseCount(text(owner.subscriberCountText)),
      videoStreams: [],
      relatedStreams: related,
      comments: commentsData.items,
      commentCount: commentsData.totalCount,
      commentsContinuation: commentsData.nextContinuation,
    };
  });
}

export async function getCommentsPage(
  token: string,
): Promise<{ items: PipedComment[]; nextContinuation?: string }> {
  const res = await fetchComments(token, 40);
  return { items: res.items, nextContinuation: res.nextContinuation };
}

/** Videos tab of a channel (accepts UC… id or @handle). */
export async function channel(input: string): Promise<ChannelData> {
  const key = `channel:${input.trim()}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const raw = input.trim();
    let browseId = raw.startsWith("UC") ? raw : "";

    if (!browseId) {
      const handle = raw.replace(/^\/?(c\/|user\/|channel\/)?@?/, "");
      const found = await innertube("search", {
        query: handle,
        params: "EgIQAg%3D%3D", // filter = channels
      });
      browseId =
        collect(found, "channelRenderer")[0]?.channelId ??
        collect(found, "browseEndpoint").find((b: Json) => b?.browseId?.startsWith("UC"))
          ?.browseId ??
        "";
      if (!browseId) throw new Error("channel not found");
    }

    const [homeResult, vidsResult, shortsResult] = await Promise.allSettled([
      innertube("browse", { browseId }),
      innertube("browse", { browseId, params: "EgZ2aWRlb3PyBgQKAjoA" }),
      innertube("browse", { browseId, params: "EgZzaG9ydHPyBgUKA5oBAA%3D%3D" }),
    ]);

    const homeData = homeResult.status === "fulfilled" ? homeResult.value : {};
    const data = vidsResult.status === "fulfilled" ? vidsResult.value : {};
    const shortsData = shortsResult.status === "fulfilled" ? shortsResult.value : {};

    const header =
      collect(homeData, "c4TabbedHeaderRenderer")[0] ??
      collect(homeData, "pageHeaderViewModel")[0] ??
      collect(data, "c4TabbedHeaderRenderer")[0] ??
      collect(data, "pageHeaderViewModel")[0] ??
      {};
    const meta =
      collect(homeData, "microformatDataRenderer")[0] ??
      collect(data, "microformatDataRenderer")[0] ??
      {};

    const name =
      text(header.title) ||
      text(collect(header, "dynamicTextViewModel")[0]?.text) ||
      meta.title ||
      "";

    const avatar =
      header?.avatar?.thumbnails?.at(-1)?.url ??
      collect(header, "avatarViewModel")[0]?.image?.sources?.at(-1)?.url ??
      meta.thumbnail?.thumbnails?.at(-1)?.url ??
      "";

    const banner =
      header?.banner?.thumbnails?.at(-1)?.url ??
      collect(header, "banner")[0]?.imageBannerViewModel?.image?.sources?.at(-1)?.url;

    const metaParts = collect(header, "metadataParts").flat();
    const subsPart = metaParts.find((p: Json) =>
      /مشترك|subscri/i.test(text(p?.text) || text(p?.accessibilityLabel)),
    );
    const vidsPart = metaParts.find((p: Json) =>
      /فيديو|video/i.test(text(p?.text) || text(p?.accessibilityLabel)),
    );

    const subscriberText =
      text(subsPart?.text) ||
      text(subsPart?.accessibilityLabel) ||
      text(header.subscriberCountText) ||
      "";
    const videoCountText =
      text(vidsPart?.text) ||
      text(vidsPart?.accessibilityLabel) ||
      text(header.videosCountText) ||
      text(header.videoCountText) ||
      "";

    const subscriberCount = parseCount(subscriberText);
    const videoCount = parseCount(videoCountText);

    /*
     * The @handle. InnerTube exposes it as a canonical/vanity URL on the
     * microformat or header; the metadata parts also carry it verbatim on the
     * newer pageHeaderViewModel. Fall back to scanning the parts for a leading @.
     */
    const handleFromUrl = (u: unknown): string => {
      const m = typeof u === "string" ? /\/(@[^/?#]+)/.exec(u) : null;
      return m?.[1] ?? "";
    };
    const handle =
      handleFromUrl(meta?.urlCanonical) ||
      handleFromUrl(
        header?.channelHandleText?.runs?.[0]?.navigationEndpoint?.commandMetadata
          ?.webCommandMetadata?.url,
      ) ||
      text(header?.channelHandleText) ||
      metaParts.map((pt: Json) => text(pt?.text)).find((v: string) => v.startsWith("@")) ||
      "";

    // Extract channel videos and make sure uploader metadata is set
    const rawVideos = extractVideos(data);
    const homeVideos = extractVideos(homeData).filter((v) => !v.isShort);
    const combinedVideos = rawVideos.length > 0 ? rawVideos : homeVideos;

    const videos = combinedVideos.map((v) => ({
      ...v,
      uploaderName: v.uploaderName || name,
      uploaderAvatar: v.uploaderAvatar || avatar,
      uploaderUrl: v.uploaderUrl || `/channel/${browseId}`,
    }));

    // Extract channel shorts
    const shorts = extractVideos(shortsData).map((s) => ({
      ...s,
      uploaderName: name,
      uploaderAvatar: avatar,
      uploaderUrl: `/channel/${browseId}`,
    }));

    return {
      id: browseId,
      name,
      handle: handle || undefined,
      avatarUrl: avatar,
      bannerUrl: banner,
      subscriberCount: subscriberCount || undefined,
      subscriberText: subscriberText || undefined,
      videoCount: videoCount || undefined,
      videoCountText: videoCountText || undefined,
      description: meta.description ?? "",
      verified: JSON.stringify(header.badges ?? []).includes("VERIFIED"),
      relatedStreams: videos,
      shorts,
      nextVideos: continuationToken(rawVideos.length > 0 ? data : homeData),
      nextShorts: continuationToken(shortsData),
    };
  });
}

function decodeXml(s: string): string {
  const unCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return unCdata
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

/** Lightweight RSS feed for channel videos. Falls back to channel() on failure or 0 items. */
export async function channelFeed(channelId: string): Promise<PipedVideo[]> {
  const raw = channelId.trim();
  const key = `channelfeed:${raw}`;

  return cached(key, 15 * 60 * 1000, async () => {
    let cleanId = raw.startsWith("UC") ? raw : "";
    if (!cleanId) {
      cleanId = raw.replace(/^\/?(c\/|user\/|channel\/)?@?/, "");
    }

    const fallbackToChannel = async (): Promise<PipedVideo[]> => {
      const ch = await channel(raw);
      return ch.relatedStreams || [];
    };

    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(cleanId)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });

      if (!res.ok) {
        return await fallbackToChannel();
      }

      const xml = await res.text();
      const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi);
      if (!entries || entries.length === 0) {
        return await fallbackToChannel();
      }

      const feedAuthorMatch = xml.match(/<feed[\s\S]*?<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
      const feedAuthorName = feedAuthorMatch ? decodeXml(feedAuthorMatch[1]) : "";

      const feedChannelIdMatch = xml.match(/<yt:channelId>([^<]+)<\/yt:channelId>/i);
      const resolvedChannelId = feedChannelIdMatch ? feedChannelIdMatch[1].trim() : cleanId;

      const videos: PipedVideo[] = [];

      for (const entry of entries) {
        const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i);
        const videoId = idMatch ? idMatch[1].trim() : "";
        if (!videoId) continue;

        const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? decodeXml(titleMatch[1]) : "";

        const pubMatch = entry.match(/<published>([^<]+)<\/published>/i);
        const pubStr = pubMatch ? pubMatch[1].trim() : "";
        const uploaded = pubStr ? new Date(pubStr).getTime() : Date.now();

        const authorMatch = entry.match(
          /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i,
        );
        const uploaderName = authorMatch ? decodeXml(authorMatch[1]) : feedAuthorName;

        const viewsMatch =
          entry.match(/<media:statistics[^>]+views="(\d+)"/i) || entry.match(/views="(\d+)"/i);
        const views = viewsMatch ? parseInt(viewsMatch[1], 10) : undefined;

        const linkMatch = entry.match(/<link[^>]+href="([^"]+)"/i);
        const href = linkMatch ? linkMatch[1] : "";
        const isShort = href.includes("/shorts/") || /\/shorts\//i.test(entry);

        videos.push({
          url: `/watch?v=${videoId}`,
          title,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          uploaderName,
          uploaderUrl: `/channel/${resolvedChannelId}`,
          uploaded: Number.isNaN(uploaded) ? Date.now() : uploaded,
          duration: 0,
          views,
          isShort,
        });
      }

      if (videos.length === 0) {
        return await fallbackToChannel();
      }

      return videos;
    } catch {
      return await fallbackToChannel();
    }
  });
}

/** Fetch a generic continuation page (works for channel tabs, playlists, etc). */
export async function browsePage(continuation: string): Promise<Page> {
  const data = await innertube("browse", { continuation });
  return {
    items: extractVideos(data),
    continuation: continuationToken(data),
    channels: [],
    playlists: [],
  };
}

/* ------------------------------------------------------------------ */
/* Frame capture (storyboards)                                         */
/* ------------------------------------------------------------------ */

/**
 * Playback runs inside a cross-origin `youtube.com/embed` iframe, so the
 * browser can never read its pixels. YouTube does, however, publish the
 * decoded frames it uses for scrub previews as public sprite sheets on
 * `i.ytimg.com`. Those are real frames of the real video, addressable by
 * timestamp — which is exactly what an in-page "screenshot" needs.
 *
 * Spec format (`playerStoryboardSpecRenderer.spec`):
 *
 *   <baseUrl with $L/$N placeholders>|<level 0>|<level 1>|…
 *   level := width#height#frameCount#cols#rows#interval#nameReplacement#sigh
 *
 * Levels are listed low → high quality; the last one is the biggest.
 */
/** `lengthSeconds` + storyboard spec, straight from the `player` endpoint. */
/** Desktop Chrome UA — YouTube serves degraded/bot-checked responses to unknown agents. */

/** Decode a raw JSON string body (handles \u0026, \/, \" …) without parsing the whole blob. */

/**
 * Scrape `ytInitialPlayerResponse` out of the watch page HTML.
 *
 * Why this exists: the keyless `youtubei/v1/player` POST that `innertube()` makes is
 * answered with `playabilityStatus: "UNPLAYABLE"` and **no `storyboards` key at all**
 * when it comes from a datacentre IP (verified against YouTube from a cloud host:
 * WEB/MWEB → UNPLAYABLE, WEB_EMBEDDED/TVHTML5 → ERROR, ANDROID/IOS → HTTP 400).
 * A plain browser-shaped GET of the watch page from the same IP returns
 * `playabilityStatus: "OK"` together with the full storyboard spec, so this is the
 * path that actually works in production.
 */
/**
 * A brand-new anonymous YouTube session.
 *
 * `sw.js_data` is 2.8 KB and hands back the same six cookies the 869 KB home
 * page does (`VISITOR_INFO1_LIVE`, `__Secure-YNID`, `YSC` …), so it is the
 * cheapest way to look like a browser that has been to youtube.com before.
 */
async function freshSessionJar(): Promise<string> {
  const jar = [CONSENT_COOKIE];
  try {
    const res = await fetch("https://www.youtube.com/sw.js_data", {
      headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9" },
    });
    const set =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : ([] as string[]);
    // Drain the body so the connection is released promptly.
    await res.text().catch(() => "");
    for (const raw of set) {
      const pair = raw.split(";")[0]?.trim();
      if (pair) jar.push(pair);
    }
  } catch {
    /* the consent cookie alone is still worth sending */
  }
  return jar.join("; ");
}

/**
 * Duration + storyboard spec, scraped from the watch page.
 *
 * YouTube serves the watch page to datacentre IPs either fully or with
 * `playabilityStatus: LOGIN_REQUIRED` and the whole player response stripped —
 * and *which one you get is a coin flip decided per session*, not per video.
 * Measured from a cloud host: a reused session is 0/8, while a fresh session
 * per attempt lands roughly one in three, so retrying with a new cookie jar is
 * the entire trick. Three videos needed 2, 5 and 4 attempts respectively.
 *
 * Each attempt costs ~1.3 MB, hence the explicit budget: callers that merely
 * want a duration ask for one, the screenshot path asks for several.
 */
/** One independent roll of the dice: a new session, one watch-page read. */
async function watchPageAttempt(
  videoId: string,
): Promise<{ duration: number; storyboardSpec: string; status: number }> {
  const cookie = await freshSessionJar();
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
      {
        headers: {
          "user-agent": BROWSER_UA,
          "accept-language": "en-US,en;q=0.9",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: "https://www.youtube.com/",
          cookie,
        },
      },
    );
    if (!res.ok) return { duration: 0, storyboardSpec: "", status: res.status };
    const html = await res.text();
    const spec =
      /"playerStoryboardSpecRenderer":\{"spec":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1] ?? "";
    return {
      duration: Number(/"lengthSeconds":"(\d+)"/.exec(html)?.[1] ?? "") || 0,
      storyboardSpec: spec ? jsonStringValue(spec) : "",
      status: res.status,
    };
  } catch {
    return { duration: 0, storyboardSpec: "", status: 0 };
  }
}

/** How many sessions to race at once. More than this is impolite to both ends. */
const WATCH_PAGE_CONCURRENCY = 3;

async function watchPageMeta(
  videoId: string,
  attempts = 1,
): Promise<{ duration: number; storyboardSpec: string }> {
  let duration = 0;
  let lastStatus = 0;
  const budget = Math.max(1, attempts);

  // The sessions are independent, so attempts are raced in small batches
  // instead of queued. The budget says how many rolls of the dice we are
  // willing to buy, not how long the user should be made to wait for them.
  for (let done = 0; done < budget; done += WATCH_PAGE_CONCURRENCY) {
    const size = Math.min(WATCH_PAGE_CONCURRENCY, budget - done);
    const batch = await Promise.all(Array.from({ length: size }, () => watchPageAttempt(videoId)));

    for (const r of batch) {
      if (!duration && r.duration) duration = r.duration;
      if (r.status) lastStatus = r.status;
    }

    const won = batch.find((r) => r.storyboardSpec);
    if (won) return { duration: duration || won.duration, storyboardSpec: won.storyboardSpec };
  }

  if (!duration && lastStatus && lastStatus !== 200) {
    throw new Error(`watch page → HTTP ${lastStatus}`);
  }
  return { duration, storyboardSpec: "" };
}

/**
 * `youtubei/v1/player`, shaped the way the real web player shapes it.
 *
 * The generic `innertube()` helper posts without the `key` query param and without
 * `origin`/`referer`/`x-youtube-client-*`. Verified against YouTube from a cloud host:
 * that bare form answers `UNPLAYABLE` with no `storyboards` key, while this form
 * answers `OK` with the full spec for the same video from the same IP.
 *
 * Returns `null` instead of throwing so `playerMeta` can fall through to scraping.
 */
async function playerRequest(videoId: string): Promise<Json | null> {
  try {
    const res = await fetch(`${INNERTUBE}/player?key=${INNERTUBE_WEB_KEY}&prettyPrint=false`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": "ar,en;q=0.8",
        "user-agent": BROWSER_UA,
        origin: "https://www.youtube.com",
        referer: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        "x-youtube-client-name": "1",
        "x-youtube-client-version": CLIENT.clientVersion,
      },
      body: JSON.stringify({
        context: { client: CLIENT },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as Json;
  } catch {
    return null;
  }
}

/**
 * Duration + storyboard spec for a video.
 *
 * `attempts` is the watch-page retry budget. Callers that only need a duration
 * pass 1 and stay fast; the screenshot path spends more because a missing spec
 * is the difference between the requested moment and the cover image.
 */
export async function playerMeta(
  videoId: string,
  attempts = 1,
): Promise<{ duration: number; storyboardSpec: string }> {
  type Meta = { duration: number; storyboardSpec: string };
  const key = `playerMeta:${videoId}`;

  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < 6 * 60 * 60 * 1000) {
    const hit = entry.data as Meta;
    // A spec-less result means the bot gate won that round — it is not an
    // answer, so it must never block a later, more determined retry from
    // trying again for six hours.
    if (hit.storyboardSpec || attempts <= 1) return hit;
  }

  let duration = 0;
  let storyboardSpec = "";

  // 1) Browser-shaped InnerTube player call — ~43 KB, and the cheapest source
  //    that could return a storyboard spec from a server IP.
  const res = await playerRequest(videoId);
  if (res) {
    duration = Number(res?.videoDetails?.lengthSeconds ?? 0) || 0;
    storyboardSpec =
      res?.storyboards?.playerStoryboardSpecRenderer?.spec ??
      collect(res, "playerStoryboardSpecRenderer")[0]?.spec ??
      "";
  }

  // 2) Watch-page HTML — far heavier, but the only source that still answers a
  //    datacentre IP, and then only to a freshly minted session.
  if (!storyboardSpec || !duration) {
    try {
      const page = await watchPageMeta(videoId, attempts);
      if (!storyboardSpec) storyboardSpec = page.storyboardSpec;
      if (!duration) duration = page.duration;
    } catch {
      /* keep whatever the API call gave us */
    }
  }

  const result: Meta = { duration, storyboardSpec };
  if (storyboardSpec || duration) cache.set(key, { at: Date.now(), data: result });
  return result;
}

async function fetchAsDataUrl(url: string): Promise<{ dataUrl: string; bytes: number }> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      referer: "https://www.youtube.com/",
    },
  });
  if (!res.ok) throw new Error(`frame fetch → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/jpeg";
  return { dataUrl: `data:${type};base64,${buf.toString("base64")}`, bytes: buf.byteLength };
}

export interface FrameResult {
  /** base64 data URL — same-origin by construction, so canvas stays untainted. */
  sheet: string;
  /** Geometry of the requested frame inside `sheet`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Timestamp the returned frame actually represents. */
  at: number;
  source: "storyboard" | "poster";
  /** Why the storyboard was not used, when `source` is "poster". */
  note?: string;
}

/**
 * Resolve the frame shown at `time` seconds, returned inline as base64 so the
 * browser never performs a cross-origin image read.
 *
 * Degrades to the video poster when a video has no storyboard (very short
 * clips, some live streams); callers must surface which one they got.
 */
export async function videoFrame(videoId: string, time: number): Promise<FrameResult> {
  if (USE_FIXTURE) return fixtureVideoFrame(time);
  const at = Math.max(0, Number.isFinite(time) ? time : 0);
  const problems: string[] = [];

  try {
    // Worth several swings: this is an explicit "give me this exact frame"
    // request, and the alternative is handing back the cover image.
    const { duration, storyboardSpec } = await playerMeta(videoId, 9);
    const levels = parseStoryboardSpec(storyboardSpec);

    if (!levels.length) {
      problems.push(
        storyboardSpec ? "storyboard spec could not be parsed" : "no storyboard available",
      );
    }

    // Highest quality first, but genuinely fall back: a single 403 on the top
    // level used to drop the whole request to the poster, which silently
    // returns the cover image instead of the requested moment.
    for (let i = levels.length - 1; i >= 0; i--) {
      const addr = addressFrame(levels[i]!, at, duration);
      try {
        const { dataUrl } = await fetchAsDataUrl(addr.url);
        return {
          sheet: dataUrl,
          x: addr.x,
          y: addr.y,
          width: addr.width,
          height: addr.height,
          at: addr.at,
          source: "storyboard",
        };
      } catch (e) {
        problems.push(`level ${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }

  for (const name of ["maxresdefault", "sddefault", "hqdefault"]) {
    try {
      const { dataUrl } = await fetchAsDataUrl(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`);
      const size =
        name === "maxresdefault"
          ? { width: 1280, height: 720 }
          : name === "sddefault"
            ? { width: 640, height: 480 }
            : { width: 480, height: 360 };
      return {
        sheet: dataUrl,
        x: 0,
        y: 0,
        ...size,
        at,
        source: "poster",
        // Surfaced in the dialog so a silent downgrade to the cover image is
        // explainable instead of just looking like the wrong frame.
        note: problems[0] ?? "storyboard unavailable",
      };
    } catch {
      // try the next size down
    }
  }

  throw new Error(
    problems.length
      ? `no frame source available (${problems.join("; ")})`
      : "no frame source available for this video",
  );
}
