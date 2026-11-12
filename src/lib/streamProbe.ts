/**
 * TEMPORARY measurement, not a feature.
 *
 * The question it answers is the one that decides whether this app can play a
 * video for someone whose network blocks YouTube outright: can *our* server
 * get a playable media URL, and is the throughput it gets good enough to
 * relay? Everything else -- the cipher, the range proxy, the player -- is only
 * worth building if the answer here is yes.
 *
 * Nothing in the app imports this. It is reached through /diag and is meant
 * to be deleted once the numbers are in.
 */

import { extractJsonVar } from "./htmljson";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CONSENT_COOKIE = "SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg";

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** A brand-new cookie jar per attempt: a reused session is 0/8, a fresh one
 *  lands roughly one in three. That difference is the whole trick. */
async function freshJar(): Promise<string> {
  const jar = [CONSENT_COOKIE];
  try {
    const res = await fetch("https://www.youtube.com/sw.js_data", {
      headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9" },
    });
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
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

export interface StreamProbe {
  videoId: string;
  tries: {
    status: number;
    kb: number;
    botWall: boolean;
    playability: string;
    hasStreaming: boolean;
  }[];
  got: boolean;
  /** What the player response offers, with no URLs echoed back. */
  formats: {
    itag: number;
    mime: string;
    quality: string;
    bitrate: number;
    sizeMb: number;
    hasUrl: boolean;
    hasCipher: boolean;
    hasN: boolean;
  }[];
  adaptiveCount: number;
  playerJs: string;
  /** A real timed read of the first half-megabyte, which is the only honest
   *  answer to "would relaying this actually play". */
  speed: {
    itag: number;
    status: number;
    kb: number;
    ms: number;
    kbps: number;
    note: string;
  } | null;
}

export async function probeStreams(videoId: string, attempts: number): Promise<StreamProbe> {
  const out: StreamProbe = {
    videoId,
    tries: [],
    got: false,
    formats: [],
    adaptiveCount: 0,
    playerJs: "",
    speed: null,
  };

  let player: Json | null = null;

  for (let i = 0; i < attempts && !player; i += 1) {
    const cookie = await freshJar();
    try {
      const res = await fetch(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`,
        {
          headers: {
            "user-agent": BROWSER_UA,
            "accept-language": "en-US,en;q=0.9",
            accept: "text/html,application/xhtml+xml",
            cookie,
          },
        },
      );
      const html = await res.text();
      if (!out.playerJs) {
        out.playerJs = /\/s\/player\/[A-Za-z0-9_/.-]+base\.js/.exec(html)?.[0] ?? "";
      }
      const parsed = extractJsonVar(html, "ytInitialPlayerResponse") as Json | null;
      const streaming = parsed ? obj(parsed.streamingData) : {};
      const hasStreaming =
        Array.isArray(streaming.formats) || Array.isArray(streaming.adaptiveFormats);
      out.tries.push({
        status: res.status,
        kb: Math.round(html.length / 1024),
        botWall: html.includes("Sign in to confirm"),
        playability: str(obj(parsed?.playabilityStatus).status) || "none",
        hasStreaming,
      });
      if (hasStreaming && parsed) player = parsed;
    } catch (e) {
      out.tries.push({
        status: 0,
        kb: 0,
        botWall: false,
        playability: `error: ${String(e).slice(0, 60)}`,
        hasStreaming: false,
      });
    }
  }

  if (!player) return out;
  out.got = true;

  const streaming = obj(player.streamingData);
  const muxed = Array.isArray(streaming.formats) ? (streaming.formats as Json[]) : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats)
    ? (streaming.adaptiveFormats as Json[])
    : [];
  out.adaptiveCount = adaptive.length;

  out.formats = muxed.map((f) => ({
    itag: num(f.itag),
    mime: str(f.mimeType).slice(0, 44),
    quality: str(f.qualityLabel),
    bitrate: num(f.bitrate),
    sizeMb: Math.round(num(f.contentLength) / 1048576),
    hasUrl: !!str(f.url),
    hasCipher: !!str(f.signatureCipher),
    hasN: /[?&]n=/.test(str(f.url) || str(f.signatureCipher)),
  }));

  // Prefer the classic 360p muxed file: one URL, audio included, plays in a
  // plain <video> with no MSE work at all.
  const pick = muxed.find((f) => num(f.itag) === 18) ?? muxed[0];
  const direct = pick ? str(pick.url) : "";

  if (!pick) {
    out.speed = { itag: 0, status: 0, kb: 0, ms: 0, kbps: 0, note: "no muxed format offered" };
    return out;
  }
  if (!direct) {
    out.speed = {
      itag: num(pick.itag),
      status: 0,
      kb: 0,
      ms: 0,
      kbps: 0,
      note: "ciphered: needs base.js to build a URL",
    };
    return out;
  }

  const started = Date.now();
  try {
    const res = await fetch(direct, {
      headers: { "user-agent": BROWSER_UA, range: "bytes=0-524287" },
    });
    const buf = await res.arrayBuffer();
    const ms = Math.max(1, Date.now() - started);
    out.speed = {
      itag: num(pick.itag),
      status: res.status,
      kb: Math.round(buf.byteLength / 1024),
      ms,
      kbps: Math.round(buf.byteLength / 1024 / (ms / 1000)),
      note: res.headers.get("content-type") ?? "",
    };
  } catch (e) {
    out.speed = {
      itag: num(pick.itag),
      status: 0,
      kb: 0,
      ms: Date.now() - started,
      kbps: 0,
      note: String(e).slice(0, 80),
    };
  }

  return out;
}
