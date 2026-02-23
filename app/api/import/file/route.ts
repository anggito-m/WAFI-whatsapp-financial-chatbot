import { NextResponse } from "next/server";
import Tesseract from "tesseract.js";
import { createRequire } from "module";
import { env } from "@/src/lib/env";
import { insertIngestFile, insertIngestRow, mapCsvRowToTransaction, parseCsvBuffer } from "@/src/lib/ingest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

const require = createRequire(import.meta.url);
let workerPath: string | undefined;
let corePath: string | undefined;
try {
  workerPath = require.resolve("tesseract.js/src/worker-script/node/index.js");
  corePath = require.resolve("tesseract.js-core/tesseract-core.wasm.js");
} catch (error) {
  console.warn("Tesseract worker/core resolve failed", error);
}

async function ensureWorkerFiles(): Promise<{ worker: string; core: string }> {
  if (workerPath && corePath) {
    return { worker: workerPath, core: corePath };
  }

  const base =
    env.TESSERACT_CDN_BASE ?? "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist";
  const tmpDir = path.join(os.tmpdir(), "tesseract");
  await fs.mkdir(tmpDir, { recursive: true });

  const workerFile = path.join(tmpDir, "worker.min.js");
  const coreFile = path.join(tmpDir, "tesseract-core.wasm.js");

  if (!(await fileExists(workerFile))) {
    await downloadToFile(`${base}/worker.min.js`, workerFile);
  }
  if (!(await fileExists(coreFile))) {
    await downloadToFile(`${base}/tesseract-core.wasm.js`, coreFile);
  }

  return { worker: workerFile, core: coreFile };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buffer);
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
