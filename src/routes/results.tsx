import { createFileRoute } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";

/**
 * YouTube's real search URL. The param is `search_query`, not `q`.
 * `/search?q=` is kept as a redirecting alias in `legacy-search.tsx`.
 */
const searchSchema = z.object({
  search_query: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/results")({
  validateSearch: zodValidator(searchSchema),
  component: () => null,
});
