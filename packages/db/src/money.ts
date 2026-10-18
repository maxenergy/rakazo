/** Convert an exact non-negative USD decimal to micro-USD, rounding upward. */
export function decimalUsdToMicroUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("USD amount must be a non-negative decimal");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new Error("USD exponent is out of range");
  }
  const coefficient = BigInt(match[1] + fraction);
  if (coefficient === 0n) return 0n;
  const shift = exponent - fraction.length + 6;
  if (shift >= 0) return coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (coefficient + divisor - 1n) / divisor;
}
