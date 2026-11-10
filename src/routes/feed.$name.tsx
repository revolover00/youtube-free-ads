import { createFileRoute } from "@tanstack/react-router";

/**
 * YouTube groups the signed-in surfaces under /feed/<name>:
 * subscriptions, you, history, playlists, trending.
 */
export const Route = createFileRoute("/feed/$name")({
  component: () => null,
});
