import OpenAI from "openai";
import { env } from "@/src/lib/env";

const embeddingClient =
  env.GROQ_API_KEY && env.EMBEDDING_MODEL
    ? new OpenAI({
        apiKey: env.GROQ_API_KEY,
        baseURL: env.GROQ_BASE_URL
      })
    : null;

export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!embeddingClient) return null;
  try {
    const res = await embeddingClient.embeddings.create({
      model: env.EMBEDDING_MODEL,
      input: text.slice(0, 3000)
    });
    const vector = res.data[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch (error) {
    console.error("embedding failed", error);
    return null;
  }
}
