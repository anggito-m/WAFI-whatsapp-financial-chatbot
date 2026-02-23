import OpenAI from "openai";
import { DateTime } from "luxon";
import { env } from "@/src/lib/env";
import type {
  ChartType,
  DbCommandType,
  MessageIntent,
  ParsedDbCommand,
  ParsedReportQuery,
  ParsedRuleCommand,
  ParsedTransaction
} from "@/src/lib/types";

const llm = env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: env.GROQ_BASE_URL
    })
  : null;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  januari: 1,
  februari: 2,
  maret: 3,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  oktober: 10,
  desember: 12
};

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        "text" in part &&
        (part as { type: string }).type === "text"
    ) as { text?: string } | undefined;
    return textPart?.text ?? null;
  }
  return null;
}

async function requestJson<T>(systemPrompt: string, userPrompt: string): Promise<T | null> {
  if (!llm) {
    return null;
  }

  try {
    const completion = await llm.chat.completions.create({
      model: env.GROQ_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const raw = extractTextContent(completion.choices[0]?.message?.content);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseFlexibleNumber(raw: string): number | null {
  const only = raw.replace(/[^\d.,-]/g, "");
  if (!only) {
    return null;
  }

  const hasDot = only.includes(".");
  const hasComma = only.includes(",");

  let normalized = only;
  if (hasDot && hasComma) {
    const lastDot = only.lastIndexOf(".");
    const lastComma = only.lastIndexOf(",");
    if (lastDot > lastComma) {
      normalized = only.replace(/,/g, "");
    } else {
      normalized = only.replace(/\./g, "").replace(",", ".");
    }
  } else if (hasComma) {
    const decimalGroup = only.split(",");
    normalized =
      decimalGroup[decimalGroup.length - 1].length <= 2
        ? only.replace(",", ".")
        : only.replace(/,/g, "");
  } else {
    normalized = only;
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount;
}

function parsePositiveInt(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function cleanCategoryCandidate(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/\s+/g, " ");
  value = value.replace(/^(untuk|for|on)\s+/i, "");
  value = value.replace(
    /\s+(di|at|from|dari|ke|hari ini|today|kemarin|yesterday|bulan ini|this month|minggu ini|this week)\b.*$/i,
    ""
  );
  value = value.replace(/[.,!?;:]+$/g, "");

  if (!value || value.length < 2) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    return null;
  }

  return value;
}

function extractCategoryFromMessage(text: string): string | null {
  const explicit =
    text.match(/\b(?:kategori|category)\s*[:\-]?\s*([A-Za-z0-9&/' -]{2,80})/i)?.[1] ?? null;
  if (explicit) {
    const cleaned = cleanCategoryCandidate(explicit);
    if (cleaned) {
      return cleaned;
    }
  }

  const purpose =
    text.match(
      /\b(?:untuk|for|on)\s+([A-Za-z0-9&/' -]{2,80}?)(?=\s+(?:di|at|from|dari|ke)\b|$)/i
    )?.[1] ?? null;
  if (purpose) {
    const cleaned = cleanCategoryCandidate(purpose);
    if (cleaned) {
      return cleaned;
    }
  }

  const leading =
    text.match(/^([A-Za-z][A-Za-z0-9&/' -]{1,40})\s+((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?)/i)?.[1] ??
    null;
  if (leading) {
    const cleaned = cleanCategoryCandidate(leading);
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function detectType(text: string): ParsedTransaction["type"] {
  if (
    /(receive|received|income|salary|gaji|pemasukan|terima|dibayar|payment from|got paid)/i.test(
      text
    )
  ) {
    return "income";
  }
  if (/(debt|loan|utang|hutang|cicilan|pinjam|owed|credit)/i.test(text)) {
    return "debt";
  }
  if (/(spent|spend|paid|bought|buy|purchase|expense|cost|bayar|beli|pengeluaran|keluar)/i.test(text)) {
    return "expense";
  }
  return null;
}

function asMonthString(monthNameRaw: string, year: number): string | null {
  const month = MONTHS[monthNameRaw.toLowerCase()];
  if (!month) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function resolveRelativeDate(message: string, timezone: string): string | null {
  const now = DateTime.now().setZone(timezone);
  if (/\b(yesterday|kemarin)\b/i.test(message)) {
    return now.minus({ days: 1 }).toISO();
  }
  if (/\b(today|hari ini)\b/i.test(message)) {
    return now.toISO();
  }
  return null;
}

function fallbackTransaction(message: string, timezone: string): ParsedTransaction {
  const amountMatch = message.match(/((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?)/);
  const amount = amountMatch ? parseFlexibleNumber(amountMatch[1]) : null;

  const merchantMatch = message.match(/\b(?:at|from|to|di|dari|ke)\s+([A-Za-z0-9&.' -]{2,})/i);
  const merchant = merchantMatch?.[1]?.trim() ?? null;

  const noteMatch = message.match(/\b(?:note|catatan)\s*[:\-]?\s*(.+)$/i);
  const note = noteMatch?.[1]?.trim() || null;

  return {
    type: detectType(message),
    category: extractCategoryFromMessage(message) ?? "lainnya",
    amount,
    merchant,
    note,
    occurred_at: resolveRelativeDate(message, timezone)
  };
}

function fallbackIntent(message: string): MessageIntent {
  const normalized = message.toLowerCase();

  if (
    /(database|db|sql|query|raw data|data mentah|hapus transaksi|ubah transaksi|update transaksi|id transaksi|edit transaksi)/i.test(
      normalized
    )
  ) {
    return "db_command";
  }

  if (/(atur aturan|rule|aturan kategori|hapus aturan|lihat aturan|toggle anomali|alert anomali|matikan anomali|nyalakan anomali)/i.test(normalized)) {
    return "rule_command";
  }

  if (
    /(report|summary|ringkasan|detail|rincian|log|chart|grafik|diagram|visualisasi|timeseries|tren|compare|banding|status|spending|pengeluaran|pemasukan|pendapatan|income|how much|berapa|minggu ini|bulan ini|hari ini|today|this week|this month)/i.test(
      normalized
    )
  ) {
    return "report";
  }

  if (
    /(\d|\$|rp|idr|inr|rs)/i.test(normalized) &&
    /(spent|paid|bought|received|income|salary|freelance|debt|loan|bayar|beli|gaji|pemasukan|pengeluaran|utang)/i.test(
      normalized
    )
  ) {
    return "transaction";
  }

  return "chat";
}

function fallbackReport(message: string, timezone: string): ParsedReportQuery {
  const now = DateTime.now().setZone(timezone);
  const normalized = message.toLowerCase();
  const wantsChart = /\b(chart|grafik|graph|diagram|visualisasi|timeseries|time series|tren)\b/.test(
    normalized
  );
  const mentionsIncomeExpense =
    /\b(pendapatan|pemasukan|income)\b/.test(normalized) &&
    /\b(pengeluaran|expense|spending)\b/.test(normalized);
  const mentionsExpenseCategory =
    /\b(pengeluaran|expense|spending)\b/.test(normalized) &&
    /\b(kategori|category|per kategori)\b/.test(normalized);
  const mentionsIncomeCategory =
    /\b(pendapatan|pemasukan|income)\b/.test(normalized) &&
    /\b(kategori|category|per kategori)\b/.test(normalized);
  const chartType: ChartType = mentionsExpenseCategory
    ? "bar_expense_by_category"
    : mentionsIncomeCategory
      ? "bar_income_by_category"
      : /\b(pie|donut)\b/.test(normalized)
        ? "pie_income_vs_expense"
        : "timeseries_income_expense";

  if (wantsChart && (mentionsIncomeExpense || mentionsExpenseCategory || mentionsIncomeCategory)) {
    if (/\b(today|hari ini)\b/.test(normalized)) {
      const day = now.toISODate();
      return {
        report_type: "visualization",
        start_date: day,
        end_date: day,
        category: null,
        month_a: null,
        month_b: null,
        chart_type: chartType
      };
    }

    if (/\b(this week|minggu ini|weekly|mingguan)\b/.test(normalized)) {
      return {
        report_type: "visualization",
        start_date: now.startOf("week").toISODate(),
        end_date: now.endOf("week").toISODate(),
        category: null,
        month_a: null,
        month_b: null,
        chart_type: chartType
      };
    }

    return {
      report_type: "visualization",
      start_date: now.startOf("month").toISODate(),
      end_date: now.endOf("month").toISODate(),
      category: null,
      month_a: null,
      month_b: null,
      chart_type: chartType
    };
  }

  const wantsDetail = /\b(detail|rincian|rinci|log)\b/.test(normalized);

  if (wantsDetail && mentionsIncomeExpense) {
    if (/\b(today|hari ini)\b/.test(normalized)) {
      const day = now.toISODate();
      return {
        report_type: "detailed_ledger",
        start_date: day,
        end_date: day,
        category: null,
        month_a: null,
        month_b: null,
        chart_type: null
      };
    }

    if (/\b(this week|minggu ini|weekly|mingguan)\b/.test(normalized)) {
      return {
        report_type: "detailed_ledger",
        start_date: now.startOf("week").toISODate(),
        end_date: now.endOf("week").toISODate(),
        category: null,
        month_a: null,
        month_b: null,
        chart_type: null
      };
    }

    return {
      report_type: "detailed_ledger",
      start_date: now.startOf("month").toISODate(),
      end_date: now.endOf("month").toISODate(),
      category: null,
      month_a: null,
      month_b: null,
      chart_type: null
    };
  }

  const compareMatch =
    normalized.match(/(?:compare|bandingkan?)\s+([a-z]+)\s+(?:vs|dan|and)\s+([a-z]+)/i) ??
    normalized.match(/([a-z]+)\s+vs\s+([a-z]+)/i);

  if (compareMatch) {
    const monthA = asMonthString(compareMatch[1], now.year);
    const monthB = asMonthString(compareMatch[2], now.year);
    if (monthA && monthB) {
      return {
        report_type: "month_comparison",
        start_date: null,
        end_date: null,
        category: null,
        month_a: monthA,
        month_b: monthB,
        chart_type: null
      };
    }
  }

  if (/\b(today|hari ini)\b/.test(normalized)) {
    const day = now.toISODate();
    return {
      report_type: "today_summary",
      start_date: day,
      end_date: day,
      category: null,
      month_a: null,
      month_b: null,
      chart_type: null
    };
  }

  if (/\b(this week|minggu ini|weekly|mingguan)\b/.test(normalized)) {
    const start = now.startOf("week").toISODate();
    const end = now.endOf("week").toISODate();
    return {
      report_type: "date_range_summary",
      start_date: start,
      end_date: end,
      category: null,
      month_a: null,
      month_b: null,
      chart_type: null
    };
  }

  const categoryMatch =
    normalized.match(/(?:how much on|berapa (?:total|pengeluaran)?\s*untuk)\s+([a-z0-9 &-]+)/i) ??
    normalized.match(/(?:show|tampilkan)\s+([a-z0-9 &-]+)\s+(?:spending|pengeluaran)/i);
  if (categoryMatch) {
    return {
      report_type: "category_spend",
      start_date: now.startOf("month").toISODate(),
      end_date: now.endOf("month").toISODate(),
      category: categoryMatch[1].trim(),
      month_a: null,
      month_b: null,
      chart_type: null
    };
  }

  if (/\b(this month|bulan ini|monthly|bulanan)\b/.test(normalized)) {
    return {
      report_type: "date_range_summary",
      start_date: now.startOf("month").toISODate(),
      end_date: now.endOf("month").toISODate(),
      category: null,
      month_a: null,
      month_b: null,
      chart_type: null
    };
  }

  const mentionedMonth = Object.keys(MONTHS).find((month) => normalized.includes(month));
  if (mentionedMonth) {
    const monthValue = asMonthString(mentionedMonth, now.year);
    if (monthValue) {
      const monthDate = DateTime.fromFormat(monthValue, "yyyy-MM", { zone: timezone });
      return {
        report_type: "date_range_summary",
        start_date: monthDate.startOf("month").toISODate(),
        end_date: monthDate.endOf("month").toISODate(),
        category: null,
        month_a: null,
        month_b: null,
        chart_type: null
      };
    }
  }

  return {
    report_type: "financial_status",
    start_date: null,
    end_date: null,
    category: null,
    month_a: null,
    month_b: null,
    chart_type: null
  };
}

function fallbackDbCommand(message: string, timezone: string): ParsedDbCommand {
  const normalized = message.toLowerCase();
  const idMatch = normalized.match(/\b(?:id|#)\s*(\d+)\b/);
  const transactionId = parsePositiveInt(idMatch?.[1]);

  const limitMatch =
    normalized.match(/\b(?:limit|top|teratas)\s*(\d+)\b/) ??
    normalized.match(/\b(?:terakhir|last)\s+(\d+)\b/);
  const limit = parsePositiveInt(limitMatch?.[1]);

  const dateNow = DateTime.now().setZone(timezone);
  const startDate = /\b(this month|bulan ini)\b/.test(normalized)
    ? dateNow.startOf("month").toISODate()
    : /\b(this week|minggu ini)\b/.test(normalized)
      ? dateNow.startOf("week").toISODate()
      : null;
  const endDate = /\b(this month|bulan ini)\b/.test(normalized)
    ? dateNow.endOf("month").toISODate()
    : /\b(this week|minggu ini)\b/.test(normalized)
      ? dateNow.endOf("week").toISODate()
      : null;

  let commandType: DbCommandType = "query";
  if (/\b(hapus|delete|remove)\b/.test(normalized)) {
    commandType = transactionId ? "delete_by_id" : "delete_last_transaction";
  }
  if (/\b(ubah|update|edit|koreksi)\b/.test(normalized)) {
    commandType = transactionId ? "update_by_id" : "update_last_transaction";
  }
  if (/\b(database|db|query|sql|tampilkan|lihat|show)\b/.test(normalized) && commandType === "query") {
    commandType = "query";
  }

  const amountMatch = message.match(/((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?)/);
  const updateAmount = amountMatch ? parseFlexibleNumber(amountMatch[1]) : null;
  const updateType = detectType(message);
  const categoryFromKeywordMatch = normalized.match(/\b(?:kategori|category)\s+([a-z0-9 &-]+)/i);
  const updateCategory = categoryFromKeywordMatch?.[1]?.trim() ?? null;
  const inferredCategory = extractCategoryFromMessage(message);
  const merchantMatch = message.match(/\b(?:merchant|toko|di|dari|from|to)\s+([A-Za-z0-9&.' -]{2,})/i);
  const updateMerchant = merchantMatch?.[1]?.trim() ?? null;
  const noteMatch = message.match(/\b(?:note|catatan)\s*[:\-]?\s*(.+)$/i);
  const updateNote = noteMatch?.[1]?.trim() ?? null;
  const updateOccurredAt = resolveRelativeDate(message, timezone);

  return {
    command_type: commandType,
    transaction_id: transactionId,
    limit,
    filter_type: detectType(message),
    filter_category: /\b(kategori|category|untuk|for|on)\b/i.test(message) ? inferredCategory : null,
    start_date: startDate,
    end_date: endDate,
    update_type: updateType,
    update_category: cleanCategoryCandidate(updateCategory || "") || inferredCategory,
    update_amount: updateAmount,
    update_merchant: updateMerchant,
    update_note: updateNote,
    update_occurred_at: updateOccurredAt
  };
}

function normalizeDbCommand(result: ParsedDbCommand, fallback: ParsedDbCommand): ParsedDbCommand {
  const validTypes = new Set<DbCommandType>([
    "query",
    "delete_last_transaction",
    "delete_by_id",
    "update_last_transaction",
    "update_by_id",
    "unknown"
  ]);

  const commandType = validTypes.has(result.command_type) ? result.command_type : fallback.command_type;

  const safeLimit =
    typeof result.limit === "number" && Number.isFinite(result.limit)
      ? Math.min(Math.max(Math.floor(result.limit), 1), 100)
      : fallback.limit;

  const rawUpdateAmount = (result as unknown as { update_amount?: unknown }).update_amount;
  const normalizedUpdateAmount =
    typeof rawUpdateAmount === "number" && Number.isFinite(rawUpdateAmount)
      ? rawUpdateAmount
      : typeof rawUpdateAmount === "string"
        ? parseFlexibleNumber(rawUpdateAmount)
        : fallback.update_amount;

  return {
    command_type: commandType,
    transaction_id:
      typeof result.transaction_id === "number" && result.transaction_id > 0
        ? Math.floor(result.transaction_id)
        : fallback.transaction_id,
    limit: safeLimit,
    filter_type: result.filter_type ?? fallback.filter_type,
    filter_category: result.filter_category?.trim().toLowerCase() || fallback.filter_category,
    start_date: result.start_date || fallback.start_date,
    end_date: result.end_date || fallback.end_date,
    update_type: result.update_type ?? fallback.update_type,
    update_category: result.update_category?.trim().toLowerCase() || fallback.update_category,
    update_amount: normalizedUpdateAmount,
    update_merchant: result.update_merchant?.trim() || fallback.update_merchant,
    update_note: result.update_note?.trim() || fallback.update_note,
    update_occurred_at:
      result.update_occurred_at && DateTime.fromISO(result.update_occurred_at).isValid
        ? result.update_occurred_at
        : fallback.update_occurred_at
  };
}

export async function classifyMessage(message: string): Promise<MessageIntent> {
  const fallback = fallbackIntent(message);
  const result = await requestJson<{ intent?: MessageIntent }>(
    `Klasifikasikan pesan finansial user ke salah satu intent:
1) report = minta ringkasan, perbandingan, analitik
2) transaction = catat transaksi pemasukan/pengeluaran/utang
3) db_command = perintah langsung ke database (lihat data mentah, hapus/edit transaksi, query data)
4) rule_command = kelola aturan kategori / toggle alert anomali
5) chat = ngobrol finansial umum / saran
Kembalikan JSON: {"intent":"report|transaction|db_command|rule_command|chat"}`,
    `Pesan user: ${message}`
  );

  if (
    result?.intent === "report" ||
    result?.intent === "transaction" ||
    result?.intent === "chat" ||
    result?.intent === "db_command" ||
    result?.intent === "rule_command"
  ) {
    return result.intent;
  }

  return fallback;
}

export async function parseRuleCommand(message: string): Promise<ParsedRuleCommand> {
  const normalized = message.toLowerCase();

  if (/lihat aturan|daftar aturan|rules?/i.test(normalized)) {
    return {
      action: "list",
      rule_id: null,
      pattern_regex: null,
      merchant_contains: null,
      category: null,
      type: null,
      priority: null,
      anomaly_opt_in: null
    };
  }

  if (/hapus aturan|delete rule/i.test(normalized)) {
    const idMatch = normalized.match(/aturan\s*(\d+)/i);
    return {
      action: "delete",
      rule_id: idMatch ? Number(idMatch[1]) : null,
      pattern_regex: null,
      merchant_contains: null,
      category: null,
      type: null,
      priority: null,
      anomaly_opt_in: null
    };
  }

  if (/matikan anomali|nonaktif(an)? alert|disable anomaly|disable alert/i.test(normalized)) {
    return {
      action: "toggle_anomaly",
      rule_id: null,
      pattern_regex: null,
      merchant_contains: null,
      category: null,
      type: null,
      priority: null,
      anomaly_opt_in: false
    };
  }

  if (/nyalakan anomali|aktifkan alert|enable anomaly|enable alert/i.test(normalized)) {
    return {
      action: "toggle_anomaly",
      rule_id: null,
      pattern_regex: null,
      merchant_contains: null,
      category: null,
      type: null,
      priority: null,
      anomaly_opt_in: true
    };
  }

  if (/atur aturan|rule|aturan kategori/i.test(normalized)) {
    const merchantMatch = normalized.match(/merchant\s+([a-z0-9 .'-]+)/i);
    const categoryMatch =
      normalized.match(/kategori\s+([a-z0-9 &'-]+)/i) ??
      normalized.match(/=\s*([a-z0-9 &'-]+)/i);
    const typeMatch =
      normalized.match(/\b(expense|pengeluaran)\b/) ||
      normalized.match(/\b(income|pemasukan)\b/) ||
      normalized.match(/\b(debt|utang|hutang)\b/);

    const type =
      typeMatch && /income|pemasukan/.test(typeMatch[0])
        ? "income"
        : typeMatch && /debt|utang|hutang/.test(typeMatch[0])
          ? "debt"
          : typeMatch
            ? "expense"
            : null;

    return {
      action: "create",
      rule_id: null,
      pattern_regex: merchantMatch ? null : ".*",
      merchant_contains: merchantMatch ? merchantMatch[1] : null,
      category: categoryMatch ? categoryMatch[1] : null,
      type,
      priority: null,
      anomaly_opt_in: null
    };
  }

  return {
    action: "unknown",
    rule_id: null,
    pattern_regex: null,
    merchant_contains: null,
    category: null,
    type: null,
    priority: null,
    anomaly_opt_in: null
  };
}

export async function extractTransaction(
  message: string,
  timezone: string
): Promise<ParsedTransaction> {
  const fallback = fallbackTransaction(message, timezone);
  const now = DateTime.now().setZone(timezone).toISO();
  const result = await requestJson<ParsedTransaction>(
    `Ekstrak satu transaksi finansial dari teks user.
Kembalikan JSON persis dengan key:
{
  "type":"expense|income|debt|null",
  "category":"string|null",
  "amount":number|null,
  "merchant":"string|null",
  "note":"string|null",
  "occurred_at":"ISO-8601 datetime atau null"
}
Aturan:
- amount harus angka positif tanpa simbol mata uang.
- jika tanggal tidak jelas, isi null.
- category singkat dan lowercase.`,
    `Sekarang di timezone ${timezone}: ${now}\nPesan: ${message}`
  );

  if (!result) {
    return fallback;
  }

  return {
    type: result.type ?? fallback.type,
    category: result.category?.trim().toLowerCase() || fallback.category,
    amount:
      typeof result.amount === "number"
        ? result.amount
        : typeof result.amount === "string"
          ? parseFlexibleNumber(result.amount)
          : fallback.amount,
    merchant: result.merchant?.trim() || fallback.merchant,
    note: result.note?.trim() || fallback.note,
    occurred_at:
      result.occurred_at && DateTime.fromISO(result.occurred_at).isValid
        ? result.occurred_at
        : fallback.occurred_at
  };
}

export async function parseReportQuery(
  message: string,
  timezone: string
): Promise<ParsedReportQuery> {
  const fallback = fallbackReport(message, timezone);
  const now = DateTime.now().setZone(timezone).toISODate();

  const result = await requestJson<ParsedReportQuery>(
    `Ekstrak intent report finansial user.
Kembalikan JSON:
{
  "report_type":"today_summary|date_range_summary|detailed_ledger|category_spend|month_comparison|visualization|financial_status",
  "start_date":"YYYY-MM-DD atau null",
  "end_date":"YYYY-MM-DD atau null",
  "category":"string atau null",
  "month_a":"YYYY-MM atau null",
  "month_b":"YYYY-MM atau null",
  "chart_type":"pie_income_vs_expense|timeseries_income_expense|bar_expense_by_category|bar_income_by_category|null"
}
Aturan:
- "hari ini/today" => today_summary
- "minggu ini/bulan ini" => date_range_summary
- jika user minta detail/rincian log pemasukan dan pengeluaran => detailed_ledger
- jika user minta visualisasi/chart/diagram pemasukan vs pengeluaran => visualization (pie/timeseries)
- jika user minta bar chart kategori pengeluaran => visualization + bar_expense_by_category
- jika user minta bar chart kategori pendapatan => visualization + bar_income_by_category
- pertanyaan kategori => category_spend
- "Maret vs April" => month_comparison
- jika ambigu => financial_status`,
    `Tanggal hari ini: ${now}, timezone ${timezone}\nPesan user: ${message}`
  );

  if (!result) {
    return fallback;
  }

  const validReportTypes = new Set<ParsedReportQuery["report_type"]>([
    "today_summary",
    "date_range_summary",
    "detailed_ledger",
    "category_spend",
    "month_comparison",
    "visualization",
    "financial_status"
  ]);

  if (!validReportTypes.has(result.report_type)) {
    return fallback;
  }

  return {
    report_type: result.report_type,
    start_date: result.start_date || fallback.start_date,
    end_date: result.end_date || fallback.end_date,
    category: result.category?.trim() || fallback.category,
    month_a: result.month_a || fallback.month_a,
    month_b: result.month_b || fallback.month_b,
    chart_type:
      result.chart_type === "pie_income_vs_expense" ||
      result.chart_type === "timeseries_income_expense" ||
      result.chart_type === "bar_expense_by_category" ||
      result.chart_type === "bar_income_by_category"
        ? result.chart_type
        : fallback.chart_type
  };
}

export async function parseDatabaseCommand(
  message: string,
  timezone: string
): Promise<ParsedDbCommand> {
  const fallback = fallbackDbCommand(message, timezone);
  const today = DateTime.now().setZone(timezone).toISODate();
  const result = await requestJson<ParsedDbCommand>(
    `Ekstrak perintah database dari pesan user ke JSON:
{
  "command_type":"query|delete_last_transaction|delete_by_id|update_last_transaction|update_by_id|unknown",
  "transaction_id":number|null,
  "limit":number|null,
  "filter_type":"expense|income|debt|null",
  "filter_category":"string|null",
  "start_date":"YYYY-MM-DD|null",
  "end_date":"YYYY-MM-DD|null",
  "update_type":"expense|income|debt|null",
  "update_category":"string|null",
  "update_amount":number|null,
  "update_merchant":"string|null",
  "update_note":"string|null",
  "update_occurred_at":"ISO-8601|null"
}
Aturan:
- jika user minta hapus transaksi terakhir => delete_last_transaction
- jika user minta hapus berdasar id => delete_by_id
- jika user minta ubah/edit transaksi terakhir => update_last_transaction
- jika user minta ubah/edit berdasar id => update_by_id
- selain itu query.`,
    `Hari ini: ${today}, timezone: ${timezone}\nPesan user: ${message}`
  );

  if (!result) {
    return fallback;
  }

  return normalizeDbCommand(result, fallback);
}

export async function generateFinancialChatReply(
  message: string,
  context: string
): Promise<string> {
  const fallback =
    "Boleh. Supaya finansial lebih rapi, coba catat semua pengeluaran 7 hari ke depan, lalu kita evaluasi 3 kategori terbesar dan cari penghematan yang paling realistis.";

  if (!llm) {
    return fallback;
  }

  const response = await requestJson<{ reply?: string }>(
    `Kamu asisten keuangan pribadi di chat.
Jawab WAJIB dalam Bahasa Indonesia yang natural, hangat, dan ringkas.
Gaya:
- terasa seperti ngobrol dengan manusia
- gunakan konteks data jika ada
- maksimal 6 baris
- berikan langkah praktis, bukan teori panjang.
Kembalikan JSON: {"reply":"..."}`,
    `Pesan user: ${message}\nKonteks:\n${context}`
  );

  return response?.reply?.trim() || fallback;
}

export async function generateDatabaseNarration(
  message: string,
  context: string
): Promise<string> {
  const fallback =
    "Ini rangkuman data kamu sudah aku ambil. Kalau mau, aku bisa lanjut pecah per kategori, cari tren mingguan, atau bersihkan data tertentu.";

  if (!llm) {
    return fallback;
  }

  const response = await requestJson<{ reply?: string }>(
    `Kamu analis data keuangan pribadi.
Tugasmu: jelaskan hasil query database user dengan Bahasa Indonesia yang natural dan interaktif.
Aturan:
- ringkas (maks 7 baris),
- jelas,
- ajak user lanjut eksplor data berikutnya.
Kembalikan JSON: {"reply":"..."}`,
    `Permintaan user: ${message}\nHasil data:\n${context}`
  );

  return response?.reply?.trim() || fallback;
}
