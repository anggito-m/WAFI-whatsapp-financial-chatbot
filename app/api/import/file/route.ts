import { NextResponse } from "next/server";
import Tesseract from "tesseract.js";
import { createRequire } from "module";
import { env } from "@/src/lib/env";
import { insertIngestFile, insertIngestRow, mapCsvRowToTransaction, parseCsvBuffer } from "@/src/lib/ingest";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const require = createRequire(import.meta.url);

const workerPath = path.join(process.cwd(), "public", "tesseract", "worker.js");
const corePath = path.join(process.cwd(), "public", "tesseract", "tesseract-core.wasm.js");

async function ensureWorkerFiles(): Promise<{ worker: string; core: string }> {
  await Promise.all([fs.access(workerPath), fs.access(corePath)]);
  return { worker: workerPath, core: corePath };
}

function bytesLimit(): number {
  const mb = Number(env.MAX_UPLOAD_MB ?? "2");
  return mb * 1024 * 1024;
}

async function handleCsv(userId: number, file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const { rows, errors } = parseCsvBuffer(buffer);
  const ingest = await insertIngestFile({
    userId,
    source: "csv",
    original_name: file.name,
    mime: file.type || "text/csv",
    size: buffer.byteLength,
    status: errors.length ? "error" : "parsed",
    error: errors.length ? errors.join("; ") : null
  });

  const limitedRows = rows.slice(0, 500);
  for (const row of limitedRows) {
    const parsed = mapCsvRowToTransaction(row);
    await insertIngestRow({
      ingestFileId: ingest.id,
      raw: row,
      parsed,
      status: parsed.amount ? "parsed" : "error",
      error: parsed.amount ? null : "amount missing"
    });
  }

  return NextResponse.json({
    ingest_id: ingest.id,
    rows_parsed: limitedRows.length,
    errors
  });
}

async function handleImage(userId: number, file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const paths = await ensureWorkerFiles();
  const ocr = await Tesseract.recognize(buffer, env.OCR_LANGS ?? "eng+ind", {
    workerPath: paths.worker,
    corePath: paths.core,
    logger: () => {}
  });
  const ingest = await insertIngestFile({
    userId,
    source: "photo",
    original_name: file.name,
    mime: file.type || "image/jpeg",
    size: buffer.byteLength,
    ocr_text: ocr.data.text,
    status: "parsed"
  });

  await insertIngestRow({
    ingestFileId: ingest.id,
    raw: { text: ocr.data.text },
    parsed: null,
    status: "parsed"
  });

  return NextResponse.json({
    ingest_id: ingest.id,
    ocr_preview: ocr.data.text.slice(0, 500)
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const userIdRaw = form.get("user_id");
    const source = form.get("source")?.toString() ?? "unknown";

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    if (!userIdRaw) {
      return NextResponse.json({ error: "user_id is required" }, { status: 400 });
    }
    const userId = Number(userIdRaw);
    if (!Number.isFinite(userId)) {
      return NextResponse.json({ error: "user_id invalid" }, { status: 400 });
    }

    if (file.size > bytesLimit()) {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }

    const mime = file.type || "";
    if (mime === "text/csv" || file.name.toLowerCase().endsWith(".csv")) {
      return handleCsv(userId, file);
    }
    if (mime.startsWith("image/")) {
      return handleImage(userId, file);
    }

    return NextResponse.json({ error: "unsupported mime" }, { status: 415 });
  } catch (error) {
    console.error("import error", error);
    return NextResponse.json({ error: "failed to process file" }, { status: 500 });
  }
}
