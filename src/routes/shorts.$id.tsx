import { createFileRoute } from "@tanstack/react-router";

/** YouTube addresses an individual short as /shorts/<videoId>. */
export const Route = createFileRoute("/shorts/$id")({
  component: () => null,
});
