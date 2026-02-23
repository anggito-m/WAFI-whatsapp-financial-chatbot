import Papa from "papaparse";
import { query } from "@/src/lib/db";
import type { ParsedTransaction, TransactionType } from "@/src/lib/types";

export function parseCsvBuffer(buffer: Buffer): {
  rows: Array<Record<string, string>>;
  errors: string[];
} {
  const result = Papa.parse(buffer.toString("utf8"), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim()
  });
  const rows = (result.data as Array<Record<string, string>>).filter(Boolean);
  const errors = result.errors?.map((e) => e.message) ?? [];
  return { rows, errors };
}

export function mapCsvRowToTransaction(row: Record<string, string>): ParsedTransaction {
  const lowerKeys = Object.keys(row).reduce((acc, key) => {
    acc[key.toLowerCase()] = row[key];
    return acc;
  }, {} as Record<string, string>);

  const amountKey =
    Object.keys(lowerKeys).find((k) => k.includes("amount") || k.includes("nominal") || k === "amt") ??
    "";
  const descKey =
    Object.keys(lowerKeys).find((k) => k.includes("desc") || k.includes("deskripsi") || k.includes("memo")) ??
    "";
  const dateKey =
    Object.keys(lowerKeys).find((k) => k.includes("date") || k.includes("tanggal")) ?? "";
  const typeKey =
    Object.keys(lowerKeys).find((k) => k.includes("type") || k.includes("tipe")) ?? "";

  const rawAmount = lowerKeys[amountKey] ?? "";
  const amount = Number.parseFloat(rawAmount.replace(/[^\d.-]/g, ""));

  const rawType = (lowerKeys[typeKey] ?? "").toLowerCase();
  let type: TransactionType | null = null;
  if (/(income|pemasukan|gaji|masuk)/.test(rawType)) type = "income";
  else if (/(debt|utang|hutang)/.test(rawType)) type = "debt";
  else if (rawType) type = "expense";

  return {
    type,
    category: lowerKeys["category"] || lowerKeys["kategori"] || "lainnya",
    amount: Number.isFinite(amount) ? amount : null,
    merchant: lowerKeys[descKey] || null,
    note: null,
    occurred_at: lowerKeys[dateKey] ? new Date(lowerKeys[dateKey]).toISOString() : null
  };
}

export async function insertIngestFile(params: {
  userId: number;
  source: string;
  original_name: string;
  mime: string;
  size: number;
  ocr_text?: string | null;
  status?: string;
  error?: string | null;
}): Promise<{ id: number }> {
  const rows = await query<{ id: number }>(
    `
      INSERT INTO ingest_files (user_id, source, original_name, mime, size, ocr_text, status, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      params.userId,
      params.source,
      params.original_name,
      params.mime,
      params.size,
      params.ocr_text || null,
      params.status ?? "pending",
      params.error ?? null
    ]
  );
  return rows[0];
}

export async function insertIngestRow(params: {
  ingestFileId: number;
  raw: unknown;
  parsed: ParsedTransaction | null;
  status?: string;
  error?: string | null;
}): Promise<void> {
  await query(
    `
      INSERT INTO ingest_rows (ingest_file_id, raw_payload, parsed_transaction, status, error)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [params.ingestFileId, params.raw, params.parsed, params.status ?? "pending", params.error ?? null]
  );
}
