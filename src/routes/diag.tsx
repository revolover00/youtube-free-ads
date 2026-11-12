import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";

/**
 * TEMPORARY measurement surface, not part of the app.
 *
 * It exists so the one question that decides the whole "play it anyway"
 * architecture can be answered where it actually matters -- on this server,
 * from this server's IP -- instead of guessed at. Delete it with
 * src/lib/streamProbe.ts once the numbers are recorded.
 */
const searchSchema = z.object({
  v: fallback(z.string(), "lHhs_uvBzkA").default("lHhs_uvBzkA"),
  n: fallback(z.number(), 4).default(4),
});

const probeFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ v: z.string().min(5), n: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const { probeStreams } = await import("../lib/streamProbe");
    return probeStreams(data.v, Math.min(8, Math.max(1, Math.round(data.n))));
  });

export const Route = createFileRoute("/diag")({
  validateSearch: zodValidator(searchSchema),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => probeFn({ data: { v: deps.v, n: deps.n } }),
  component: Diag,
});

function Diag() {
  const data = Route.useLoaderData();
  return (
    <pre id="diag" style={{ whiteSpace: "pre-wrap", padding: 16, fontSize: 12 }}>
      {JSON.stringify(data, null, 1)}
    </pre>
  );
}
