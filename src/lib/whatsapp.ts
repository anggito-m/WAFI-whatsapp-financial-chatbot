import crypto from "node:crypto";
import { env, requireEnv } from "@/src/lib/env";

async function sendWhatsAppPayload(payload: Record<string, unknown>): Promise<void> {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
  const apiVersion = env.WHATSAPP_API_VERSION;

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Failed to send WhatsApp message: ${response.status} ${payload}`);
  }
}

export async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  await sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

export async function sendWhatsAppImage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<void> {
  await sendWhatsAppPayload({
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,
      caption: caption?.slice(0, 1024)
    }
  });
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!env.WHATSAPP_APP_SECRET) {
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = signatureHeader.replace("sha256=", "");
  const digest = crypto.createHmac("sha256", env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  if (expected.length !== digest.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
}
