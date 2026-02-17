# Telegram Version

Folder ini berisi implementasi channel Telegram yang reuse engine AI + finance yang sama.

## File
- `telegram/types.ts`: tipe payload Telegram update
- `telegram/client.ts`: helper kirim pesan Telegram + verifikasi webhook secret
- `telegram/handler.ts`: parser update Telegram ke flow bot
- `app/api/telegram/route.ts`: endpoint webhook Telegram di Vercel

## Environment
Pastikan variabel ini ada:

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
TELEGRAM_WEBHOOK_SECRET=optional_random_secret
```

## Endpoint
- Webhook URL: `https://<your-domain>/api/telegram`
