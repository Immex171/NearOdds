import { shortDate } from "@/lib/format";
import type { ActivityItem } from "@/lib/types";
import { EmptyState } from "../ui/bits";

export function ActivityList({ items, loading, unavailable }: { items: ActivityItem[] | null; loading?: boolean; unavailable?: string }) {
  return (
    <section aria-label="Activity" className="rounded-[14px] border border-line bg-card p-4">
      <h2 className="text-lg font-semibold">Activity</h2>
      <div className="mt-2">
        {loading ? <div className="skeleton h-24" /> : !items?.length ? <EmptyState title={unavailable ? "Activity unavailable" : "No activity yet"} body={unavailable} /> : (
          <ul className="divide-y divide-line/60">
            {items.slice(0, 10).map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 py-2 text-sm"><span className="min-w-0">{a.text}</span><time className="shrink-0 text-xs text-mute">{shortDate(a.t)}</time></li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
