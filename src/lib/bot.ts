import { DateTime } from "luxon";
import {
  classifyMessage,
  extractTransaction,
  generateDatabaseNarration,
  generateFinancialChatReply,
  parseDatabaseCommand,
  parseReportQuery,
  parseRuleCommand
} from "@/src/lib/ai";
import {
  buildExpenseByCategoryBarChart,
  buildIncomeByCategoryBarChart,
  buildIncomeExpenseTimeseriesChart,
  buildPieIncomeExpenseChart,
} from "@/src/lib/charts";
import {
  createTransaction,
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
} from "@/src/lib/finance";
import { detectAnomaly, detectDuplicate } from "@/src/lib/anomaly";
import { createRule, deleteRule, listRules } from "@/src/lib/rules";
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
  TransactionRow,
  TransactionType,
  UserRow,
} from "@/src/lib/types";

interface IncomingTextInput {
  from: string;
  name?: string | null;
  body: string;
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

function formatTransactionLine(
  transaction: TransactionRow,
  user: UserRow,
): string {
  return `#${transaction.id} | ${formatDateInTimezone(
    transaction.occurred_at,
    user.timezone,
  )} | ${typeLabel(transaction.type)} | ${toTitleCase(
    transaction.category,
  )} | ${formatCurrency(transaction.amount, user.currency_code)} | ${
    transaction.merchant || "-"
  }`;
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
  const parsed = await parseReportQuery(message, user.timezone);
  return buildReportFromQuery(user, parsed);
}

async function handleTransaction(
  user: UserRow,
  message: string,
): Promise<string> {
  const parsed = await extractTransaction(message, user.timezone);

  if (!parsed.type || !parsed.amount || !parsed.category) {
    return 'Aku belum bisa menangkap detail transaksinya. Coba format seperti: "Keluar 45000 untuk bensin di Shell".';
  }

  const created = await createTransaction(user.id, parsed, message);
  const anomalyMessages: string[] = [];
  const lookback = Number(env.ANOMALY_LOOKBACK_DAYS ?? 60);

  if (user.anomaly_opt_in !== false) {
    const dup = await detectDuplicate(user, created);
    if (dup) {
      anomalyMessages.push(`⚠️ ${dup.reason}`);
      await logAnomalyEvent({
        userId: user.id,
        transactionId: created.id,
        reason: dup.reason,
        score: dup.score,
      });
    }

    const outlier = await detectAnomaly(user, created, lookback);
    if (outlier) {
      anomalyMessages.push(`⚠️ ${outlier.reason}`);
      await logAnomalyEvent({
        userId: user.id,
        transactionId: created.id,
        reason: outlier.reason,
        score: outlier.score,
      });
    }
  }

  return [
    "Siap, transaksinya sudah aku catat.",
    `- ID: #${created.id}`,
    `- Jenis: ${typeLabel(created.type)}`,
    `- Kategori: ${toTitleCase(created.category)}`,
    `- Nominal: ${formatCurrency(created.amount, user.currency_code)}`,
    `- Merchant: ${created.merchant || "-"}`,
    `- Tanggal: ${formatDateInTimezone(created.occurred_at, user.timezone)}`,
    ...(anomalyMessages.length ? ["", ...anomalyMessages] : []),
  ].join("\n");
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

export async function processIncomingText(
  input: IncomingTextInput,
): Promise<BotMessage[]> {
  const user = await ensureUser(input.from, input.name);
  const intent = await classifyMessage(input.body);

  if (intent === "transaction") {
    return asText(await handleTransaction(user, input.body));
  }
  if (intent === "report") {
    return handleReport(user, input.body);
  }
  if (intent === "db_command") {
    return asText(await handleDatabaseCommand(user, input.body));
  }
  if (intent === "rule_command") {
    return asText(await handleRuleCommand(user, input.body));
  }
  return asText(await handleChat(user, input.body));
}
