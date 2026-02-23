import { NextResponse } from "next/server";
import { query } from "@/src/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await query<{
    user_id: number;
    count: number;
  }>(
    `
      SELECT user_id, COUNT(*) AS count
      FROM anomaly_events
      WHERE created_at >= NOW() - INTERVAL '1 day'
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 50
    `
  );

  return NextResponse.json({
    digest: rows.map((r) => ({ user_id: r.user_id, anomalies: Number(r.count) }))
  });
}
