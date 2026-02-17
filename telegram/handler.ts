import { processIncomingText } from "@/src/lib/bot";
import { registerIncomingMessage } from "@/src/lib/finance";
import { sendTelegramMessage, sendTelegramPhoto } from "@/telegram/client";
import type { BotMessage } from "@/src/lib/types";
import type { TelegramMessage, TelegramUpdate, TelegramUser } from "@/telegram/types";

function resolveDisplayName(user: TelegramUser | undefined): string | null {
  if (!user) {
    return null;
  }
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }
  return user.username ? `@${user.username}` : null;
}

function toInternalUserId(message: TelegramMessage): string {
  const sourceId = message.from?.id ?? message.chat.id;
  return `telegram:${sourceId}`;
}

async function sendTelegramReplies(chatId: number, messages: BotMessage[]): Promise<void> {
  for (const message of messages) {
    if (message.type === "text") {
      await sendTelegramMessage(chatId, message.text);
      continue;
    }
    await sendTelegramPhoto(chatId, message.image_url, message.caption);
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message) {
    return;
  }

  const updateMessageId = `tg:${update.update_id}`;
  const isNewMessage = await registerIncomingMessage(updateMessageId);
  if (!isNewMessage) {
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendTelegramMessage(
      message.chat.id,
      "Saat ini aku hanya bisa proses pesan teks. Contoh: keluar 45000 untuk kopi."
    );
    return;
  }

  try {
    const reply = await processIncomingText({
      from: toInternalUserId(message),
      name: resolveDisplayName(message.from),
      body: text
    });
    await sendTelegramReplies(message.chat.id, reply);
  } catch (error) {
    console.error("Failed to process Telegram update", error);
    await sendTelegramMessage(
      message.chat.id,
      "Terjadi error saat memproses pesanmu. Coba kirim ulang ya."
    );
  }
}
