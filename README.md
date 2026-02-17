# Personal Finance Bot (Telegram First)

Track personal finances from chat using natural language and AI.  
Current ready channel: Telegram (`/api/telegram`).  
WhatsApp endpoint still exists (`/api/whatsapp`) for later activation.

## Stack
- Next.js (Vercel-ready API routes)
- TypeScript
- PostgreSQL (`pg`, Aiven-compatible)
- Groq API (Llama 4 Maverick)

## Features
- Natural-language transaction logging
- Intent routing:
  - `report`
  - `transaction`
  - `db_command`
  - `chat`
- Reply style:
  - Natural Indonesian (interactive, human-like)
  - Context-aware explanations from your own data
- Database commands from chat:
  - list/filter transactions
  - delete latest or delete by id
  - update latest or update by id
- Reports:
  - today summary
  - weekly/monthly date range summary
  - category spend
  - month-vs-month comparison
  - financial status
- Visualizations on demand:
  - pie chart pendapatan vs pengeluaran
  - time-series pendapatan & pengeluaran harian
  - bar chart pengeluaran per kategori
  - bar chart pendapatan per kategori
  - chart config dibuat dari kode JavaScript yang digenerate AI, lalu dieksekusi di sandbox aman
- Data isolation per chat user id

## Project Structure
- `app/api/telegram/route.ts`: Telegram webhook endpoint
- `telegram/client.ts`: Telegram send message + secret check
- `telegram/handler.ts`: Telegram update handling
- `telegram/set-webhook.mjs`: helper set webhook URL to Telegram
- `app/api/whatsapp/route.ts`: WhatsApp endpoint (optional for later)
- `src/lib/bot.ts`: shared bot orchestration
- `src/lib/ai.ts`: Groq parsing/classification/chat
- `src/lib/finance.ts`: database and report queries
- `db/schema.sql`: schema

## Environment Variables
Copy `.env.example` to `.env.local`:

```bash
DATABASE_URL=postgresql://username:password@host:port/defaultdb?sslmode=require
DATABASE_SSL_REJECT_UNAUTHORIZED=false

GROQ_API_KEY=gsk_...
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=meta-llama/llama-4-maverick-17b-128e-instruct

TELEGRAM_BOT_TOKEN=123456:ABCDEF...
TELEGRAM_WEBHOOK_SECRET=optional_random_secret

# Optional for later WhatsApp activation
WHATSAPP_VERIFY_TOKEN=your_webhook_verify_token
WHATSAPP_ACCESS_TOKEN=your_meta_permanent_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_API_VERSION=v21.0
WHATSAPP_APP_SECRET=optional_for_signature_validation

DEFAULT_CURRENCY=IDR
DEFAULT_TIMEZONE=Asia/Jakarta
```

## Local Setup
1. Install:
   ```bash
   npm install
   ```
2. Init DB:
   ```bash
   npm run db:init
   ```
3. Run:
   ```bash
   npm run dev
   ```

## Telegram Setup
1. Create bot from `@BotFather` and get token.
2. Deploy app to Vercel.
3. Set webhook:
   ```powershell
   $env:TELEGRAM_BOT_TOKEN="123456:ABCDEF..."
   $env:TELEGRAM_WEBHOOK_URL="https://<your-domain>/api/telegram"
   $env:TELEGRAM_WEBHOOK_SECRET="optional_random_secret"
   npm run telegram:set-webhook
   ```
4. Set the same Telegram env vars in Vercel project settings.

## Example Messages
- `keluar 1200000 untuk sewa bulan ini`
- `bayar 45000 untuk bensin di Shell`
- `terima gaji 5000000 dari kantor`
- `ringkasan hari ini`
- `detailkan log pendapatan dan pengeluaran bulan ini`
- `bandingkan maret vs april`
- `buatkan diagram pie pengeluaran vs pendapatan bulan ini`
- `buatkan grafik timeseries pengeluaran dan pendapatan selama sebulan`
- `buatkan bar chart pengeluaran per kategori bulan ini`
- `buatkan bar chart pendapatan per kategori bulan ini`
- `tampilkan 10 transaksi terakhir`
- `hapus transaksi id 12`
- `ubah transaksi terakhir jadi 25000 kategori transport`
