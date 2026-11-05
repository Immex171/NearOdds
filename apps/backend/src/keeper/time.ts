/** UTC instant (ms) for a wall-clock time in an IANA timezone. Handles DST by iterating on the offset. */
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) { off = off2; t = guess - off; }
  return t;
}
export function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
export function localDate(utcMs: number, tz: string): { y: number; m: number; d: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = f.format(new Date(utcMs)).split("-").map(Number);
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
export const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const addDays = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: t.getUTCDay() }; };
export const msToNs = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
