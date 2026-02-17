import { DateTime } from "luxon";

export function formatCurrency(amount: number, currencyCode: string): string {
  const locale = currencyCode.toUpperCase() === "IDR" ? "id-ID" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode.toUpperCase(),
    maximumFractionDigits: 2
  }).format(amount);
}

function parseDate(value: string | Date): DateTime {
  if (value instanceof Date) {
    return DateTime.fromJSDate(value);
  }

  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid) {
    return iso;
  }

  const sql = DateTime.fromSQL(value, { setZone: true });
  if (sql.isValid) {
    return sql;
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return DateTime.fromJSDate(fallback);
  }

  return DateTime.invalid("unparsable");
}

export function formatDateInTimezone(value: string | Date, timezone: string): string {
  const parsed = parseDate(value);
  if (!parsed.isValid) {
    return DateTime.now().setZone(timezone).toFormat("dd LLL yyyy");
  }
  return parsed.setZone(timezone).toFormat("dd LLL yyyy");
}

export function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function percentChange(fromValue: number, toValue: number): string {
  if (fromValue === 0 && toValue === 0) {
    return "0.0%";
  }
  if (fromValue === 0) {
    return "n/a";
  }
  const pct = ((toValue - fromValue) / fromValue) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
