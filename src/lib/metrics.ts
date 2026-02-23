let okCount = 0;
let errorCount = 0;
let totalActions = 0;
let totalMessages = 0;
let totalDurationMs = 0;

export function recordAgentRun(actions: number, success: boolean, durationMs?: number) {
  totalMessages += 1;
  totalActions += actions;
  if (success) okCount += 1;
  else errorCount += 1;
  if (durationMs) totalDurationMs += durationMs;
}

export function summarizeMetrics(): string {
  const avgActions = totalMessages ? (totalActions / totalMessages).toFixed(2) : "0";
  const avgDuration = totalMessages ? Math.round(totalDurationMs / totalMessages) : 0;
  return `agent_metrics ok=${okCount} err=${errorCount} avg_actions=${avgActions} avg_duration_ms=${avgDuration}`;
}
