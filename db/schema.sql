CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  whatsapp_number TEXT NOT NULL UNIQUE,
  display_name TEXT,
  currency_code VARCHAR(8) NOT NULL DEFAULT 'IDR',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(16) NOT NULL CHECK (type IN ('expense', 'income', 'debt')),
  category TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  merchant TEXT,
  note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_whatsapp_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_occurred_at
  ON transactions(user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_type_occurred_at
  ON transactions(user_id, type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_category_occurred_at
  ON transactions(user_id, category, occurred_at DESC);
