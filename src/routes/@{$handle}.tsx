import { createFileRoute } from "@tanstack/react-router";

/**
 * Handle URLs: /@MrBeast. The `@` is a literal prefix on the segment, so
 * the `handle` param carries the name without it. TanStack spells a
 * prefixed param as `@{$handle}`.
 */
export const Route = createFileRoute("/@{$handle}")({
  component: () => null,
});
