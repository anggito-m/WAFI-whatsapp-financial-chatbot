import { query } from "../src/lib/db";
import { ensureEnv } from "@next/env";
import path from "path";

ensureEnv(true, { path: path.join(process.cwd(), ".env.local") });

const sql = `
DELETE FROM category_popularity;
INSERT INTO category_popularity (user_id, category, merchant, total, updated_at)
SELECT user_id, category, merchant, SUM(amount) AS total, NOW()
FROM (
  SELECT user_id, category, merchant, amount
  FROM transactions
  WHERE occurred_at >= NOW() - INTERVAL '90 days'
) t
GROUP BY user_id, category, merchant
ORDER BY total DESC
LIMIT 1000;
`;

import { Pool } from "pg";

async function main() {
  const pool = new Pool();
  await pool.query(sql);
  await pool.end();
  console.log("category_popularity refreshed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
