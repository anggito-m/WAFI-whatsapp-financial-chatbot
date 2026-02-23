import { env } from "@/src/lib/env";
import OpenAI from "openai";
import type {
  ParsedTransaction,
  ParsedReportQuery,
  ParsedDbCommand,
  ParsedRuleCommand,
  UserRow
} from "@/src/lib/types";
import { parseReportQuery, parseDatabaseCommand, parseRuleCommand } from "@/src/lib/ai";

type AgentAction =
  | { tool: "log_transactions"; params: { transactions: ParsedTransaction[] } }
  | { tool: "query_report"; params?: Partial<ParsedReportQuery> }
  | { tool: "db_command"; params?: Partial<ParsedDbCommand> }
  | { tool: "rule_command"; params?: Partial<ParsedRuleCommand> }
  | { tool: "import_summary"; params?: Record<string, unknown> }
  | { tool: "confirm_import"; params: { ingest_id: number } }
  | { tool: "send_reply"; params: { text: string } }
  | { tool: "fallback_error"; params?: { reason?: string } };

type AgentResponse = {
  actions: AgentAction[];
  final_reply?: string;
};

const llm = env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: env.GROQ_BASE_URL
    })
  : null;

function buildSystemPrompt(user: UserRow, context: string): string {
  return `Kamu agen finansial yang bisa memanggil tools untuk mencatat transaksi, membuat laporan, perintah DB, aturan kategori, atau balas teks.
Selalu putuskan sendiri mana pemasukan/pengeluaran/utang dari konteks, jangan bergantung daftar kata.
Jika ada "sisanya", buat satu transaksi expense dengan is_remainder=true dan amount=null (akan dihitung tool).
Selalu isi type dan category (pakai "lainnya" jika tidak jelas).
Kembalikan JSON dengan key: actions (list). Tiap action: {"tool":"...","params":{...}}. Jika hanya mau balas teks, pakai tool "send_reply".
Tools yang tersedia:
- log_transactions: catat array transaksi.
- query_report: buat laporan/visualisasi.
- db_command: query/hapus/update transaksi.
- rule_command: buat/lihat/hapus aturan, toggle alert anomali.
- import_summary: instruksikan user kirim file.
- confirm_import: user memberi ingest_id yang sudah diunggah; ambil draft dan simpan sebagai transaksi.
- send_reply: jawaban teks.
- fallback_error: jika sesuatu tidak jelas, panggil ini dengan reason.`;
}

export async function runAgent(input: {
  user: UserRow;
  message: string;
  context: string;
}): Promise<AgentResponse | null> {
  if (!llm) return null;

  const started = Date.now();
  const systemPrompt = buildSystemPrompt(input.user, input.context);
  const userPrompt = `Pesan user: ${input.message}\nKonteks:\n${input.context}\nBalas dengan JSON: {"actions":[...], "final_reply":optional}`;

  try {
    const completion = await llm.chat.completions.create({
      model: env.GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentResponse;
    if (!parsed.actions || !Array.isArray(parsed.actions)) return null;
    const maxActions = env.AGENT_MAX_ACTIONS && Number.isFinite(env.AGENT_MAX_ACTIONS)
      ? env.AGENT_MAX_ACTIONS
      : 3;
    parsed.actions = parsed.actions.slice(0, maxActions);
    if (env.AGENT_DEBUG_LOG) {
      const duration = Date.now() - started;
      const promptChars = systemPrompt.length + userPrompt.length;
      console.log(
        `agent_debug duration_ms=${duration} prompt_chars=${promptChars} actions=${parsed.actions.length}`
      );
    }
    return parsed;
  } catch (error) {
    console.error("runAgent failed", error);
    return null;
  }
}
