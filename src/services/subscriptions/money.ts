export function currencyFractionDigits(currencyCode: string): number {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function currencyMinorUnitFactor(currencyCode: string): number {
  return 10 ** currencyFractionDigits(currencyCode);
}

export function formatMinorUnits(amountMinorUnits: number, currencyCode: string, locale = "en-US"): string {
  const factor = currencyMinorUnitFactor(currencyCode);
  return new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode }).format(amountMinorUnits / factor);
}

export function majorAmountToMinorUnits(amount: number, currencyCode: string): number {
  return Math.round(amount * currencyMinorUnitFactor(currencyCode));
}

export function minorUnitsToMajorString(amountMinorUnits: number, currencyCode: string): string {
  const digits = currencyFractionDigits(currencyCode);
  return (amountMinorUnits / 10 ** digits).toFixed(digits);
}

export function isCurrencyCode(value: string): boolean {
  if (!/^[A-Z]{3}$/.test(value)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: value });
    return true;
  } catch {
    return false;
  }
}
