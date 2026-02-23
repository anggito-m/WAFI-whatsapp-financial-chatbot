import { query } from "@/src/lib/db";

export async function refreshCategoryPopularity(userId: number): Promise<void> {
  await query(
    `
      DELETE FROM category_popularity WHERE user_id = $1;
      INSERT INTO category_popularity (user_id, category, merchant, total, updated_at)
      SELECT user_id, category, merchant, SUM(amount) AS total, NOW()
      FROM (
        SELECT user_id, category, merchant, amount
        FROM transactions
        WHERE user_id = $1
          AND occurred_at >= NOW() - INTERVAL '90 days'
      ) t
      GROUP BY user_id, category, merchant
      ORDER BY total DESC
      LIMIT 50;
    `,
    [userId]
  );
}

export async function getTopCategoryMerchant(
  userId: number,
  limit = 10
): Promise<Array<{ category: string; merchant: string | null; total: number }>> {
  const rows = await query<{ category: string; merchant: string | null; total: string | number }>(
    `
      SELECT category, merchant, total
      FROM category_popularity
      WHERE user_id = $1
      ORDER BY total DESC
      LIMIT $2
    `,
    [userId, limit]
  );
  return rows.map((r) => ({
    category: r.category,
    merchant: r.merchant,
    total: typeof r.total === "string" ? Number.parseFloat(r.total) : Number(r.total)
  }));
}
