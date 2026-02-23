import { query } from "@/src/lib/db";

export async function storeEmbedding(
  userId: number,
  role: "user" | "assistant",
  content: string,
  embedding: number[] | null
): Promise<void> {
  if (!embedding) return;
  await query(
    `
      INSERT INTO message_embeddings (user_id, role, content, embedding)
      VALUES ($1, $2, $3, $4)
    `,
    [userId, role, content, embedding]
  );
  await query(
    `DELETE FROM message_embeddings WHERE user_id = $1 AND id NOT IN (
      SELECT id FROM message_embeddings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
    )`,
    [userId]
  );
}

export async function getSimilarMessages(
  userId: number,
  embedding: number[] | null,
  limit = 8
): Promise<Array<{ role: string; content: string }>> {
  if (!embedding) return [];
  const rows = await query<{ role: string; content: string }>(
    `
      SELECT role, content
      FROM message_embeddings
      WHERE user_id = $1
      ORDER BY embedding <-> $2
      LIMIT $3
    `,
    [userId, embedding, limit]
  );
  return rows;
}
