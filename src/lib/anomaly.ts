import { DateTime } from "luxon";
import { query } from "@/src/lib/db";
import type { TransactionRow, UserRow } from "@/src/lib/types";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function mad(values: number[], med: number): number {
  if (values.length === 0) return 0;
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

export async function detectAnomaly(
  user: UserRow,
  transaction: TransactionRow,
  lookbackDays: number
): Promise<{ reason: string; score: number } | null> {
  const since = DateTime.now().minus({ days: lookbackDays }).toISO();
  const rows = await query<{ amount: string | number }>(
    `
      SELECT amount
      FROM transactions
      WHERE user_id = $1
        AND category = $2
        AND occurred_at >= $3
        AND id <> $4
    `,
    [user.id, transaction.category, since, transaction.id]
  );

  const amounts = rows.map((r) => Number(r.amount)).filter((n) => Number.isFinite(n));
  if (amounts.length < 6) {
    return null; // not enough data
  }

  const med = median(amounts);
  const m = mad(amounts, med);
  if (m === 0) {
    return null;
  }

  const score = Math.abs(transaction.amount - med) / m;
  if (score > 3) {
    return {
      reason: `Anomali: nilai menyimpang (${score.toFixed(1)} MAD) dari median ${med.toFixed(0)} untuk kategori ${transaction.category}`,
      score
    };
  }

  return null;
}

export async function detectDuplicate(
  user: UserRow,
  transaction: TransactionRow
): Promise<{ reason: string; score: number } | null> {
  if (!transaction.merchant) {
    return null;
  }
  const windowStart = DateTime.fromISO(transaction.occurred_at).minus({ minutes: 10 }).toISO();
  const rows = await query<{ id: number }>(
    `
      SELECT id
      FROM transactions
      WHERE user_id = $1
        AND merchant = $2
        AND amount = $3
        AND occurred_at >= $4
        AND id <> $5
      LIMIT 1
    `,
    [user.id, transaction.merchant, transaction.amount, windowStart, transaction.id]
  );

  if (rows.length > 0) {
    return {
      reason: "Kemungkinan duplikat (jumlah & merchant sama dalam 10 menit)",
      score: 10
    };
  }
  return null;
}
