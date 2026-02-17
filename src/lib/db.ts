import { Pool, type QueryResultRow } from "pg";
import { env } from "@/src/lib/env";

type SslConfig = {
  rejectUnauthorized: boolean;
  ca?: string;
};

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function buildDatabaseConfig(rawConnectionString: string): {
  connectionString: string;
  ssl?: SslConfig;
} {
  let connectionString = rawConnectionString;
  let sslMode: string | null = null;

  // pg parses sslmode from URL and can override `ssl` object options.
  // Strip URL ssl params so runtime SSL config stays deterministic.
  try {
    const parsed = new URL(rawConnectionString);
    sslMode = parsed.searchParams.get("sslmode");

    for (const key of [
      "sslmode",
      "sslcert",
      "sslkey",
      "sslrootcert",
      "sslpassword",
      "sslcrl",
      "uselibpqcompat"
    ]) {
      parsed.searchParams.delete(key);
    }

    connectionString = parsed.toString();
  } catch {
    // If parsing fails, keep original URL and fall back to permissive SSL config.
  }

  if (sslMode?.toLowerCase() === "disable") {
    return { connectionString, ssl: undefined };
  }

  const rejectUnauthorized = toBoolean(
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
    false
  );
  const ca = process.env.DATABASE_SSL_CA;

  return {
    connectionString,
    ssl: ca ? { rejectUnauthorized, ca } : { rejectUnauthorized }
  };
}

const globalForDb = globalThis as typeof globalThis & { __financeBotPool?: Pool };

function getPool(): Pool {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  if (!globalForDb.__financeBotPool) {
    const dbConfig = buildDatabaseConfig(env.DATABASE_URL);
    globalForDb.__financeBotPool = new Pool({
      connectionString: dbConfig.connectionString,
      ssl: dbConfig.ssl
    });
  }

  return globalForDb.__financeBotPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}
