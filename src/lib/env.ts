function getOptional(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

export function requireEnv(name: string): string {
  const value = getOptional(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  DATABASE_URL: getOptional("DATABASE_URL"),
  GROQ_API_KEY: getOptional("GROQ_API_KEY"),
  GROQ_BASE_URL: getOptional("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
  GROQ_MODEL:
    getOptional("GROQ_MODEL") ?? "meta-llama/llama-4-maverick-17b-128e-instruct",
  TELEGRAM_BOT_TOKEN: getOptional("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_WEBHOOK_SECRET: getOptional("TELEGRAM_WEBHOOK_SECRET"),
  WHATSAPP_VERIFY_TOKEN: getOptional("WHATSAPP_VERIFY_TOKEN"),
  WHATSAPP_ACCESS_TOKEN: getOptional("WHATSAPP_ACCESS_TOKEN"),
  WHATSAPP_PHONE_NUMBER_ID: getOptional("WHATSAPP_PHONE_NUMBER_ID"),
  WHATSAPP_API_VERSION: getOptional("WHATSAPP_API_VERSION") ?? "v21.0",
  WHATSAPP_APP_SECRET: getOptional("WHATSAPP_APP_SECRET"),
  DEFAULT_CURRENCY: getOptional("DEFAULT_CURRENCY") ?? "IDR",
  DEFAULT_TIMEZONE: getOptional("DEFAULT_TIMEZONE") ?? "Asia/Jakarta",
  OCR_LANGS: getOptional("OCR_LANGS") ?? "eng+ind",
  MAX_UPLOAD_MB: getOptional("MAX_UPLOAD_MB") ?? "2",
  ANOMALY_LOOKBACK_DAYS: getOptional("ANOMALY_LOOKBACK_DAYS") ?? "60",
  TESSERACT_CDN_BASE:
    getOptional("TESSERACT_CDN_BASE") ?? "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist",
  AGENT_MAX_ACTIONS: Number.parseInt(getOptional("AGENT_MAX_ACTIONS") ?? "3", 10),
  AGENT_HISTORY_LIMIT: Number.parseInt(getOptional("AGENT_HISTORY_LIMIT") ?? "10", 10),
  AGENT_MAX_TOKENS: Number.parseInt(getOptional("AGENT_MAX_TOKENS") ?? "8000", 10),
  AGENT_ERROR_BUDGET: Number.parseInt(getOptional("AGENT_ERROR_BUDGET") ?? "3", 10),
  AGENT_DEBUG_LOG: getOptional("AGENT_DEBUG_LOG") === "1",
  VECTOR_DIM: Number.parseInt(getOptional("VECTOR_DIM") ?? "1536", 10),
  EMBEDDING_MODEL: getOptional("EMBEDDING_MODEL") ?? "text-embedding-3-small"
};
