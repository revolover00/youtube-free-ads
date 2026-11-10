import { createFileRoute } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";

/**
 * YouTube uses `?list=`. `?id=` is this app's original param and is still
 * accepted so existing in-app links keep working.
 */
const searchSchema = z.object({
  list: fallback(z.string(), "").optional(),
  id: fallback(z.string(), "").optional(),
});

export const Route = createFileRoute("/playlist")({
  validateSearch: zodValidator(searchSchema),
  component: () => null,
});
