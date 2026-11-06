export type UpstreamEvent =
  | {
      outcome: "fetched";
      url: string;
      durationMs: number;
      httpStatus: number;
      offers: number;
      skipped: number;
      duplicatesRemoved: number;
    }
  | { outcome: "stale" | "error"; url: string; durationMs: number; httpStatus?: number; error: string };

/** One line per call to the Aquanode marketplace, so the server side of the route is visible in the logs. */
export function logUpstream(event: UpstreamEvent): void {
  if (event.outcome === "fetched") {
    console.info(
      `[aquanode] fetched ${event.httpStatus} in ${event.durationMs}ms offers=${event.offers} skipped=${event.skipped} duplicates=${event.duplicatesRemoved}`,
    );
    return;
  }
  const status = event.httpStatus ? ` ${event.httpStatus}` : "";
  const note = event.outcome === "stale" ? "serving last good data" : "no cached data";
  console.warn(`[aquanode] ${event.outcome}${status} after ${event.durationMs}ms (${note}): ${event.error}`);
}
