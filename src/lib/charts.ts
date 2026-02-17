import vm from "node:vm";
import OpenAI from "openai";
import { DateTime } from "luxon";
import { env } from "@/src/lib/env";
import type { DailySeriesRow } from "@/src/lib/types";

interface ChartImage {
  imageUrl: string;
  caption: string;
}

const chartLlm = env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: env.GROQ_BASE_URL
    })
  : null;

function buildQuickChartUrl(config: object, width = 900, height = 540): string {
  const baseUrl = "https://quickchart.io/chart";
  const query = new URLSearchParams({
    width: String(width),
    height: String(height),
    format: "png",
    backgroundColor: "white",
    c: JSON.stringify(config)
  });
  return `${baseUrl}?${query.toString()}`;
}

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

async function generateChartCodeWithAi(goal: string, inputData: object): Promise<string | null> {
  if (!chartLlm) {
    return null;
  }

  try {
    const completion = await chartLlm.chat.completions.create({
      model: env.GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Kamu generator kode chart config.
Tulis JavaScript function bernama buildChartConfig(inputData) yang mengembalikan object Chart.js.
Aturan ketat:
- Hanya return object serializable JSON.
- Jangan gunakan import/require/process/globalThis/eval/Function.
- Jangan akses network atau filesystem.
- Fokus hasil visual rapi dan terbaca.
Return JSON: {"code":"function buildChartConfig(inputData){ ... return {...}; }"}`
        },
        {
          role: "user",
          content: `Tujuan chart: ${goal}\nInput data JSON:\n${JSON.stringify(inputData)}`
        }
      ]
    });

    const raw = extractTextContent(completion.choices[0]?.message?.content);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { code?: string };
    if (!parsed.code || typeof parsed.code !== "string") {
      return null;
    }
    return parsed.code;
  } catch {
    return null;
  }
}

function isValidChartConfig(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && "type" in (value as Record<string, unknown>) && "data" in (value as Record<string, unknown>);
}

function runGeneratedChartCode(
  code: string,
  inputData: object
): Record<string, unknown> | null {
  try {
    const script = new vm.Script(
      `"use strict";
${code}
if (typeof buildChartConfig !== "function") { throw new Error("buildChartConfig missing"); }
buildChartConfig(inputData);`
    );

    const safeInput = JSON.parse(JSON.stringify(inputData));
    const context = vm.createContext({
      inputData: safeInput,
      Math
    });
    const output = script.runInContext(context, { timeout: 250 });
    const serialized = JSON.parse(JSON.stringify(output));
    if (!isValidChartConfig(serialized)) {
      return null;
    }
    return serialized;
  } catch {
    return null;
  }
}

async function resolveChartConfig(args: {
  goal: string;
  inputData: object;
  fallbackConfig: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const code = await generateChartCodeWithAi(args.goal, args.inputData);
  if (!code) {
    return args.fallbackConfig;
  }

  const generatedConfig = runGeneratedChartCode(code, args.inputData);
  if (!generatedConfig) {
    return args.fallbackConfig;
  }

  return generatedConfig;
}

function buildContinuousSeries(
  series: DailySeriesRow[],
  startDate: string,
  endDate: string
): DailySeriesRow[] {
  const byDate = new Map<string, DailySeriesRow>();
  for (const row of series) {
    byDate.set(row.date, row);
  }

  const output: DailySeriesRow[] = [];
  let cursor = DateTime.fromISO(startDate);
  const end = DateTime.fromISO(endDate);

  while (cursor <= end) {
    const date = cursor.toISODate();
    if (!date) {
      cursor = cursor.plus({ days: 1 });
      continue;
    }
    const existing = byDate.get(date);
    output.push(
      existing ?? {
        date,
        income: 0,
        expense: 0
      }
    );
    cursor = cursor.plus({ days: 1 });
  }

  return output;
}

export async function buildPieIncomeExpenseChart(args: {
  income: number;
  expense: number;
  periodLabel: string;
  currencyCode: string;
  formatCurrency: (value: number, currencyCode: string) => string;
}): Promise<ChartImage> {
  const income = Math.max(0, args.income);
  const expense = Math.max(0, args.expense);
  const inputData = {
    periodLabel: args.periodLabel,
    labels: ["Pendapatan", "Pengeluaran"],
    values: [income, expense]
  };

  const fallbackConfig = {
    type: "pie",
    data: {
      labels: inputData.labels,
      datasets: [
        {
          data: inputData.values,
          backgroundColor: ["#1e88e5", "#ef5350"]
        }
      ]
    },
    options: {
      plugins: {
        legend: { position: "bottom" },
        title: { display: true, text: `Pendapatan vs Pengeluaran (${args.periodLabel})` }
      }
    }
  };

  const config = await resolveChartConfig({
    goal: "Buat pie chart pendapatan vs pengeluaran yang jelas untuk user Indonesia.",
    inputData,
    fallbackConfig
  });

  return {
    imageUrl: buildQuickChartUrl(config),
    caption: [
      `Visualisasi pie (${args.periodLabel})`,
      `- Pendapatan: ${args.formatCurrency(income, args.currencyCode)}`,
      `- Pengeluaran: ${args.formatCurrency(expense, args.currencyCode)}`
    ].join("\n")
  };
}

export async function buildIncomeExpenseTimeseriesChart(args: {
  series: DailySeriesRow[];
  startDate: string;
  endDate: string;
  periodLabel: string;
  currencyCode: string;
  formatCurrency: (value: number, currencyCode: string) => string;
}): Promise<ChartImage> {
  const series = buildContinuousSeries(args.series, args.startDate, args.endDate);
  const labels = series.map((row) => DateTime.fromISO(row.date).toFormat("dd LLL"));
  const incomeValues = series.map((row) => row.income);
  const expenseValues = series.map((row) => row.expense);
  const totalIncome = incomeValues.reduce((sum, value) => sum + value, 0);
  const totalExpense = expenseValues.reduce((sum, value) => sum + value, 0);

  const inputData = {
    periodLabel: args.periodLabel,
    labels,
    incomeValues,
    expenseValues
  };

  const fallbackConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Pendapatan",
          data: incomeValues,
          borderColor: "#1e88e5",
          backgroundColor: "rgba(30,136,229,0.2)",
          fill: false,
          tension: 0.25
        },
        {
          label: "Pengeluaran",
          data: expenseValues,
          borderColor: "#ef5350",
          backgroundColor: "rgba(239,83,80,0.2)",
          fill: false,
          tension: 0.25
        }
      ]
    },
    options: {
      plugins: {
        legend: { position: "bottom" },
        title: {
          display: true,
          text: `Tren Pendapatan & Pengeluaran (${args.periodLabel})`
        }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  };

  const config = await resolveChartConfig({
    goal: "Buat line chart time-series pendapatan dan pengeluaran harian.",
    inputData,
    fallbackConfig
  });

  return {
    imageUrl: buildQuickChartUrl(config, 1000, 560),
    caption: [
      `Visualisasi tren (${args.periodLabel})`,
      `- Total pendapatan: ${args.formatCurrency(totalIncome, args.currencyCode)}`,
      `- Total pengeluaran: ${args.formatCurrency(totalExpense, args.currencyCode)}`
    ].join("\n")
  };
}

export async function buildExpenseByCategoryBarChart(args: {
  categoryTotals: Array<{ category: string; total: number }>;
  periodLabel: string;
  currencyCode: string;
  formatCurrency: (value: number, currencyCode: string) => string;
}): Promise<ChartImage> {
  const rows = args.categoryTotals.length
    ? args.categoryTotals
    : [{ category: "Tidak ada data", total: 0 }];
  const labels = rows.map((row) => row.category);
  const values = rows.map((row) => row.total);
  const total = values.reduce((sum, value) => sum + value, 0);

  const inputData = {
    periodLabel: args.periodLabel,
    labels,
    values
  };

  const fallbackConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pengeluaran per kategori",
          data: values,
          backgroundColor: "#ef5350"
        }
      ]
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Pengeluaran per Kategori (${args.periodLabel})` }
      },
      scales: {
        x: { beginAtZero: true }
      }
    }
  };

  const config = await resolveChartConfig({
    goal: "Buat bar chart horizontal pengeluaran per kategori, urut menurun.",
    inputData,
    fallbackConfig
  });

  return {
    imageUrl: buildQuickChartUrl(config, 1000, 620),
    caption: [
      `Bar chart pengeluaran per kategori (${args.periodLabel})`,
      `- Total pengeluaran: ${args.formatCurrency(total, args.currencyCode)}`
    ].join("\n")
  };
}

export async function buildIncomeByCategoryBarChart(args: {
  categoryTotals: Array<{ category: string; total: number }>;
  periodLabel: string;
  currencyCode: string;
  formatCurrency: (value: number, currencyCode: string) => string;
}): Promise<ChartImage> {
  const rows = args.categoryTotals.length
    ? args.categoryTotals
    : [{ category: "Tidak ada data", total: 0 }];
  const labels = rows.map((row) => row.category);
  const values = rows.map((row) => row.total);
  const total = values.reduce((sum, value) => sum + value, 0);

  const inputData = {
    periodLabel: args.periodLabel,
    labels,
    values
  };

  const fallbackConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pendapatan per kategori",
          data: values,
          backgroundColor: "#1e88e5"
        }
      ]
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Pendapatan per Kategori (${args.periodLabel})` }
      },
      scales: {
        x: { beginAtZero: true }
      }
    }
  };

  const config = await resolveChartConfig({
    goal: "Buat bar chart horizontal pendapatan per kategori, urut menurun.",
    inputData,
    fallbackConfig
  });

  return {
    imageUrl: buildQuickChartUrl(config, 1000, 620),
    caption: [
      `Bar chart pendapatan per kategori (${args.periodLabel})`,
      `- Total pendapatan: ${args.formatCurrency(total, args.currencyCode)}`
    ].join("\n")
  };
}
