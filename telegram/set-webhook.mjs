import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ?? process.argv[2];
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required.");
}

if (!webhookUrl) {
  throw new Error(
    "Webhook URL is required. Set TELEGRAM_WEBHOOK_URL env var or pass URL as the first argument."
  );
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ["message", "edited_message"]
  })
});

const payload = await response.text();
if (!response.ok) {
  throw new Error(`Failed to set Telegram webhook: ${response.status} ${payload}`);
}

console.log(payload);
