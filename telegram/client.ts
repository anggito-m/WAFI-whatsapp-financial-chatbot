import { env, requireEnv } from "@/src/lib/env";

async function sendTelegramPayload(method: string, payload: Record<string, unknown>): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to send Telegram API request: ${response.status} ${details}`);
  }
}

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  await sendTelegramPayload("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true
  });
}

export async function sendTelegramPhoto(
  chatId: number | string,
  photoUrl: string,
  caption?: string
): Promise<void> {
  await sendTelegramPayload("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption?.slice(0, 1024)
  });
}

export function verifyTelegramSecret(secretHeader: string | null): boolean {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return true;
  }
  return secretHeader === env.TELEGRAM_WEBHOOK_SECRET;
}
