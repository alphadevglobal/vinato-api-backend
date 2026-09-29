import { config } from "./config.js";

/**
 * OpenRouter account status for the admin "Financeiro" (vinato-web): what each
 * API key used and, when OpenRouter allows it, the credit balance. The keys
 * never leave this server; only their use and a masked suffix are returned.
 */
export type OpenRouterKeyStatus = {
  purpose: string;
  keyHint: string;
  ok: boolean;
  error?: string;
  label?: string | null;
  usageUsd?: number | null;
  usageDailyUsd?: number | null;
  usageWeeklyUsd?: number | null;
  usageMonthlyUsd?: number | null;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean | null;
};
export type OpenRouterAccount = {
  keys: OpenRouterKeyStatus[];
  // /credits answers only for keys allowed to read the account balance.
  credits: { totalCreditsUsd: number; totalUsageUsd: number; balanceUsd: number } | null;
  checkedAt: string;
};

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

async function getJson(path: string, apiKey: string) {
  const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as { data?: Record<string, unknown> } | null;
  return { ok: response.ok, status: response.status, data: body?.data ?? null };
}

export async function openRouterAccount(): Promise<OpenRouterAccount> {
  const scannerKey = process.env.OPENROUTER_API_KEY ?? config.openRouterApiKey;
  const sommelierKey = process.env.SOMMELIER_OPENROUTER_API_KEY ?? scannerKey;
  const keys: { purpose: string; key: string }[] = [];
  if (scannerKey) keys.push({ purpose: sommelierKey && sommelierKey !== scannerKey ? "Scanner, cartas e curadoria" : "Todos os agentes", key: scannerKey });
  if (sommelierKey && sommelierKey !== scannerKey) keys.push({ purpose: "Sommelier", key: sommelierKey });

  const statuses = await Promise.all(keys.map(async ({ purpose, key }): Promise<OpenRouterKeyStatus> => {
    const keyHint = `…${key.slice(-4)}`;
    try {
      const reply = await getJson("/key", key);
      if (!reply.ok || !reply.data) return { purpose, keyHint, ok: false, error: `OpenRouter respondeu ${reply.status}` };
      return {
        purpose, keyHint, ok: true,
        label: typeof reply.data.label === "string" ? reply.data.label : null,
        usageUsd: num(reply.data.usage), usageDailyUsd: num(reply.data.usage_daily), usageWeeklyUsd: num(reply.data.usage_weekly),
        usageMonthlyUsd: num(reply.data.usage_monthly), limitUsd: num(reply.data.limit), limitRemainingUsd: num(reply.data.limit_remaining),
        isFreeTier: typeof reply.data.is_free_tier === "boolean" ? reply.data.is_free_tier : null,
      };
    } catch (error) {
      return { purpose, keyHint, ok: false, error: (error as Error).name === "TimeoutError" ? "OpenRouter não respondeu" : "Falha ao consultar a OpenRouter" };
    }
  }));

  let credits: OpenRouterAccount["credits"] = null;
  for (const { key } of keys) {
    try {
      const reply = await getJson("/credits", key);
      const total = num(reply.data?.total_credits);
      const used = num(reply.data?.total_usage);
      if (reply.ok && total !== null && used !== null) { credits = { totalCreditsUsd: total, totalUsageUsd: used, balanceUsd: total - used }; break; }
    } catch {
      // The balance is optional; the per-key usage above is enough.
    }
  }
  return { keys: statuses, credits, checkedAt: new Date().toISOString() };
}
