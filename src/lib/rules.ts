import { query } from "@/src/lib/db";
import type { CategoryRule, TransactionType } from "@/src/lib/types";

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

export async function listRules(userId: number): Promise<CategoryRule[]> {
  return query<CategoryRule>(
    `
      SELECT id, user_id, pattern_regex, merchant_contains, category, type, priority, created_at
      FROM category_rules
      WHERE user_id = $1
      ORDER BY priority DESC, id DESC
    `,
    [userId]
  );
}

export async function createRule(input: {
  userId: number;
  pattern_regex?: string | null;
  merchant_contains?: string | null;
  category: string;
  type: TransactionType | null;
  priority?: number;
}): Promise<CategoryRule> {
  const priority = input.priority ?? 50;
  const rows = await query<CategoryRule>(
    `
      INSERT INTO category_rules (user_id, pattern_regex, merchant_contains, category, type, priority)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, pattern_regex, merchant_contains, category, type, priority, created_at
    `,
    [
      input.userId,
      input.pattern_regex?.trim() || null,
      input.merchant_contains ? normalize(input.merchant_contains) : null,
      normalize(input.category),
      input.type ?? null,
      priority
    ]
  );
  return rows[0];
}

export async function deleteRule(userId: number, ruleId: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `DELETE FROM category_rules WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, ruleId]
  );
  return rows.length > 0;
}

export async function matchRule(
  userId: number,
  options: { merchant?: string | null; message: string }
): Promise<CategoryRule | null> {
  const rules = await listRules(userId);
  const message = normalize(options.message);
  const merchant = options.merchant ? normalize(options.merchant) : null;

  for (const rule of rules) {
    if (rule.merchant_contains && merchant && merchant.includes(rule.merchant_contains)) {
      return rule;
    }
    if (rule.pattern_regex) {
      try {
        const re = new RegExp(rule.pattern_regex, "i");
        if (re.test(message)) {
          return rule;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}
