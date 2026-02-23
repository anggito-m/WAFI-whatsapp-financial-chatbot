import { DateTime } from "luxon";
import { query } from "@/src/lib/db";
import { env } from "@/src/lib/env";
import { matchRule } from "@/src/lib/rules";
import { refreshCategoryPopularity } from "@/src/lib/popularity";
import type {
  CategoryRule,
  DailySeriesRow,
  ParsedTransaction,
  SummaryRow,
  TransactionRow,
  TransactionType,
  UserRow
} from "@/src/lib/types";

type RawTransactionRow = Omit<TransactionRow, "amount" | "occurred_at"> & {
  amount: string | number;
  occurred_at: string | Date;
};

function asNumber(value: number | string): number {
  if (typeof value === "number") {
    return value;
  }
  return Number.parseFloat(value);
}

function normalizeCategory(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeOccurredAt(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid) {
    return iso.toUTC().toISO() ?? new Date(value).toISOString();
  }

  const sql = DateTime.fromSQL(value, { setZone: true });
  if (sql.isValid) {
    return sql.toUTC().toISO() ?? new Date(value).toISOString();
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }

  return DateTime.utc().toISO() ?? new Date().toISOString();
}

function mapTransactionRow(row: RawTransactionRow): TransactionRow {
  return {
    ...row,
    amount: asNumber(row.amount),
    occurred_at: normalizeOccurredAt(row.occurred_at)
  };
}

export async function ensureUser(
  whatsappNumber: string,
  displayName?: string | null
): Promise<UserRow> {
  const existing = await query<UserRow>(
    `
      SELECT id, whatsapp_number, display_name, currency_code, timezone, anomaly_opt_in
      FROM users
      WHERE whatsapp_number = $1
      LIMIT 1
    `,
    [whatsappNumber]
  );

  if (existing.length > 0) {
    const user = existing[0];
    if (displayName && displayName.trim() && user.display_name !== displayName.trim()) {
      await query(
        `
          UPDATE users
          SET display_name = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [user.id, displayName.trim()]
      );
      user.display_name = displayName.trim();
    }
    return user;
  }

  const inserted = await query<UserRow>(
    `
      INSERT INTO users (whatsapp_number, display_name, currency_code, timezone)
      VALUES ($1, $2, $3, $4)
      RETURNING id, whatsapp_number, display_name, currency_code, timezone, anomaly_opt_in
    `,
    [
      whatsappNumber,
      displayName?.trim() || null,
      env.DEFAULT_CURRENCY,
      env.DEFAULT_TIMEZONE
    ]
  );

  return inserted[0];
}

export async function registerIncomingMessage(messageId: string): Promise<boolean> {
  const inserted = await query<{ message_id: string }>(
    `
      INSERT INTO processed_whatsapp_messages (message_id)
      VALUES ($1)
      ON CONFLICT (message_id) DO NOTHING
      RETURNING message_id
    `,
    [messageId]
  );

  return inserted.length > 0;
}

export async function createTransaction(
  userId: number,
  payload: ParsedTransaction,
  sourceMessage: string
): Promise<TransactionRow> {
  if (!payload.type || !payload.category || !payload.amount) {
    throw new Error("Invalid transaction payload.");
  }

  const matchedRule: CategoryRule | null = await matchRule(userId, {
    merchant: payload.merchant ?? undefined,
    message: sourceMessage
  });

  if (matchedRule) {
    payload.category = matchedRule.category;
    if (matchedRule.type) {
      payload.type = matchedRule.type;
    }
  }

  const occurredAt =
    payload.occurred_at && DateTime.fromISO(payload.occurred_at).isValid
      ? DateTime.fromISO(payload.occurred_at).toUTC().toISO()
      : DateTime.utc().toISO();

  const created = await query<RawTransactionRow>(
    `
      INSERT INTO transactions (
        user_id, type, category, amount, merchant, note, occurred_at, source_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, type, category, amount, merchant, note, occurred_at
    `,
    [
      userId,
      payload.type,
      normalizeCategory(payload.category),
      payload.amount,
      payload.merchant?.trim() || null,
      payload.note?.trim() || null,
      occurredAt,
      sourceMessage
    ]
  );

  return mapTransactionRow(created[0]);
}

export async function createTransactionsBatch(
  userId: number,
  payloads: ParsedTransaction[],
  sourceMessage: string
): Promise<TransactionRow[]> {
  const results: TransactionRow[] = [];
  for (const p of payloads) {
    const created = await createTransaction(userId, p, sourceMessage);
    results.push(created);
  }
  // Refresh popularity summary (best-effort)
  refreshCategoryPopularity(userId).catch(() => {});
  return results;
}

export async function getSummary(
  userId: number,
  startIso: string,
  endIsoExclusive: string
): Promise<SummaryRow> {
  const rows = await query<{
    income: string | number;
    expense: string | number;
    debt: string | number;
    tx_count: string | number;
  }>(
    `
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense,
        COALESCE(SUM(CASE WHEN type = 'debt' THEN amount END), 0) AS debt,
        COUNT(*) AS tx_count
      FROM transactions
      WHERE user_id = $1
        AND occurred_at >= $2
        AND occurred_at < $3
    `,
    [userId, startIso, endIsoExclusive]
  );

  const row = rows[0];
  return {
    income: asNumber(row.income),
    expense: asNumber(row.expense),
    debt: asNumber(row.debt),
    tx_count: Number(row.tx_count)
  };
}

export async function getTopSpendingCategories(
  userId: number,
  startIso: string,
  endIsoExclusive: string,
  limit = 3
): Promise<Array<{ category: string; total: number }>> {
  const rows = await query<{ category: string; total: string | number }>(
    `
      SELECT category, COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE user_id = $1
        AND type IN ('expense', 'debt')
        AND occurred_at >= $2
        AND occurred_at < $3
      GROUP BY category
      ORDER BY total DESC
      LIMIT $4
    `,
    [userId, startIso, endIsoExclusive, limit]
  );

  return rows.map((row) => ({ category: row.category, total: asNumber(row.total) }));
}

export async function getCategorySpend(
  userId: number,
  category: string,
  startIso: string,
  endIsoExclusive: string
): Promise<number> {
  const rows = await query<{ total: string | number }>(
    `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE user_id = $1
        AND type IN ('expense', 'debt')
        AND category = $2
        AND occurred_at >= $3
        AND occurred_at < $4
    `,
    [userId, normalizeCategory(category), startIso, endIsoExclusive]
  );

  return asNumber(rows[0].total);
}

export async function getRecentTransactions(
  userId: number,
  limit = 8
): Promise<TransactionRow[]> {
  const rows = await query<RawTransactionRow>(
    `
      SELECT id, type, category, amount, merchant, note, occurred_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `,
    [userId, limit]
  );

  return rows.map(mapTransactionRow);
}

export async function listTransactions(
  userId: number,
  options: {
    limit?: number;
    type?: TransactionType | null;
    category?: string | null;
    startIso?: string | null;
    endIsoExclusive?: string | null;
  } = {}
): Promise<TransactionRow[]> {
  const conditions = ["user_id = $1"];
  const params: unknown[] = [userId];

  if (options.type) {
    params.push(options.type);
    conditions.push(`type = $${params.length}`);
  }

  if (options.category) {
    params.push(normalizeCategory(options.category));
    conditions.push(`category = $${params.length}`);
  }

  if (options.startIso) {
    params.push(options.startIso);
    conditions.push(`occurred_at >= $${params.length}`);
  }

  if (options.endIsoExclusive) {
    params.push(options.endIsoExclusive);
    conditions.push(`occurred_at < $${params.length}`);
  }

  const safeLimit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  params.push(safeLimit);

  const rows = await query<RawTransactionRow>(
    `
      SELECT id, type, category, amount, merchant, note, occurred_at
      FROM transactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  return rows.map(mapTransactionRow);
}

export async function getTransactionById(
  userId: number,
  transactionId: number
): Promise<TransactionRow | null> {
  const rows = await query<RawTransactionRow>(
    `
      SELECT id, type, category, amount, merchant, note, occurred_at
      FROM transactions
      WHERE user_id = $1 AND id = $2
      LIMIT 1
    `,
    [userId, transactionId]
  );

  if (rows.length === 0) {
    return null;
  }

  return mapTransactionRow(rows[0]);
}

export async function getLastTransaction(userId: number): Promise<TransactionRow | null> {
  const rows = await listTransactions(userId, { limit: 1 });
  return rows[0] ?? null;
}

export async function deleteTransactionById(
  userId: number,
  transactionId: number
): Promise<TransactionRow | null> {
  const rows = await query<RawTransactionRow>(
    `
      DELETE FROM transactions
      WHERE user_id = $1 AND id = $2
      RETURNING id, type, category, amount, merchant, note, occurred_at
    `,
    [userId, transactionId]
  );

  if (rows.length === 0) {
    return null;
  }

  return mapTransactionRow(rows[0]);
}

export async function deleteLastTransaction(userId: number): Promise<TransactionRow | null> {
  const rows = await query<RawTransactionRow>(
    `
      WITH target AS (
        SELECT id
        FROM transactions
        WHERE user_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1
      )
      DELETE FROM transactions t
      USING target
      WHERE t.id = target.id
      RETURNING t.id, t.type, t.category, t.amount, t.merchant, t.note, t.occurred_at
    `,
    [userId]
  );

  if (rows.length === 0) {
    return null;
  }

  return mapTransactionRow(rows[0]);
}

export async function setAnomalyOptIn(userId: number, optIn: boolean): Promise<void> {
  await query(`UPDATE users SET anomaly_opt_in = $2, updated_at = NOW() WHERE id = $1`, [
    userId,
    optIn
  ]);
}

export async function logAnomalyEvent(input: {
  userId: number;
  transactionId: number;
  reason: string;
  score: number | null;
}): Promise<void> {
  await query(
    `
      INSERT INTO anomaly_events (user_id, transaction_id, reason, score)
      VALUES ($1, $2, $3, $4)
    `,
    [input.userId, input.transactionId, input.reason, input.score]
  );
}

export async function updateTransactionById(
  userId: number,
  transactionId: number,
  update: {
    type?: TransactionType;
    category?: string;
    amount?: number;
    merchant?: string | null;
    note?: string | null;
    occurred_at?: string;
  }
): Promise<TransactionRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId, transactionId];

  if (update.type !== undefined) {
    params.push(update.type);
    sets.push(`type = $${params.length}`);
  }

  if (update.category !== undefined) {
    params.push(normalizeCategory(update.category));
    sets.push(`category = $${params.length}`);
  }

  if (update.amount !== undefined) {
    if (update.amount <= 0) {
      throw new Error("amount must be positive");
    }
    params.push(update.amount);
    sets.push(`amount = $${params.length}`);
  }

  if (update.merchant !== undefined) {
    params.push(update.merchant?.trim() || null);
    sets.push(`merchant = $${params.length}`);
  }

  if (update.note !== undefined) {
    params.push(update.note?.trim() || null);
    sets.push(`note = $${params.length}`);
  }

  if (update.occurred_at !== undefined) {
    const dt = DateTime.fromISO(update.occurred_at);
    if (!dt.isValid) {
      throw new Error("invalid occurred_at");
    }
    params.push(dt.toUTC().toISO());
    sets.push(`occurred_at = $${params.length}`);
  }

  if (sets.length === 0) {
    return getTransactionById(userId, transactionId);
  }

  const rows = await query<RawTransactionRow>(
    `
      UPDATE transactions
      SET ${sets.join(", ")}
      WHERE user_id = $1 AND id = $2
      RETURNING id, type, category, amount, merchant, note, occurred_at
    `,
    params
  );

  if (rows.length === 0) {
    return null;
  }

  return mapTransactionRow(rows[0]);
}

export async function getDailyIncomeExpenseSeries(
  userId: number,
  startIso: string,
  endIsoExclusive: string,
  timezone: string
): Promise<DailySeriesRow[]> {
  const rows = await query<{
    date: string;
    income: string | number;
    expense: string | number;
  }>(
    `
      SELECT
        TO_CHAR((occurred_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN type IN ('expense', 'debt') THEN amount END), 0) AS expense
      FROM transactions
      WHERE user_id = $1
        AND occurred_at >= $2
        AND occurred_at < $3
      GROUP BY (occurred_at AT TIME ZONE $4)::date
      ORDER BY (occurred_at AT TIME ZONE $4)::date
    `,
    [userId, startIso, endIsoExclusive, timezone]
  );

  return rows.map((row) => ({
    date: row.date,
    income: asNumber(row.income),
    expense: asNumber(row.expense)
  }));
}

export async function getCategoryTotalsByType(
  userId: number,
  startIso: string,
  endIsoExclusive: string,
  type: TransactionType,
  limit = 12
): Promise<Array<{ category: string; total: number }>> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const rows = await query<{ category: string; total: string | number }>(
    `
      SELECT category, COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE user_id = $1
        AND type = $2
        AND occurred_at >= $3
        AND occurred_at < $4
      GROUP BY category
      ORDER BY total DESC
      LIMIT $5
    `,
    [userId, type, startIso, endIsoExclusive, safeLimit]
  );

  return rows.map((row) => ({
    category: row.category,
    total: asNumber(row.total)
  }));
}
