import OpenAI from "openai";
import { env } from "@/src/lib/env";

let warnedOnce = false;

function buildClient(): OpenAI | null {
  if (env.OPENAI_API_KEY && env.EMBEDDING_MODEL) {
    return new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL
    });
  }
  return null;
}

const embeddingClient = buildClient();

async function getEmbeddingFromHuggingFace(text: string): Promise<number[] | null> {
  if (!env.HF_TOKEN || !env.HF_EMBEDDING_MODEL) return null;
  const url =
    env.HF_INFERENCE_URL ??
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${env.HF_EMBEDDING_MODEL}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: text.slice(0, 3000) })
    });
    if (!res.ok) {
      throw new Error(`HF inference ${res.status}`);
    }
    const data = await res.json();
    const vector = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as number[]) : null;
    return Array.isArray(vector) ? vector : null;
  } catch (error: any) {
    if (!warnedOnce) {
      console.error("hf embedding failed", error?.message ?? error);
      warnedOnce = true;
    }
    return null;
  }
}

function normalizeVector(vec: number[] | null): number[] | null {
  if (!vec) return null;
  const target = env.VECTOR_DIM || vec.length;
  if (vec.length === target) return vec;
  if (vec.length > target) return vec.slice(0, target);
  // pad with zeros
  return [...vec, ...Array(target - vec.length).fill(0)];
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!embeddingClient || !env.EMBEDDING_MODEL) {
    // Try HuggingFace fallback
    const hfVec = await getEmbeddingFromHuggingFace(text);
    return normalizeVector(hfVec);
  }
  try {
    const res = await embeddingClient.embeddings.create({
      model: env.EMBEDDING_MODEL,
      input: text.slice(0, 3000)
    });
    const vector = res.data[0]?.embedding;
    return normalizeVector(Array.isArray(vector) ? vector : null);
  } catch (error: any) {
    if (!warnedOnce) {
      console.error("embedding failed", error?.error ?? error);
      warnedOnce = true;
    }
    // fallback to HF if available
    const hfVec = await getEmbeddingFromHuggingFace(text);
    return normalizeVector(hfVec);
  }
}
