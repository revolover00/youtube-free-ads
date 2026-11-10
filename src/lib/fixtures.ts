/**
 * Offline UI fixtures.
 *
 * This sandbox cannot reach YouTube's InnerTube API or i.ytimg.com, so with
 * real data the whole app renders as empty skeletons and none of the layout
 * can be reviewed. Setting `YT_UI_FIXTURE=1` makes the server functions return
 * this canned data instead, which is what makes screenshot-based visual QA
 * possible (see tools/screenshot.mjs).
 *
 * Never enabled in production: the flag is read from the environment and is
 * only ever set by the local screenshot workflow.
 */
import type { PipedVideo, StreamData } from "./types";

export const USE_FIXTURE = process.env["YT_UI_FIXTURE"] === "1";

const FIXTURE_TITLES: [string, string, number, number, string][] = [
  ["I Built a House Underwater for 100 Days", "MrBeast", 48219374, 1123, "2 days ago"],
  ["Why Every City Is Running Out of Water", "Veritasium", 3871204, 1442, "5 days ago"],
  ["The Entire History of Rome in 22 Minutes", "OverSimplified", 12049881, 1327, "1 week ago"],
  ["Minecraft but the World Shrinks Every Minute", "Dream", 9217443, 2048, "3 days ago"],
  ["I Cooked Every Dish From 1800s France", "Bon Appetit", 1402887, 1891, "6 days ago"],
  ["Rust vs Go in 2026 - The Honest Comparison", "Fireship", 2240199, 612, "4 days ago"],
  ["Last to Leave the Circle Wins $500,000", "MrBeast", 71338402, 1402, "1 day ago"],
  ["What Living at the South Pole Is Actually Like", "Tom Scott", 5118320, 988, "2 weeks ago"],
  ["The Physics Problem That Broke Einstein", "Kurzgesagt", 8402117, 743, "1 week ago"],
  ["Driving the World's Most Dangerous Road", "Yes Theory", 3309445, 1611, "9 days ago"],
  ["Every Programming Language Explained in 1 Minute", "Fireship", 6822100, 70, "3 weeks ago"],
  ["I Spent 7 Days in the Sahara With No Map", "Yes Theory", 4119882, 1744, "5 days ago"],
];

const FIXTURE_COLORS = [
  "1f3a5f",
  "5f1f3a",
  "3a5f1f",
  "5f4a1f",
  "1f5f58",
  "3b1f5f",
  "5f1f1f",
  "1f2f5f",
];

function fixtureThumb(i: number): string {
  const c = FIXTURE_COLORS[i % FIXTURE_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#${c}"/><circle cx="320" cy="180" r="54" fill="rgba(255,255,255,0.14)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function fixtureAvatar(i: number): string {
  const c = FIXTURE_COLORS[(i + 3) % FIXTURE_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#${c}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function fixtureVideos(n: number): PipedVideo[] {
  const out: PipedVideo[] = [];
  for (let i = 0; i < n; i++) {
    const [title, uploader, views, duration, date] = FIXTURE_TITLES[i % FIXTURE_TITLES.length]!;
    out.push({
      url: `/watch?v=fixture${i}`,
      title:
        i >= FIXTURE_TITLES.length
          ? `${title} (part ${Math.floor(i / FIXTURE_TITLES.length) + 1})`
          : title,
      thumbnail: fixtureThumb(i),
      uploaderName: uploader,
      uploaderUrl: `/channel/UCfixture${i}`,
      uploaderAvatar: fixtureAvatar(i),
      uploaderVerified: i % 3 === 0,
      uploadedDate: date,
      uploaded: Date.now() - i * 86400000,
      duration,
      views,
      description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.",
    });
  }
  return out;
}

export function fixtureVideoDetails(): StreamData {
  const rel = fixtureVideos(14);
  return {
    title: "I Built a House Underwater for 100 Days",
    description:
      "I spent 100 days living in a sealed habitat 40 feet below the surface. Huge thanks to everyone who made this possible.\n\nChapters:\n00:00 Intro\n02:14 Building the habitat\n09:40 Day 1\n18:05 Things go wrong\n\nFollow us everywhere @example",
    uploadDate: "2026-11-08",
    relativeDate: "2 days ago",
    duration: 1123,
    category: "Entertainment",
    likes: 2104882,
    views: 48219374,
    uploader: "MrBeast",
    uploaderUrl: "/channel/UCfixture0",
    uploaderAvatar: fixtureAvatar(0),
    uploaderVerified: true,
    uploaderSubscriberCount: 342000000,
    videoStreams: [],
    relatedStreams: rel,
    commentCount: 184203,
    comments: Array.from({ length: 10 }, (_, i) => ({
      author: FIXTURE_TITLES[i % FIXTURE_TITLES.length]![1]!,
      thumbnail: fixtureAvatar(i + 2),
      commentText:
        i % 3 === 0
          ? "The amount of planning that went into this is insane. Respect."
          : i % 3 === 1
            ? "Nobody talks about how good the editing is on this channel. Genuinely cinema."
            : "I watched this twice and still cannot believe the part at 18:05.",
      commentedTime: `${i + 1} day${i ? "s" : ""} ago`,
      likeCount: 48211 - i * 3140,
      replyCount: i % 4 === 0 ? 212 : 0,
    })),
  };
}
