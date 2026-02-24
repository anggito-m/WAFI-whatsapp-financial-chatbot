import { DateTime } from "luxon";
import {
  classifyMessage,
  extractTransactions,
  generateDatabaseNarration,
  generateFinancialChatReply,
  parseDatabaseCommand,
  parseReportQuery,
  parseRuleCommand
} from "@/src/lib/ai";
import { runAgent } from "@/src/lib/agent";
import {
  buildExpenseByCategoryBarChart,
  buildIncomeByCategoryBarChart,
  buildIncomeExpenseTimeseriesChart,
  buildPieIncomeExpenseChart
} from "@/src/lib/charts";
import {
  createTransaction,
  createTransactionsBatch,
  deleteLastTransaction,
  deleteTransactionById,
  ensureUser,
  setAnomalyOptIn,
  getCategoryTotalsByType,
  getDailyIncomeExpenseSeries,
  getCategorySpend,
  getLastTransaction,
  getRecentTransactions,
  getSummary,
  getTopSpendingCategories,
  listTransactions,
  logAnomalyEvent,
  updateTransactionById,
  deleteAllTransactions,
  deleteTransactionsByRange
} from "@/src/lib/finance";
import { groundedSummary } from "@/src/lib/grounding";
import { listParsedIngestRows, markIngestFileStatus } from "@/src/lib/ingest";
import { detectAnomaly, detectDuplicate } from "@/src/lib/anomaly";
import { createRule, deleteRule, listRules } from "@/src/lib/rules";
import { redactSensitive, stripUnsafeOutput } from "@/src/lib/safety";
import { getEmbedding } from "@/src/lib/embedding";
import { getSimilarMessages, storeEmbedding } from "@/src/lib/memory";
import { getTopCategoryMerchant } from "@/src/lib/popularity";
import { summarizeMetrics, recordAgentRun } from "@/src/lib/metrics";
import {
  formatCurrency,
  formatDateInTimezone,
  percentChange,
  toTitleCase,
} from "@/src/lib/format";
import { env } from "@/src/lib/env";
import type {
  BotMessage,
  ParsedDbCommand,
  ParsedReportQuery,
  ParsedRuleCommand,
  ParsedTransaction,
  TransactionRow,
  TransactionType,
  UserRow,
} from "@/src/lib/types";

let agentErrorStreak = 0;

interface IncomingTextInput {
  from: string;
  name?: string | null;
  body: string;
}

async function handleTransactionOrFallback(user: UserRow, message: string): Promise<BotMessage[] | null> {
  const intent = await classifyMessage(message);
  if (intent === "transaction") {
    return asText(await handleTransaction(user, message));
  }
  return null;
}

function isCreatorQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\bwho made (you|this bot)\b/.test(normalized) ||
    /\bsiapa\b.*\b(buat|buatnya|bikin|ngembangin|mengembangkan|developer|develop|bat)\b/.test(
      normalized,
    )
  );
}

function isHelpRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\b(help|bantuan|contoh|perintah|cara pakai)\b/.test(normalized);
}

function buildHelpText(user: UserRow): string {
  return [
    "Contoh perintah yang bisa kamu pakai:",
    "- Catat multi transaksi: \"Hari ini diberi 450000 untuk beli pempek 183000, beli rak 80500, bensin sisanya\"",
    "- Laporan: \"laporan pengeluaran minggu ini\" / \"bandingkan pengeluaran Jan vs Feb\"",
    "- Chart: \"buat pie chart pendapatan vs pengeluaran bulan ini\"",
    "- DB lihat: \"tampilkan 20 transaksi terakhir\"",
    "- DB ubah: \"ubah transaksi terakhir jadi 75000 kategori makan siang catatan nasi padang\"",
    "- DB hapus: \"hapus transaksi 3 hari terakhir\" / \"hapus transaksi id 15\" / \"hapus semua transaksi\"",
    "- Aturan kategori: \"atur aturan merchant indomaret = kategori belanja\"",
    "- Anomali: \"matikan alert anomali\" / \"nyalakan alert anomali\"",
    "- Impor: kirim CSV atau foto struk, lalu \"konfirmasi impor <id>\" untuk simpan.",
    "",
    `Zona waktu kamu: ${user.timezone}, mata uang: ${user.currency_code}.`
  ].join("\n");
}

function asText(text: string): BotMessage[] {
  return [{ type: "text", text }];
}

async function handleRuleCommand(user: UserRow, message: string): Promise<string> {
  const parsed: ParsedRuleCommand = await parseRuleCommand(message);

  if (parsed.action === "list") {
    const rules = await listRules(user.id);
    if (!rules.length) {
      return "Belum ada aturan kategori. Contoh: atur aturan merchant indomaret = kategori belanja.";
    }
    const lines = rules.map(
      (r) =>
        `#${r.id} | prioritas ${r.priority} | ${r.merchant_contains ?? r.pattern_regex ?? "-"} => ${toTitleCase(r.category)}${r.type ? ` (${typeLabel(r.type)})` : ""}`
    );
    return ["Daftar aturan kategori:", ...lines].join("\n");
  }

  if (parsed.action === "delete") {
    if (!parsed.rule_id) {
      return "Sebutkan nomor aturan yang mau dihapus. Contoh: hapus aturan 3";
    }
    const ok = await deleteRule(user.id, parsed.rule_id);
    return ok ? `Aturan #${parsed.rule_id} sudah dihapus.` : `Aturan #${parsed.rule_id} tidak ditemukan.`;
  }

  if (parsed.action === "toggle_anomaly") {
    if (parsed.anomaly_opt_in === null) {
      return "Ketik: nyalakan alert anomali / matikan alert anomali.";
    }
    await setAnomalyOptIn(user.id, parsed.anomaly_opt_in);
    return parsed.anomaly_opt_in
      ? "Alert anomali diaktifkan."
      : "Alert anomali dimatikan.";
  }

  if (parsed.action === "create") {
    if (!parsed.category) {
      return "Butuh kategori untuk membuat aturan. Contoh: atur aturan merchant indomaret = kategori belanja.";
    }
    const rule = await createRule({
      userId: user.id,
      merchant_contains: parsed.merchant_contains,
      pattern_regex: parsed.pattern_regex,
      category: parsed.category,
      type: parsed.type,
      priority: parsed.priority ?? 50
    });
    return `Aturan baru dibuat (#${rule.id}) → ${rule.merchant_contains ?? rule.pattern_regex ?? "-"} => ${toTitleCase(rule.category)}${rule.type ? ` (${typeLabel(rule.type)})` : ""}`;
  }

  return "Aku belum paham perintah aturan. Contoh: atur aturan merchant indomaret = kategori belanja.";
}

function typeLabel(type: TransactionType): string {
  if (type === "income") {
    return "Pemasukan";
  }
  if (type === "expense") {
    return "Pengeluaran";
  }
  return "Utang";
}

function toIsoUtc(value: DateTime): string {
  const iso = value.toUTC().toISO();
  if (!iso) {
    throw new Error("Failed to build ISO date.");
  }
  return iso;
}

function toDateRange(
  timezone: string,
  startDate: string | null,
  endDate: string | null,
  fallbackToMonth = true,
) {
  const now = DateTime.now().setZone(timezone);
  const parsedStart = startDate
    ? DateTime.fromISO(startDate, { zone: timezone }).startOf("day")
    : null;
  const parsedEnd = endDate
    ? DateTime.fromISO(endDate, { zone: timezone }).endOf("day")
    : null;

  const start =
    parsedStart?.isValid === true
      ? parsedStart
      : fallbackToMonth
      ? now.startOf("month")
      : now.startOf("day");

  const end =
    parsedEnd?.isValid === true
      ? parsedEnd
      : fallbackToMonth
      ? now.endOf("month")
      : now.endOf("day");

  return {
    startIso: toIsoUtc(start),
    endIsoExclusive: toIsoUtc(end.plus({ milliseconds: 1 })),
    label: `${start.toFormat("dd LLL yyyy")} - ${end.toFormat("dd LLL yyyy")}`,
  };
}

function parseMonth(
  monthValue: string | null,
  timezone: string,
): DateTime | null {
  if (!monthValue) {
    return null;
  }
  const month = DateTime.fromFormat(monthValue, "yyyy-MM", {
    zone: timezone,
  }).startOf("month");
  return month.isValid ? month : null;
}

function formatTransactionLine(transaction: TransactionRow, user: UserRow): string {
  return `#${transaction.id} | ${formatDateInTimezone(transaction.occurred_at, user.timezone)} | ${typeLabel(transaction.type)} | ${toTitleCase(transaction.category)} | ${formatCurrency(transaction.amount, user.currency_code)} | ${transaction.merchant || "-"}`;
}

function dbCommandHelpText(): string {
  return [
    "Contoh perintah database:",
    "1) tampilkan 10 transaksi terakhir",
    "2) hapus transaksi terakhir",
    "3) hapus transaksi id 25",
    "4) ubah transaksi id 25 jadi 50000 kategori transport",
    "5) tampilkan transaksi pengeluaran bulan ini",
  ].join("\n");
}

async function buildTodaySummary(user: UserRow): Promise<string> {
  const now = DateTime.now().setZone(user.timezone);
  const range = toDateRange(
    user.timezone,
    now.toISODate(),
    now.toISODate(),
    false,
  );
  const summary = await getSummary(
    user.id,
    range.startIso,
    range.endIsoExclusive,
  );
  const spent = summary.expense + summary.debt;
  const net = summary.income - spent;

  return [
    `Ringkasan hari ini (${now.toFormat("dd LLL yyyy")})`,
    `- Pemasukan: ${formatCurrency(summary.income, user.currency_code)}`,
    `- Pengeluaran: ${formatCurrency(summary.expense, user.currency_code)}`,
    `- Utang: ${formatCurrency(summary.debt, user.currency_code)}`,
    `- Saldo bersih: ${formatCurrency(net, user.currency_code)}`,
    `- Jumlah transaksi: ${summary.tx_count}`,
  ].join("\n");
}

async function buildRangeSummary(
  user: UserRow,
  startDate: string | null,
  endDate: string | null,
): Promise<string> {
  const range = toDateRange(user.timezone, startDate, endDate, true);
  const summary = await getSummary(
    user.id,
    range.startIso,
    range.endIsoExclusive,
  );
  const topCategories = await getTopSpendingCategories(
    user.id,
    range.startIso,
    range.endIsoExclusive,
    3,
  );
  const spent = summary.expense + summary.debt;
  const net = summary.income - spent;

  return [
    `Ringkasan periode ${range.label}`,
    `- Pemasukan: ${formatCurrency(summary.income, user.currency_code)}`,
    `- Pengeluaran: ${formatCurrency(summary.expense, user.currency_code)}`,
    `- Utang: ${formatCurrency(summary.debt, user.currency_code)}`,
    `- Saldo bersih: ${formatCurrency(net, user.currency_code)}`,
    `- Kategori terbesar: ${
      topCategories.length > 0
        ? topCategories
            .map(
              (item) =>
                `${toTitleCase(item.category)} (${formatCurrency(
                  item.total,
                  user.currency_code,
                )})`,
            )
            .join(", ")
        : "Belum ada data pengeluaran"
    }`,
  ].join("\n");
}

function buildItemLabel(row: TransactionRow): string {
  if (row.merchant && row.merchant.trim().length > 0) {
    return `${toTitleCase(row.merchant)} (${toTitleCase(row.category)})`;
  }
  return toTitleCase(row.category);
}

function buildItemizedSection(
  rows: TransactionRow[],
  currencyCode: string,
  title: string,
): string {
  if (rows.length === 0) {
    return `${title}\n- Tidak ada data`;
  }

  const aggregated = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const key = buildItemLabel(row);
    const current = aggregated.get(key) ?? { total: 0, count: 0 };
    current.total += row.amount;
    current.count += 1;
    aggregated.set(key, current);
  }

  const sorted = [...aggregated.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], "id", { sensitivity: "base" }),
  );
  const maxLines = 25;
  const visible = sorted.slice(0, maxLines);
  const hiddenCount = sorted.length - visible.length;

  const totalValue = rows.reduce((sum, row) => sum + row.amount, 0);
  const lines = visible.map(
    ([label, value]) =>
      `- ${label}: ${formatCurrency(value.total, currencyCode)} (${
        value.count
      } trx)`,
  );

  if (hiddenCount > 0) {
    lines.push(`- ... dan ${hiddenCount} item lainnya`);
  }

  return [
    title,
    ...lines,
    `Total: ${formatCurrency(totalValue, currencyCode)}`,
  ].join("\n");
}

async function buildDetailedLedger(
  user: UserRow,
  startDate: string | null,
  endDate: string | null,
): Promise<string> {
  const range = toDateRange(user.timezone, startDate, endDate, true);
  const transactions = await listTransactions(user.id, {
    limit: 500,
    startIso: range.startIso,
    endIsoExclusive: range.endIsoExclusive,
  });

  const incomeRows = transactions.filter((item) => item.type === "income");
  const expenseRows = transactions.filter((item) => item.type === "expense");
  const debtRows = transactions.filter((item) => item.type === "debt");

  return [
    `Rincian log transaksi (${range.label})`,
    "",
    buildItemizedSection(
      incomeRows,
      user.currency_code,
      "Pemasukan (A-Z item):",
    ),
    "",
    buildItemizedSection(
      expenseRows,
      user.currency_code,
      "Pengeluaran (A-Z item):",
    ),
    "",
    buildItemizedSection(debtRows, user.currency_code, "Utang (A-Z item):"),
  ].join("\n");
}

async function buildCategoryReport(
  user: UserRow,
  category: string | null,
  startDate: string | null,
  endDate: string | null,
): Promise<string> {
  if (!category) {
    return "Aku butuh kategori dulu ya. Contoh: berapa pengeluaran untuk makan bulan ini?";
  }

  const range = toDateRange(user.timezone, startDate, endDate, true);
  const total = await getCategorySpend(
    user.id,
    category.toLowerCase(),
    range.startIso,
    range.endIsoExclusive,
  );

  return [
    `Ringkasan kategori (${range.label})`,
    `${toTitleCase(category)}: ${formatCurrency(total, user.currency_code)}`,
  ].join("\n");
}

async function buildMonthComparison(
  user: UserRow,
  monthAValue: string | null,
  monthBValue: string | null,
): Promise<string> {
  const now = DateTime.now().setZone(user.timezone);
  const monthB = parseMonth(monthBValue, user.timezone) ?? now.startOf("month");
  const monthA =
    parseMonth(monthAValue, user.timezone) ??
    monthB.minus({ months: 1 }).startOf("month");

  const monthARange = {
    start: toIsoUtc(monthA.startOf("month")),
    end: toIsoUtc(monthA.endOf("month").plus({ milliseconds: 1 })),
  };
  const monthBRange = {
    start: toIsoUtc(monthB.startOf("month")),
    end: toIsoUtc(monthB.endOf("month").plus({ milliseconds: 1 })),
  };

  const [summaryA, summaryB, topA, topB] = await Promise.all([
    getSummary(user.id, monthARange.start, monthARange.end),
    getSummary(user.id, monthBRange.start, monthBRange.end),
    getTopSpendingCategories(user.id, monthARange.start, monthARange.end, 2),
    getTopSpendingCategories(user.id, monthBRange.start, monthBRange.end, 2),
  ]);

  const spendingA = summaryA.expense + summaryA.debt;
  const spendingB = summaryB.expense + summaryB.debt;

  return [
    `${monthA.toFormat("LLLL yyyy")} vs ${monthB.toFormat("LLLL yyyy")}`,
    `- Pengeluaran: ${formatCurrency(
      spendingA,
      user.currency_code,
    )} vs ${formatCurrency(spendingB, user.currency_code)} (${percentChange(
      spendingA,
      spendingB,
    )})`,
    `- Pemasukan: ${formatCurrency(
      summaryA.income,
      user.currency_code,
    )} vs ${formatCurrency(
      summaryB.income,
      user.currency_code,
    )} (${percentChange(summaryA.income, summaryB.income)})`,
    `- Top ${monthA.toFormat("LLL")}: ${
      topA.length
        ? topA.map((item) => toTitleCase(item.category)).join(", ")
        : "Belum ada data"
    }`,
    `- Top ${monthB.toFormat("LLL")}: ${
      topB.length
        ? topB.map((item) => toTitleCase(item.category)).join(", ")
        : "Belum ada data"
    }`,
  ].join("\n");
}

async function buildFinancialStatus(user: UserRow): Promise<string> {
  const now = DateTime.now().setZone(user.timezone);
  const monthStart = now.startOf("month");
  const monthEnd = now.endOf("month");

  const summary = await getSummary(
    user.id,
    toIsoUtc(monthStart),
    toIsoUtc(monthEnd.plus({ milliseconds: 1 })),
  );
  const topCategories = await getTopSpendingCategories(
    user.id,
    toIsoUtc(monthStart),
    toIsoUtc(monthEnd.plus({ milliseconds: 1 })),
    3,
  );

  const spent = summary.expense + summary.debt;
  const net = summary.income - spent;
  const savingRate = summary.income > 0 ? (net / summary.income) * 100 : null;

  return [
    `Status keuangan (${monthStart.toFormat("LLLL yyyy")})`,
    `- Pemasukan: ${formatCurrency(summary.income, user.currency_code)}`,
    `- Total keluar (pengeluaran + utang): ${formatCurrency(
      spent,
      user.currency_code,
    )}`,
    `- Saldo bersih: ${formatCurrency(net, user.currency_code)}`,
    `- Saving rate: ${
      savingRate === null ? "n/a" : `${savingRate.toFixed(1)}%`
    }`,
    `- Kategori dominan: ${
      topCategories.length
        ? topCategories.map((item) => toTitleCase(item.category)).join(", ")
        : "Belum ada data"
    }`,
  ].join("\n");
}

async function buildVisualizationReport(
  user: UserRow,
  parsed: ParsedReportQuery,
): Promise<BotMessage[]> {
  const range = toDateRange(
    user.timezone,
    parsed.start_date,
    parsed.end_date,
    true,
  );
  const chartType = parsed.chart_type ?? "timeseries_income_expense";
  const startDate =
    DateTime.fromISO(range.startIso).setZone(user.timezone).toISODate() ?? "";
  const endDate =
    DateTime.fromISO(range.endIsoExclusive)
      .setZone(user.timezone)
      .minus({ days: 1 })
      .toISODate() ?? "";

  if (chartType === "bar_expense_by_category") {
    const rows = await getCategoryTotalsByType(
      user.id,
      range.startIso,
      range.endIsoExclusive,
      "expense",
      15,
    );
    const chart = await buildExpenseByCategoryBarChart({
      categoryTotals: rows,
      periodLabel: range.label,
      currencyCode: user.currency_code,
      formatCurrency,
    });
    return [
      {
        type: "image",
        image_url: chart.imageUrl,
        caption: chart.caption,
      },
      {
        type: "text",
        text: "Kalau kamu mau, aku bisa lanjutkan dengan bar chart kategori pendapatan di periode yang sama.",
      },
    ];
  }

  if (chartType === "bar_income_by_category") {
    const rows = await getCategoryTotalsByType(
      user.id,
      range.startIso,
      range.endIsoExclusive,
      "income",
      15,
    );
    const chart = await buildIncomeByCategoryBarChart({
      categoryTotals: rows,
      periodLabel: range.label,
      currencyCode: user.currency_code,
      formatCurrency,
    });
    return [
      {
        type: "image",
        image_url: chart.imageUrl,
        caption: chart.caption,
      },
      {
        type: "text",
        text: "Kalau kamu mau, aku juga bisa kirim versi bar chart kategori pengeluaran untuk periode yang sama.",
      },
    ];
  }

  if (chartType === "pie_income_vs_expense") {
    const summary = await getSummary(
      user.id,
      range.startIso,
      range.endIsoExclusive,
    );
    const income = summary.income;
    const expense = summary.expense + summary.debt;
    const chart = await buildPieIncomeExpenseChart({
      income,
      expense,
      periodLabel: range.label,
      currencyCode: user.currency_code,
      formatCurrency,
    });
    return [
      {
        type: "image",
        image_url: chart.imageUrl,
        caption: chart.caption,
      },
      {
        type: "text",
        text: "Kalau kamu mau, aku juga bisa bikinin versi tren harian (time series) untuk periode yang sama.",
      },
    ];
  }

  const series = await getDailyIncomeExpenseSeries(
    user.id,
    range.startIso,
    range.endIsoExclusive,
    user.timezone,
  );

  const chart = await buildIncomeExpenseTimeseriesChart({
    series,
    startDate,
    endDate,
    periodLabel: range.label,
    currencyCode: user.currency_code,
    formatCurrency,
  });

  return [
    {
      type: "image",
      image_url: chart.imageUrl,
      caption: chart.caption,
    },
    {
      type: "text",
      text: "Kalau kamu ingin, aku bisa lanjutin dengan pie chart pendapatan vs pengeluaran juga.",
    },
  ];
}

async function buildReportFromQuery(
  user: UserRow,
  parsed: ParsedReportQuery,
): Promise<BotMessage[]> {
  switch (parsed.report_type) {
    case "today_summary":
      return asText(await buildTodaySummary(user));
    case "date_range_summary":
      return asText(
        await buildRangeSummary(user, parsed.start_date, parsed.end_date),
      );
    case "detailed_ledger":
      return asText(
        await buildDetailedLedger(user, parsed.start_date, parsed.end_date),
      );
    case "category_spend":
      return asText(
        await buildCategoryReport(
          user,
          parsed.category,
          parsed.start_date,
          parsed.end_date,
        ),
      );
    case "month_comparison":
      return asText(
        await buildMonthComparison(user, parsed.month_a, parsed.month_b),
      );
    case "visualization":
      return buildVisualizationReport(user, parsed);
    case "financial_status":
    default:
      return asText(await buildFinancialStatus(user));
  }
}

async function handleReport(
  user: UserRow,
  message: string,
): Promise<BotMessage[]> {
  return handleReportGrounded(user, message);
}

async function handleTransaction(
  user: UserRow,
  message: string,
): Promise<string> {
  const parsedList = await extractTransactions(message, user.timezone);

  if (!parsedList.length) {
    return 'Aku belum bisa menangkap detail transaksinya. Coba format seperti: "Keluar 45000 untuk bensin di Shell".';
  }

  // Jika hanya 1, gunakan jalur lama
  if (parsedList.length === 1) {
    const parsed = parsedList[0];
    if (!parsed.type || !parsed.amount || !parsed.category) {
      return 'Aku belum bisa menangkap detail transaksinya. Coba format seperti: "Keluar 45000 untuk bensin di Shell".';
    }
    const created = await createTransaction(user.id, parsed, message);
    const anomalies = await buildAnomalyMessages(user, created);
    return [
      "Siap, transaksinya sudah aku catat.",
      `- ID: #${created.id}`,
      `- Jenis: ${typeLabel(created.type)}`,
      `- Kategori: ${toTitleCase(created.category)}`,
      `- Nominal: ${formatCurrency(created.amount, user.currency_code)}`,
      `- Merchant: ${created.merchant || "-"}`,
      `- Tanggal: ${formatDateInTimezone(created.occurred_at, user.timezone)}`,
      ...(anomalies.length ? ["", ...anomalies] : [])
    ].join("\n");
  }

  // Batch: alokasikan "sisanya" jika ada
  const incomeTotal = parsedList
    .filter((t) => t.type === "income" && t.amount)
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const expensesKnown = parsedList
    .filter((t) => t.type === "expense" && t.amount)
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const remainderIndex = parsedList.findIndex(
    (t) => t.is_remainder || (t.type === "expense" && t.amount === null)
  );

  if (remainderIndex >= 0) {
    const remainder = incomeTotal - expensesKnown;
    if (remainder <= 0) {
      return "Total pemasukan tidak cukup untuk menutup pengeluaran. Tolong perbaiki angka atau hapus kata 'sisanya'.";
    }
    parsedList[remainderIndex].amount = Number(remainder.toFixed(2));
  }

  // Validasi wajib field
  const invalid = parsedList.find((t) => !t.type || !t.category || !t.amount);
  if (invalid) {
    return "Ada transaksi yang belum jelas tipe/kategori/nominal. Tolong perjelas angka dan jenis transaksinya.";
  }

  const createdAll = await createTransactionsBatch(user.id, parsedList, message);

  // Anomali per item
  const lines: string[] = ["Siap, beberapa transaksi sudah dicatat:"];
  for (const tx of createdAll) {
    const anomalies = await buildAnomalyMessages(user, tx);
    lines.push(formatTransactionLine(tx, user));
    if (anomalies.length) {
      lines.push(...anomalies);
    }
  }

  const totalIncome = createdAll.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = createdAll.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  lines.push(
    "",
    `Total pemasukan: ${formatCurrency(totalIncome, user.currency_code)}`,
    `Total pengeluaran: ${formatCurrency(totalExpense, user.currency_code)}`
  );

  return lines.join("\n");
}

function detectRemainderRatio(sourceMessage: string): number | null {
  const msg = sourceMessage.toLowerCase();
  const fracMatch = msg.match(/(\d+)\s*\/\s*(\d+)/);
  if (fracMatch) {
    const num = Number.parseFloat(fracMatch[1]);
    const den = Number.parseFloat(fracMatch[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const ratio = num / den;
      if (ratio > 0 && ratio <= 1) return ratio;
    }
  }
  const percMatch = msg.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percMatch) {
    const ratio = Number.parseFloat(percMatch[1]) / 100;
    if (ratio > 0 && ratio <= 1) return ratio;
  }
  if (msg.includes("setengah") || msg.includes("separo") || msg.includes("separuh") || msg.includes("half")) {
    return 0.5;
  }
  return null;
}

function sanitizeTransactions(list: ParsedTransaction[], sourceMessage: string): { list: ParsedTransaction[]; error?: string } {
  const sanitized = list.map((t) => ({
    type: t.type ?? "expense",
    category: (t.category ?? "lainnya").trim().toLowerCase(),
    amount: t.amount ?? null,
    merchant: t.merchant ?? null,
    note: t.note ?? null,
    occurred_at: t.occurred_at ?? null,
    is_remainder: t.is_remainder ?? false
  }));

  const remainderIndex = sanitized.findIndex((t) => t.is_remainder || (t.type === "expense" && t.amount === null));
  if (remainderIndex >= 0) {
    const incomeTotal = sanitized
      .filter((t) => t.type === "income" && t.amount)
      .reduce((s, t) => s + (t.amount ?? 0), 0);
    if (!incomeTotal || incomeTotal <= 0) {
      return { list: sanitized, error: "Aku butuh angka pemasukan untuk menghitung 'sisanya'." };
    }
    const expensesKnown = sanitized
      .filter((t) => t.type === "expense" && t.amount !== null && !t.is_remainder)
      .reduce((s, t) => s + (t.amount ?? 0), 0);
    const remainder = incomeTotal - expensesKnown;
    if (remainder <= 0) {
      return { list: sanitized, error: "Total pemasukan tidak cukup untuk menutup pengeluaran. Tolong koreksi angkanya." };
    }
    const ratio = detectRemainderRatio(sourceMessage) ?? 1;
    const applied = remainder * ratio;
    if (applied <= 0) {
      return { list: sanitized, error: "Angka 'sisanya' tidak valid. Tolong koreksi frasa sisanya." };
    }
    sanitized[remainderIndex].amount = Number(applied.toFixed(2));
    sanitized[remainderIndex].is_remainder = true;
  }

  const invalid = sanitized.find((t) => !t.type || !t.category || t.amount === null);
  if (invalid) {
    return { list: sanitized, error: "Ada transaksi yang belum jelas tipe/kategori/nominal. Tolong perjelas angka dan jenis transaksinya." };
  }

  return { list: sanitized };
}

async function handleTransactionsProvided(
  user: UserRow,
  transactions: ParsedTransaction[],
  sourceMessage: string
): Promise<string> {
  const { list, error } = sanitizeTransactions(transactions, sourceMessage);
  if (error) {
    return error;
  }

  // Confidence check
  const lowConfidence = list.find((t: any) => typeof (t as any).confidence === "number" && (t as any).confidence < 0.6);
  if (lowConfidence) {
    return [
      "Aku menangkap beberapa transaksi, tapi butuh konfirmasi karena ada yang kurang yakin.",
      ...list.map((t) => `${t.type}:${toTitleCase(t.category || "lainnya")}:${t.amount ?? "?"}`),
      "Ketik 'ya' untuk lanjut simpan, atau kirim koreksi."
    ].join("\n");
  }

  const createdAll = await createTransactionsBatch(user.id, list, sourceMessage);
  // store embeddings of bot reply later outside; here we just craft text
  const lines: string[] = ["Siap, beberapa transaksi sudah dicatat:"];
  for (const tx of createdAll) {
    const anomalies = await buildAnomalyMessages(user, tx);
    lines.push(formatTransactionLine(tx, user));
    if (anomalies.length) lines.push(...anomalies);
  }
  const totalIncome = createdAll.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = createdAll.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  lines.push(
    "",
    `Total pemasukan: ${formatCurrency(totalIncome, user.currency_code)}`,
    `Total pengeluaran: ${formatCurrency(totalExpense, user.currency_code)}`
  );
  return lines.join("\n");
}

async function handleConfirmImport(user: UserRow, ingestId: number): Promise<string> {
  const rows = await listParsedIngestRows(ingestId);
  if (!rows.length) {
    return "Ingest ID tidak ditemukan atau belum diproses.";
  }

  const parsed = rows
    .map((r) => r.parsed)
    .filter((p): p is ParsedTransaction => !!p && !!p.amount);

  if (!parsed.length) {
    await markIngestFileStatus(ingestId, "error", "tidak ada baris valid");
    return "Tidak ada baris valid yang bisa disimpan.";
  }

  const result = await handleTransactionsProvided(user, parsed, `ingest:${ingestId}`);
  await markIngestFileStatus(ingestId, "committed", null);
  return `Hasil konfirmasi impor #${ingestId}:\n${result}`;
}

function buildDbUpdatePayload(parsed: ParsedDbCommand): {
  type?: TransactionType;
  category?: string;
  amount?: number;
  merchant?: string | null;
  note?: string | null;
  occurred_at?: string;
} {
  const payload: {
    type?: TransactionType;
    category?: string;
    amount?: number;
    merchant?: string | null;
    note?: string | null;
    occurred_at?: string;
  } = {};

  if (parsed.update_type) {
    payload.type = parsed.update_type;
  }
  if (parsed.update_category) {
    payload.category = parsed.update_category;
  }
  if (parsed.update_amount) {
    payload.amount = parsed.update_amount;
  }
  if (parsed.update_merchant !== null) {
    payload.merchant = parsed.update_merchant;
  }
  if (parsed.update_note !== null) {
    payload.note = parsed.update_note;
  }
  if (parsed.update_occurred_at) {
    payload.occurred_at = parsed.update_occurred_at;
  }

  return payload;
}

function hasAnyUpdateField(payload: {
  type?: TransactionType;
  category?: string;
  amount?: number;
  merchant?: string | null;
  note?: string | null;
  occurred_at?: string;
}): boolean {
  return (
    payload.type !== undefined ||
    payload.category !== undefined ||
    payload.amount !== undefined ||
    payload.merchant !== undefined ||
    payload.note !== undefined ||
    payload.occurred_at !== undefined
  );
}

async function handleDatabaseQuery(
  user: UserRow,
  message: string,
  parsed: ParsedDbCommand,
): Promise<string> {
  const range =
    parsed.start_date || parsed.end_date
      ? toDateRange(user.timezone, parsed.start_date, parsed.end_date, false)
      : null;

  const transactions = await listTransactions(user.id, {
    limit: parsed.limit ?? 10,
    type: parsed.filter_type,
    category: parsed.filter_category,
    startIso: range?.startIso ?? null,
    endIsoExclusive: range?.endIsoExclusive ?? null,
  });

  const summaryRange = range ?? toDateRange(user.timezone, null, null, true);
  const summary = await getSummary(
    user.id,
    summaryRange.startIso,
    summaryRange.endIsoExclusive,
  );
  const spent = summary.expense + summary.debt;
  const topCategories = await getTopSpendingCategories(
    user.id,
    summaryRange.startIso,
    summaryRange.endIsoExclusive,
    3,
  );

  const context = [
    `Periode ringkasan: ${summaryRange.label}`,
    `Pemasukan: ${summary.income}`,
    `Pengeluaran: ${summary.expense}`,
    `Utang: ${summary.debt}`,
    `Net: ${summary.income - spent}`,
    `Top kategori: ${
      topCategories
        .map((item) => `${item.category}:${item.total}`)
        .join(" | ") || "none"
    }`,
    `Daftar transaksi: ${
      transactions.length
        ? transactions
            .map(
              (item) =>
                `id=${item.id};type=${item.type};category=${
                  item.category
                };amount=${item.amount};merchant=${
                  item.merchant || "-"
                };date=${DateTime.fromISO(item.occurred_at).toISODate()}`,
            )
            .join(" || ")
        : "none"
    }`,
  ].join("\n");

  const narration = await generateDatabaseNarration(message, context);
  const table = transactions.length
    ? transactions.map((item) => formatTransactionLine(item, user)).join("\n")
    : "Belum ada transaksi sesuai filter yang kamu minta.";

  return [
    narration,
    "",
    "Data transaksi:",
    table,
    "",
    "Tip: kamu bisa perintah langsung seperti `hapus transaksi id 12` atau `ubah transaksi terakhir jadi 25000 kategori transport`.",
  ].join("\n");
}

async function handleDatabaseCommand(
  user: UserRow,
  message: string,
): Promise<string> {
  const parsed = await parseDatabaseCommand(message, user.timezone);

  if (parsed.command_type === "delete_last_transaction") {
    const deleted = await deleteLastTransaction(user.id);
    if (!deleted) {
      return "Belum ada transaksi yang bisa dihapus.";
    }
    return [
      "Oke, transaksi terakhir sudah dihapus.",
      formatTransactionLine(deleted, user),
    ].join("\n");
  }

  if (parsed.command_type === "delete_by_id") {
    if (!parsed.transaction_id) {
      return `Aku butuh ID transaksi yang mau dihapus.\n${dbCommandHelpText()}`;
    }
    const deleted = await deleteTransactionById(user.id, parsed.transaction_id);
    if (!deleted) {
      return `Transaksi dengan ID #${parsed.transaction_id} tidak ditemukan.`;
    }
    return [
      `Berhasil hapus transaksi #${parsed.transaction_id}.`,
      formatTransactionLine(deleted, user),
    ].join("\n");
  }

  if (parsed.command_type === "delete_all") {
    const count = await deleteAllTransactions(user.id);
    return count > 0
      ? `Semua transaksi (${count} baris) sudah dihapus.`
      : "Tidak ada transaksi yang perlu dihapus.";
  }

  if (parsed.command_type === "delete_range") {
    const range =
      parsed.start_date || parsed.end_date
        ? toDateRange(user.timezone, parsed.start_date, parsed.end_date, false)
        : null;
    if (!range) {
      return "Sebutkan rentang tanggal, contoh: hapus transaksi minggu ini / tanggal 2026-02-20.";
    }
    const count = await deleteTransactionsByRange(user.id, range.startIso, range.endIsoExclusive);
    return count > 0
      ? `Transaksi pada rentang ${range.label} terhapus (${count} baris).`
      : `Tidak ada transaksi pada rentang ${range.label}.`;
  }

  if (parsed.command_type === "update_last_transaction") {
    const last = await getLastTransaction(user.id);
    if (!last) {
      return "Belum ada transaksi untuk diedit.";
    }

    const payload = buildDbUpdatePayload(parsed);
    if (!hasAnyUpdateField(payload)) {
      return `Aku belum lihat field yang mau diubah.\n${dbCommandHelpText()}`;
    }

    const updated = await updateTransactionById(user.id, last.id, payload);
    if (!updated) {
      return "Gagal memperbarui transaksi terakhir.";
    }
    return [
      `Siap, transaksi terakhir (#${updated.id}) sudah diperbarui.`,
      formatTransactionLine(updated, user),
    ].join("\n");
  }

  if (parsed.command_type === "update_by_id") {
    if (!parsed.transaction_id) {
      return `Aku butuh ID transaksi yang mau diubah.\n${dbCommandHelpText()}`;
    }

    const payload = buildDbUpdatePayload(parsed);
    if (!hasAnyUpdateField(payload)) {
      return `Aku belum lihat field yang mau diubah.\n${dbCommandHelpText()}`;
    }

    const updated = await updateTransactionById(
      user.id,
      parsed.transaction_id,
      payload,
    );
    if (!updated) {
      return `Transaksi dengan ID #${parsed.transaction_id} tidak ditemukan.`;
    }
    return [
      `Sip, transaksi #${updated.id} sudah diperbarui.`,
      formatTransactionLine(updated, user),
    ].join("\n");
  }

  if (parsed.command_type === "unknown") {
    return `Aku belum paham perintah databasenya.\n${dbCommandHelpText()}`;
  }

  return handleDatabaseQuery(user, message, parsed);
}

async function handleChat(user: UserRow, message: string): Promise<string> {
  if (isCreatorQuestion(message)) {
    return [
      "Hehehe, aku bot asisten keuangan yang di bikin oleh Anggito (https://www.linkedin.com/in/anggito-muhammad-amien/) dalam suatu project iseng gabut.",
      "Tugasku bantu catat transaksi, bikin ringkasan, dan kasih insight dari datamu.",
      "Kalau mau, langsung kirim aja transaksi baru sekarang.",
    ].join("\n");
  }

  if (isHelpRequest(message)) {
    return buildHelpText(user);
  }

  const now = DateTime.now().setZone(user.timezone);
  const summary = await getSummary(
    user.id,
    toIsoUtc(now.startOf("month")),
    toIsoUtc(now.endOf("month").plus({ milliseconds: 1 })),
  );
  const recent = await getRecentTransactions(user.id, 5);

  const context = [
    `Bulan: ${now.toFormat("LLLL yyyy")}`,
    `Pemasukan: ${summary.income}`,
    `Pengeluaran: ${summary.expense}`,
    `Utang: ${summary.debt}`,
    `Transaksi terbaru: ${
      recent.length
        ? recent
            .map(
              (item) =>
                `${item.type}:${item.category}:${
                  item.amount
                }:${DateTime.fromISO(item.occurred_at).toISODate()}`,
            )
            .join(" | ")
        : "none"
    }`,
  ].join("\n");

  return generateFinancialChatReply(message, context);
}

async function storeMessageEmbedding(user: UserRow, role: "user" | "assistant", content: string) {
  const emb = await getEmbedding(content);
  await storeEmbedding(user.id, role, content, emb);
}

export async function processIncomingText(
  input: IncomingTextInput,
): Promise<BotMessage[]> {
  const user = await ensureUser(input.from, input.name);
  await storeMessageEmbedding(user, "user", input.body);

  // Circuit breaker: if too many consecutive errors, use lightweight mode
  if (agentErrorStreak >= env.AGENT_ERROR_BUDGET) {
    const fallback = await handleTransactionOrFallback(user, input.body);
    if (fallback) {
      const note = { type: "text", text: "Aku lagi mode ringan karena ada gangguan sebelumnya." } as BotMessage;
      const replies = [note, ...fallback];
      for (const r of replies) {
        if (r.type === "text") await storeMessageEmbedding(user, "assistant", r.text);
      }
      agentErrorStreak = 0;
      return replies;
    }
    agentErrorStreak = 0;
  }
  // Build lightweight context
  const recent = await getRecentTransactions(user.id, env.AGENT_HISTORY_LIMIT ?? 10);
  const summary = await getSummary(
    user.id,
    toIsoUtc(DateTime.now().setZone(user.timezone).startOf("month")),
    toIsoUtc(DateTime.now().setZone(user.timezone).endOf("month").plus({ milliseconds: 1 }))
  );
  const redactedMsg = redactSensitive(input.body);
  const userEmbedding = await getEmbedding(redactedMsg);
  const similar = await getSimilarMessages(user.id, userEmbedding, 8);
  const topCatMerch = await getTopCategoryMerchant(user.id, 10);
  const context = [
    `User: ${user.whatsapp_number}`,
    `Timezone: ${user.timezone}`,
    `Currency: ${user.currency_code}`,
    `Anomaly alert: ${user.anomaly_opt_in !== false}`,
    `Saldo bulan ini - income: ${summary.income}, expense: ${summary.expense}, debt: ${summary.debt}`,
    `Transaksi terakhir: ${
      recent.length
        ? recent
            .map(
              (item) =>
                `${item.type}:${item.category}:${item.amount}:${DateTime.fromISO(item.occurred_at).toISODate()}`
            )
            .join(" | ")
        : "none"
    }`,
    `Memori mirip: ${
      similar.length
        ? similar.map((m) => `${m.role}:${m.content.slice(0, 60)}`).join(" | ")
        : "none"
    }`,
    `Top kategori/merchant: ${
      topCatMerch.length
        ? topCatMerch.map((t) => `${t.category}${t.merchant ? "@" + t.merchant : ""}`).join(", ")
        : "none"
    }`
  ].join("\n");

  const redactedCtx = redactSensitive(context);
  const tokenEstimate = (redactedMsg.length + redactedCtx.length) / 4; // rough
  if (tokenEstimate > env.AGENT_MAX_TOKENS) {
    const fb = await handleTransactionOrFallback(user, input.body);
    if (fb) return fb;
    return asText(await handleChat(user, input.body));
  }

  const agentStart = Date.now();
  const agent = await runAgent({ user, message: redactedMsg, context: redactedCtx });
  const agentDuration = Date.now() - agentStart;
  if (agent?.actions?.length) {
    const replies: BotMessage[] = [];
    let actionsExecuted = 0;
    for (const action of agent.actions) {
      const actionStart = Date.now();
      if (action.tool === "send_reply") {
        replies.push({ type: "text", text: (action as any).params?.text ?? agent.final_reply ?? "" });
      } else if (action.tool === "log_transactions") {
        const txs = (action as any).params?.transactions;
        if (Array.isArray(txs) && txs.length) {
          replies.push({ type: "text", text: await handleTransactionsProvided(user, txs, input.body) });
        } else {
          replies.push({ type: "text", text: await handleTransaction(user, input.body) });
        }
    } else if (action.tool === "query_report") {
      replies.push(...(await handleReport(user, input.body)));
    } else if (action.tool === "db_command") {
      replies.push({ type: "text", text: await handleDatabaseCommand(user, input.body) });
  } else if (action.tool === "rule_command") {
    replies.push({ type: "text", text: await handleRuleCommand(user, input.body) });
  } else if (action.tool === "import_summary") {
    replies.push({ type: "text", text: "Kirim file foto struk atau CSV, aku akan proses otomatis." });
  } else if (action.tool === "confirm_import") {
      const ingestId = (action as any).params?.ingest_id;
      if (!ingestId) {
        replies.push({ type: "text", text: "Ingest ID tidak ada. Kirim: konfirmasi impor <id>." });
      } else {
        replies.push({ type: "text", text: await handleConfirmImport(user, ingestId) });
      }
      } else if (action.tool === "fallback_error") {
        replies.push({ type: "text", text: "Aku masuk mode ringan. Coba kirim lagi dengan format sederhana atau tunggu sebentar." });
      }
      if (env.AGENT_DEBUG_LOG) {
        const duration = Date.now() - actionStart;
        const payloadSize = JSON.stringify((action as any).params ?? {}).length;
        console.log(`agent_action tool=${action.tool} duration_ms=${duration} payload_size=${payloadSize}`);
      }
      actionsExecuted += 1;
    }
    if (agent.final_reply && !replies.length) {
      replies.push({ type: "text", text: agent.final_reply });
    }
    agentErrorStreak = 0;
    replies.forEach((r) => {
      if (r.type === "text") r.text = stripUnsafeOutput(r.text);
    });
    if (replies.length) {
      if (env.AGENT_DEBUG_LOG) {
        console.log(
          `agent_actions tools=${agent.actions.map((a) => a.tool).join(",")} duration_ms=${agentDuration}`
        );
        console.log(summarizeMetrics());
      }
      recordAgentRun(actionsExecuted, true, agentDuration);
      // store embedding of bot replies
      for (const r of replies) {
        if (r.type === "text") {
          await storeMessageEmbedding(user, "assistant", r.text);
        }
      }
      return replies;
    }
  }

  agentErrorStreak += 1;
  recordAgentRun(0, false, agentDuration);
  // fallback lama
  const intent = await classifyMessage(input.body);
  let fallbackReplies: BotMessage[] | null = null;
  if (intent === "transaction") {
    fallbackReplies = asText(await handleTransaction(user, input.body));
  }
  if (intent === "report") {
    fallbackReplies = await handleReport(user, input.body);
  }
  if (intent === "db_command") {
    fallbackReplies = asText(await handleDatabaseCommand(user, input.body));
  }
  if (intent === "rule_command") {
    fallbackReplies = asText(await handleRuleCommand(user, input.body));
  }
  if (!fallbackReplies) {
    fallbackReplies = asText(await handleChat(user, input.body));
  }
  for (const r of fallbackReplies) {
    if (r.type === "text") {
      await storeMessageEmbedding(user, "assistant", r.text);
    }
  }
  return fallbackReplies;
}

// Grounded report helper: wrap existing report builder with numeric bullets
async function handleReportGrounded(user: UserRow, message: string): Promise<BotMessage[]> {
  const parsed = await parseReportQuery(message, user.timezone);
  const base = await buildReportFromQuery(user, parsed);

  // Build numeric grounding where applicable (skip visualization-only & month comparison)
  if (parsed.report_type === "visualization" || parsed.report_type === "month_comparison") {
    return base;
  }

  const now = DateTime.now().setZone(user.timezone);
  let rangeLabel = `${now.startOf("month").toFormat("dd LLL yyyy")} - ${now.endOf("month").toFormat("dd LLL yyyy")}`;
  let startIso = toIsoUtc(now.startOf("month"));
  let endIso = toIsoUtc(now.endOf("month").plus({ milliseconds: 1 }));

  if (parsed.report_type === "today_summary") {
    rangeLabel = now.toFormat("dd LLL yyyy");
    startIso = toIsoUtc(now.startOf("day"));
    endIso = toIsoUtc(now.endOf("day").plus({ milliseconds: 1 }));
  }

  if (parsed.report_type === "date_range_summary" || parsed.report_type === "detailed_ledger" || parsed.report_type === "category_spend") {
    const range = toDateRange(user.timezone, parsed.start_date, parsed.end_date, true);
    rangeLabel = range.label;
    startIso = range.startIso;
    endIso = range.endIsoExclusive;
  }

  const summary = await getSummary(user.id, startIso, endIso);
  const topCategories = await getTopSpendingCategories(user.id, startIso, endIso, 3);
  const grounded = groundedSummary({
    title: "Data ringkasan:",
    summary,
    start: rangeLabel.split(" - ")[0],
    end: rangeLabel.includes("-") ? rangeLabel.split(" - ")[1] : rangeLabel,
    topCategories,
    currency: user.currency_code
  });

  return [
    { type: "text", text: grounded },
    ...base
  ];
}
async function buildAnomalyMessages(user: UserRow, tx: TransactionRow): Promise<string[]> {
  const messages: string[] = [];
  const lookback = Number(env.ANOMALY_LOOKBACK_DAYS ?? 60);
  if (user.anomaly_opt_in !== false) {
    const dup = await detectDuplicate(user, tx);
    if (dup) {
      messages.push(`⚠️ ${dup.reason}`);
      await logAnomalyEvent({ userId: user.id, transactionId: tx.id, reason: dup.reason, score: dup.score });
    }
    const outlier = await detectAnomaly(user, tx, lookback);
    if (outlier) {
      messages.push(`⚠️ ${outlier.reason}`);
      await logAnomalyEvent({ userId: user.id, transactionId: tx.id, reason: outlier.reason, score: outlier.score });
    }
  }
  return messages;
}
