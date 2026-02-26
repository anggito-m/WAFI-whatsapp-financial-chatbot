import { DateTime } from "luxon";
import { env } from "@/src/lib/env";
import { query } from "@/src/lib/db";

export type PendingActionType =
  | "delete_all"
  | "delete_all_financial_data"
  | "delete_range"
  | "delete_by_id"
  | "ingest_confirm";

export interface PendingRow {
  id: number;
  user_id: number;
  action: PendingActionType;
  payload: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

function ttlMinutes(): number {
  const m = Number(env.PENDING_TTL_MINUTES ?? "15");
  return Number.isFinite(m) && m > 0 ? m : 15;
}

export async function createPending(userId: number, action: PendingActionType, payload: Record<string, unknown>): Promise<PendingRow> {
  const expires = DateTime.utc().plus({ minutes: ttlMinutes() }).toISO();
  const rows = await query<PendingRow>(
    `
      INSERT INTO pending_actions (user_id, action, payload, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_id, action, payload, expires_at, created_at
    `,
    [userId, action, payload, expires]
  );
  if (env.AGENT_DEBUG_LOG) {
    console.log(`pending:create user=${userId} action=${action} id=${rows[0].id}`);
  }
  return rows[0];
}

export async function getActivePending(userId: number): Promise<PendingRow | null> {
  const rows = await query<PendingRow>(
    `
      SELECT id, user_id, action, payload, expires_at, created_at
      FROM pending_actions
      WHERE user_id = $1 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getPendingById(id: number, userId: number): Promise<PendingRow | null> {
  const rows = await query<PendingRow>(
    `
      SELECT id, user_id, action, payload, expires_at, created_at
      FROM pending_actions
      WHERE id = $1 AND user_id = $2 AND expires_at > NOW()
      LIMIT 1
    `,
    [id, userId]
  );
  return rows[0] ?? null;
}

export async function deletePending(id: number): Promise<void> {
  await query(`DELETE FROM pending_actions WHERE id = $1`, [id]);
}

export async function deletePendingByUser(userId: number): Promise<void> {
  await query(`DELETE FROM pending_actions WHERE user_id = $1`, [userId]);
}

export async function expireOldPending(): Promise<void> {
  await query(`DELETE FROM pending_actions WHERE expires_at <= NOW()`);
}
