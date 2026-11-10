import { createFileRoute } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";

const title = "مشاهدة فيديو — يوتيوب بالعربية";
const description = "شغّل الفيديو بجودة عالية مع الاقتراحات والتعليقات بواجهة عربية سريعة.";

const searchSchema = z.object({
  v: fallback(z.string(), "").default(""),
  /** Start offset, e.g. ?t=90 or ?t=1m30s. */
  t: fallback(z.string(), "").optional(),
  /** Playlist context, as YouTube appends when playing from a list. */
  list: fallback(z.string(), "").optional(),
});

export const Route = createFileRoute("/watch")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "video.other" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => null,
});
