import type { MarketEvent } from "@nearodds/types";

export const EVENT_STANDARD = "nearodds_market";
export const EVENT_VERSION = "1.0.0";
const PREFIX = "EVENT_JSON:";

export interface ParsedEvent { logIndex: number; event: MarketEvent["event"]; data: any }

/**
 * Parse EVENT_JSON logs. Anything with a wrong standard/version, malformed JSON or unknown shape is dropped.
 * The CALLER must separately verify the emitting account (executor_id) is a registered market contract.
 */
export function parseEventLogs(logs: string[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  logs.forEach((line, logIndex) => {
    if (!line.startsWith(PREFIX)) return;
    let j: any;
    try { j = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
    if (j?.standard !== EVENT_STANDARD || j?.version !== EVENT_VERSION || typeof j?.event !== "string") return;
    const items = Array.isArray(j.data) ? j.data : [j.data];
    items.forEach((d: any, k: number) => { if (d && typeof d === "object") out.push({ logIndex: logIndex * 100 + k, event: j.event, data: d }); });
  });
  return out;
}

/** Receipt statuses that mean "this receipt itself succeeded". Failure/Unknown receipts contribute nothing. */
export function receiptSucceeded(status: unknown): boolean {
  if (status && typeof status === "object") return "SuccessValue" in (status as object) || "SuccessReceiptId" in (status as object);
  return false;
}
