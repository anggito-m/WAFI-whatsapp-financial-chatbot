import { NextResponse } from "next/server";
import { processIncomingText } from "@/src/lib/bot";
import { env } from "@/src/lib/env";
import { registerIncomingMessage } from "@/src/lib/finance";
import {
  downloadMedia,
  sendWhatsAppImage,
  sendWhatsAppMessage,
  verifyWebhookSignature
} from "@/src/lib/whatsapp";
import type { BotMessage } from "@/src/lib/types";

export const runtime = "nodejs";

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
          document?: { id?: string; mime_type?: string; filename?: string };
          image?: { id?: string; mime_type?: string };
        }>;
      };
    }>;
  }>;
}

async function sendWhatsAppReplies(to: string, messages: BotMessage[]): Promise<void> {
  for (const message of messages) {
    if (message.type === "text") {
      await sendWhatsAppMessage(to, message.text);
      continue;
    }
    await sendWhatsAppImage(to, message.image_url, message.caption);
  }
}

async function forwardFileToImporter(opts: {
  userId: string;
  file: { buffer: Buffer; mime: string; name: string };
  source: "photo" | "csv";
  requestUrl: string;
}): Promise<Response> {
  const form = new FormData();
  // Convert Node Buffer to a BlobPart that satisfies TypeScript in Next.js build
  const blob = new Blob([new Uint8Array(opts.file.buffer)], { type: opts.file.mime });
  form.append("file", blob, opts.file.name);
  form.append("user_id", opts.userId);
  form.append("source", opts.source);
  const importUrl = new URL("/api/import/file", opts.requestUrl).toString();
  return fetch(importUrl, { method: "POST", body: form });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    return NextResponse.json(
      { error: "WHATSAPP_VERIFY_TOKEN belum diatur di environment variables." },
      { status: 500 }
    );
  }

  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Verifikasi webhook gagal." }, { status: 403 });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");

    if (!verifyWebhookSignature(rawBody, signature)) {
      return NextResponse.json({ error: "Signature webhook tidak valid." }, { status: 401 });
    }

    if (!rawBody) {
      return NextResponse.json({ error: "Payload kosong." }, { status: 400 });
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
    } catch (error) {
      console.error("Failed to parse webhook JSON", error);
      return NextResponse.json({ error: "Payload tidak valid." }, { status: 400 });
    }
    if (payload.object !== "whatsapp_business_account") {
      return NextResponse.json({ received: true });
    }

    const entries = payload.entry ?? [];

    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages?.length) {
          continue;
        }

        const contactsByNumber = new Map<string, string>();
        for (const contact of value.contacts ?? []) {
          if (contact.wa_id && contact.profile?.name) {
            contactsByNumber.set(contact.wa_id, contact.profile.name);
          }
        }

        for (const message of value.messages) {
          const messageId = message.id;
          const from = message.from;

          if (!messageId || !from) {
            continue;
          }

          const isNewMessage = await registerIncomingMessage(messageId);
          if (!isNewMessage) {
            continue;
          }

          try {
            // Handle documents (CSV) and images (receipt)
            if (message.type === "document" && message.document?.id) {
              const media = await downloadMedia(message.document.id);
              const resp = await forwardFileToImporter({
                userId: from,
                file: {
                  buffer: media.buffer,
                  mime: media.mime,
                  name: message.document.filename || "upload.csv"
                },
                source: "csv",
                requestUrl: request.url
              });
              const json = await resp.json();
              if (!resp.ok) {
                await sendWhatsAppMessage(from, `Impor CSV gagal: ${json.error ?? "unknown error"}`);
              } else {
                await sendWhatsAppMessage(
                  from,
                  `CSV diterima. ${json.rows_parsed ?? 0} baris diparsing. ID impor: ${json.ingest_id}. Aku akan siapkan pratinjau transaksi.`
                );
              }
              continue;
            }

            if (message.type === "image" && message.image?.id) {
              const media = await downloadMedia(message.image.id);
              const resp = await forwardFileToImporter({
                userId: from,
                file: {
                  buffer: media.buffer,
                  mime: media.mime,
                  name: "photo.jpg"
                },
                source: "photo",
                requestUrl: request.url
              });
              const json = await resp.json();
              if (!resp.ok) {
                await sendWhatsAppMessage(from, `Impor foto gagal: ${json.error ?? "unknown error"}`);
              } else {
                await sendWhatsAppMessage(
                  from,
                  `Foto diterima. Teks terdeteksi (preview): ${json.ocr_preview ?? ""}\nID impor: ${json.ingest_id}. Balas dengan detail jika perlu koreksi.`
                );
              }
              continue;
            }

            if (message.type !== "text" || !message.text?.body?.trim()) {
              await sendWhatsAppMessage(
                from,
                "Saat ini aku hanya bisa memproses pesan teks atau file CSV/foto struk."
              );
              continue;
            }

            const reply = await processIncomingText({
              from,
              name: contactsByNumber.get(from) ?? null,
              body: message.text.body.trim()
            });

            await sendWhatsAppReplies(from, reply);
          } catch (error) {
            console.error("Failed to process message", error);
            await sendWhatsAppMessage(
              from,
              "Maaf, ada error saat memproses pesanmu. Coba kirim ulang dalam beberapa detik."
            );
          }
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook handler error", error);
    return NextResponse.json({ error: "Payload webhook tidak valid." }, { status: 400 });
  }
}
