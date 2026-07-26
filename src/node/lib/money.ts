// Single money helper. All prices stored as integer paise (₹1 = 100 paise).

const CURRENCY_LABEL = /(?:rs\.?|₹|inr)\s*/gi;

/** Parse a scraped price string/number into integer paise. Returns null if unparseable. */
export function parseToPaise(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  const normalized = input.replace(CURRENCY_LABEL, '').replace(/,/g, '').trim();
  if (!normalized) return null;
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** Format integer paise as ₹X,XXX (Indian grouping). */
export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
  })}`;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function discountPercent(pricePaise: number | null, originalPaise: number | null): number {
  if (!pricePaise || !originalPaise || pricePaise <= 0 || originalPaise <= pricePaise) return 0;
  return Math.round(((originalPaise - pricePaise) / originalPaise) * 100);
}
