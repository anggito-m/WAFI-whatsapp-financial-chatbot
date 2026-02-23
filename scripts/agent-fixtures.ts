import assert from "node:assert/strict";
import { runAgent } from "../src/lib/agent";
import { env } from "../src/lib/env";

// Skip when no key
if (!env.GROQ_API_KEY) {
  console.log("SKIP: GROQ_API_KEY not set, skipping agent fixture run.");
  process.exit(0);
}

const dummyUser = {
  id: 1,
  whatsapp_number: "628999000111",
  display_name: "Fixture User",
  currency_code: "IDR",
  timezone: "Asia/Jakarta",
  anomaly_opt_in: true
};

async function assertSisanya() {
  const msg = "Hari ini saya diberi uang 300.000 untuk beli pempek 183.000, beli rak kulkas 80.500 dan beli bensin sisanya";
  const res = await runAgent({
    user: dummyUser,
    message: msg,
    context: "Fixture context"
  });
  assert.ok(res?.actions?.length, "No actions returned");
  const logAction = res.actions.find((a) => a.tool === "log_transactions");
  assert.ok(logAction, "log_transactions not returned");
  const txs = (logAction).params?.transactions ?? [];
  assert.ok(txs.length >= 3, "expected multiple txs");
  const hasRemainder = txs.some((t) => t.is_remainder || t.amount === null);
  assert.ok(hasRemainder, "expected remainder transaction");
  console.log("Fixture sisanya: PASS");
}

async function assertReport() {
  const res = await runAgent({
    user: dummyUser,
    message: "tampilkan ringkasan hari ini",
    context: "Fixture context"
  });
  assert.ok(res?.actions?.some((a) => a.tool === "query_report"), "query_report not used");
  console.log("Fixture report: PASS");
}

async function main() {
  await assertSisanya();
  await assertReport();
}

main().catch((err) => {
  console.error("Fixture error", err);
  process.exit(1);
});
