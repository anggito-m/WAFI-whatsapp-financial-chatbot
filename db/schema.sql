CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  whatsapp_number TEXT NOT NULL UNIQUE,
  display_name TEXT,
  currency_code VARCHAR(8) NOT NULL DEFAULT 'IDR',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
  anomaly_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
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

CREATE TABLE IF NOT EXISTS category_rules (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern_regex TEXT,
  merchant_contains TEXT,
  category TEXT NOT NULL,
  type VARCHAR(16) CHECK (type IN ('expense', 'income', 'debt')),
  priority INT NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_category_rules_user_priority
  ON category_rules(user_id, priority DESC, id DESC);

CREATE TABLE IF NOT EXISTS ingest_files (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source VARCHAR(16) NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  storage_url TEXT,
  ocr_text TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingest_rows (
  id BIGSERIAL PRIMARY KEY,
  ingest_file_id BIGINT NOT NULL REFERENCES ingest_files(id) ON DELETE CASCADE,
  raw_payload JSONB NOT NULL,
  parsed_transaction JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  score NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_user_created
  ON anomaly_events(user_id, created_at DESC);

-- Memory embeddings
CREATE TABLE IF NOT EXISTS message_embeddings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- user|assistant
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_user_created
  ON message_embeddings(user_id, created_at DESC);

-- Popular categories/merchants (rolling 90d) - can be refreshed by job
CREATE TABLE IF NOT EXISTS category_popularity (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT,
  merchant TEXT,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_occurred_at
  ON transactions(user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_type_occurred_at
  ON transactions(user_id, type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_category_occurred_at
  ON transactions(user_id, category, occurred_at DESC);

-- Pending actions (confirmation flows)
CREATE TABLE IF NOT EXISTS pending_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  payload JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user_expires
  ON pending_actions(user_id, expires_at DESC);

-- Account balance snapshots (per account)
CREATE TABLE IF NOT EXISTS account_balances (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_label TEXT NOT NULL,
  balance NUMERIC(14,2) NOT NULL CHECK (balance >= 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_balances_user_captured
  ON account_balances(user_id, captured_at DESC);
