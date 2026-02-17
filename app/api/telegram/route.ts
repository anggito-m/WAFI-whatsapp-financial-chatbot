import { NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/telegram/handler";
import { verifyTelegramSecret } from "@/telegram/client";
import { env } from "@/src/lib/env";
import type { TelegramUpdate } from "@/telegram/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "Endpoint webhook Telegram aktif."
  });
}

export async function POST(request: Request) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return NextResponse.json(
        { ok: false, error: "TELEGRAM_BOT_TOKEN belum diatur di environment variables." },
        { status: 500 }
      );
    }

    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
    if (!verifyTelegramSecret(secretHeader)) {
      return NextResponse.json({ ok: false, error: "Secret webhook Telegram tidak valid." }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    await handleTelegramUpdate(update);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook handler error", error);
    return NextResponse.json({ ok: false, error: "Payload Telegram tidak valid." }, { status: 400 });
  }
}
