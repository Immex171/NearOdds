/** Fixed-point helpers. All amounts are bigint base units; never use floats for money. */
export const DECIMALS = 6;
export const ONE = 10n ** BigInt(DECIMALS);

export type ParseResult = { ok: true; value: bigint } | { ok: false; error: string };

/** Strict decimal parser: digits with optional fraction (max 6 places), no sign or exponent. */
export function tryParseUnits(input: string): ParseResult {
  const s = input.trim();
  if (s === "") return { ok: false, error: "Enter an amount" };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: "Use digits and one decimal point only" };
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) return { ok: false, error: `At most ${DECIMALS} decimal places` };
  return { ok: true, value: BigInt(whole) * ONE + BigInt(frac.padEnd(DECIMALS, "0")) };
}

export function parseUnits(input: string): bigint {
  const r = tryParseUnits(input);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Exact decimal string, trailing zeros trimmed unless `minFraction` asks for more. */
export function formatUnits(value: bigint, minFraction = 0, maxFraction = DECIMALS): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / ONE;
  let frac = (abs % ONE).toString().padStart(DECIMALS, "0");
  if (maxFraction < DECIMALS) {
    // round half up at maxFraction
    const unit = 10n ** BigInt(DECIMALS - maxFraction);
    const rounded = ((abs + unit / 2n) / unit) * unit;
    const w = rounded / ONE;
    frac = (rounded % ONE).toString().padStart(DECIMALS, "0");
    return build(neg && rounded > 0n, w, frac, minFraction, maxFraction);
  }
  return build(neg, whole, frac, minFraction, maxFraction);
}

function build(neg: boolean, whole: bigint, frac: string, minFraction: number, maxFraction: number) {
  let f = frac.slice(0, maxFraction).replace(/0+$/, "");
  if (f.length < minFraction) f = f.padEnd(minFraction, "0");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${f ? "." + f : ""}`;
}

/** price (base units per share, 1_000_000 = 1.0) x quantity (shares in base units) -> collateral base units, rounded down. */
export function mulPrice(price: bigint, qty: bigint): bigint {
  return (price * qty) / ONE;
}

/** Whole-percent display of a 0..1 price. */
export function percent(price: bigint): number {
  return Number((price * 100n + ONE / 2n) / ONE);
}

/** Raw decimal string suitable for contract JSON args. */
export const toArg = (v: bigint) => v.toString();
