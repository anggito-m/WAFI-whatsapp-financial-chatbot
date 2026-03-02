# WAFI — WhatsApp/Telegram AI Financial Chatbot

**WAFI** (WhatsApp Financial) is a conversational personal finance tracker powered by AI. It lets you log income, expenses, and debts using plain natural-language messages — no forms, no apps to open. Just send a chat message, and WAFI understands, categorizes, stores, and reports your financial activity.

> **Active channel:** Telegram (`/api/telegram`)  
> **Planned channel:** WhatsApp (`/api/whatsapp`, endpoint ready for future activation)

---

## What Is This Project?

WAFI is a Next.js application deployed as a webhook-based chatbot. When you send a message to the bot on Telegram (e.g. _"paid 45,000 for petrol at Shell"_ or _"received salary 5,000,000 from the office"_), the following happens:

1. **AI parsing** — A Groq-hosted LLM (Llama 4 Maverick) classifies the message intent and extracts structured transaction data (amount, type, category, merchant, date).
2. **Rule engine** — Regex/merchant-based rules auto-assign categories and learn from user corrections over time.
3. **Anomaly detection** — Transactions are checked against a 60-day median+MAD baseline; unusual amounts trigger an alert.
4. **Persistence** — Transactions, rules, and user context are stored in PostgreSQL (Aiven-compatible).
5. **Reporting & visualization** — Ask for a summary, and WAFI queries the database and returns a human-readable report or an AI-generated chart image (pie, bar, time-series).
6. **Semantic memory** — Conversation embeddings enable context-aware follow-up answers based on your own financial history.

All data is isolated per chat user ID — no data is shared between users.

---

## Stack
- **Next.js** (Vercel-ready API routes)
- **TypeScript**
- **PostgreSQL** (`pg`, Aiven-compatible) with `pgvector` for semantic memory
- **Groq API** (Llama 4 Maverick) — LLM for intent parsing, classification, and chat
- **Tesseract.js** — OCR for receipt/invoice photo imports (English + Indonesian)
- **PapaParse** — CSV import with preview and confirmation flow
- **Luxon** — timezone-aware date handling

## Features
- Natural-language transaction logging (income / expense / debt)
- AI agent with tool-calling for intent routing:
  - `log_transactions` — record one or more transactions
  - `query_report` — generate reports and charts
  - `db_command` — list, filter, update, or delete transactions from chat
  - `rule_command` — manage auto-categorization rules and anomaly alert toggles
  - `import_summary` / `confirm_import` — guided file import flow
  - `apply_pending_action` — confirmation flows (e.g. bulk deletes)
  - `send_reply` / `fallback_error` — direct text responses
- Reply style:
  - Natural Indonesian (interactive, human-like)
  - Context-aware explanations drawn from the user's own data
- Database commands from chat:
  - List/filter transactions
  - Delete latest or delete by ID
  - Update latest or update by ID
  - Delete all financial data
- Reports:
  - Today's summary
  - Weekly/monthly date-range summary
  - Category spend breakdown
  - Month-vs-month comparison
  - Overall financial status
- On-demand visualizations (AI generates JavaScript chart configs, executed in a safe sandbox):
  - Pie chart: income vs expenses
  - Time-series: daily income & expenses
  - Bar chart: expenses per category
  - Bar chart: income per category
- Rule engine: auto-categorize by regex pattern or merchant name; learns from user corrections
- Anomaly & duplicate detector (median + MAD over 60 days) with real-time alerts and daily digests
- Import transaction evidence:
  - Receipt photos via OCR (Tesseract.js, English + Indonesian)
  - CSV files up to 500 rows, with preview and confirmation step
- Semantic memory via vector embeddings for context-aware conversation
- Account balance snapshots per labeled account
- Per-user data isolation by chat user ID

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
OCR_LANGS=eng+ind
MAX_UPLOAD_MB=2
ANOMALY_LOOKBACK_DAYS=60
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
