export type MessageIntent = "report" | "transaction" | "chat" | "db_command" | "rule_command";

export type TransactionType = "expense" | "income" | "debt";

export interface ParsedTransaction {
  type: TransactionType | null;
  category: string | null;
  amount: number | null;
  merchant: string | null;
  note: string | null;
  occurred_at: string | null;
  is_remainder?: boolean | null;
}

export interface ParsedRuleCommand {
  action: "create" | "list" | "delete" | "toggle_anomaly" | "unknown";
  rule_id: number | null;
  pattern_regex: string | null;
  merchant_contains: string | null;
  category: string | null;
  type: TransactionType | null;
  priority: number | null;
  anomaly_opt_in: boolean | null;
}

export type DbCommandType =
  | "query"
  | "delete_last_transaction"
  | "delete_by_id"
  | "delete_all"
  | "delete_range"
  | "update_last_transaction"
  | "update_by_id"
  | "unknown";

export interface ParsedDbCommand {
  command_type: DbCommandType;
  transaction_id: number | null;
  limit: number | null;
  filter_type: TransactionType | null;
  filter_category: string | null;
  start_date: string | null;
  end_date: string | null;
  update_type: TransactionType | null;
  update_category: string | null;
  update_amount: number | null;
  update_merchant: string | null;
  update_note: string | null;
  update_occurred_at: string | null;
}

export type ReportType =
  | "today_summary"
  | "date_range_summary"
  | "detailed_ledger"
  | "category_spend"
  | "month_comparison"
  | "visualization"
  | "financial_status";

export type ChartType =
  | "pie_income_vs_expense"
  | "timeseries_income_expense"
  | "bar_expense_by_category"
  | "bar_income_by_category";

export interface ParsedReportQuery {
  report_type: ReportType;
  start_date: string | null;
  end_date: string | null;
  category: string | null;
  month_a: string | null;
  month_b: string | null;
  chart_type: ChartType | null;
}

export interface UserRow {
  id: number;
  whatsapp_number: string;
  display_name: string | null;
  currency_code: string;
  timezone: string;
  anomaly_opt_in?: boolean;
}

export interface TransactionRow {
  id: number;
  type: TransactionType;
  category: string;
  amount: number;
  merchant: string | null;
  note: string | null;
  occurred_at: string;
}

export interface SummaryRow {
  income: number;
  expense: number;
  debt: number;
  tx_count: number;
}

export interface CategoryRule {
  id: number;
  user_id: number;
  pattern_regex: string | null;
  merchant_contains: string | null;
  category: string;
  type: TransactionType | null;
  priority: number;
  created_at: string;
}

export interface AnomalyEvent {
  id: number;
  user_id: number;
  transaction_id: number;
  reason: string;
  score: number | null;
  created_at: string;
  notified_at: string | null;
}

export interface DailySeriesRow {
  date: string;
  income: number;
  expense: number;
}

export type BotMessage =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      image_url: string;
      caption?: string;
    };
