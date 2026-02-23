import { formatCurrency } from "@/src/lib/format";
import type { SummaryRow } from "@/src/lib/types";

export function groundedSummary(args: {
  title: string;
  summary?: SummaryRow;
  start?: string;
  end?: string;
  topCategories?: Array<{ category: string; total: number }>;
  currency: string;
}): string {
  const lines: string[] = [args.title];
  if (args.start && args.end) {
    lines.push(`Periode: ${args.start} - ${args.end}`);
  }
  if (args.summary) {
    lines.push(
      `Pemasukan: ${formatCurrency(args.summary.income, args.currency)}`,
      `Pengeluaran: ${formatCurrency(args.summary.expense, args.currency)}`,
      `Utang: ${formatCurrency(args.summary.debt, args.currency)}`
    );
  }
  if (args.topCategories?.length) {
    lines.push(
      "Top kategori:",
      ...args.topCategories.slice(0, 3).map((c) => `- ${c.category}: ${formatCurrency(c.total, args.currency)}`)
    );
  }
  return lines.join("\n");
}
