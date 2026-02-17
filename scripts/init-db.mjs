import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env"));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

function toBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function buildDatabaseConfig(rawConnectionString) {
  let connectionString = rawConnectionString;
  let sslMode = null;

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
    // Keep original connection string and fall back to permissive SSL config.
  }

  if (String(sslMode || "").toLowerCase() === "disable") {
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

const dbConfig = buildDatabaseConfig(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: dbConfig.connectionString,
  ssl: dbConfig.ssl
});

try {
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const schema = await fsp.readFile(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Database schema initialized.");
} finally {
  await pool.end();
}
