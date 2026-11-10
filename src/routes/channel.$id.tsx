import { createFileRoute } from "@tanstack/react-router";

/** Canonical channel URL: /channel/UC... */
export const Route = createFileRoute("/channel/$id")({
  component: () => null,
});
