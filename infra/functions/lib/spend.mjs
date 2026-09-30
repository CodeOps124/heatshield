/**
 * What the AI costs, measured rather than estimated: every agent run records its model and tokens.
 * Prices: AWS Price List API, us-east-1, checked 29 Sep 2026 (US$ per million tokens).
 *   Amazon Nova 2 Lite  0.33 in / 2.75 out
 *   Amazon Nova Pro     0.80 in / 3.20 out
 *   Claude Haiku 4.5    1.10 in / 5.50 out  (AmazonBedrockService, anthropic.claude-haiku-4-5, standard)
 *   Kimi K2.5           0.60 in / 3.00 out  (checked 30 Sep 2026, on-demand standard)
 * Amazon Polly (US$ per million characters): neural 16, standard 4. Polly reports the billed
 * characters of every request, and "Listen" records them.
 */
export const PRICES = Object.freeze({
  'us.amazon.nova-2-lite-v1:0': { input: 0.33, output: 2.75 },
  'us.amazon.nova-pro-v1:0': { input: 0.8, output: 3.2 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5 },
  'moonshotai.kimi-k2.5': { input: 0.6, output: 3.0 },
});

export const CHARACTER_PRICES = Object.freeze({ 'polly:neural': 16, 'polly:standard': 4 });

/** Agents whose runs can call a model. (The Dispatcher and the plans log record no tokens.) */
export const MODEL_AGENTS = Object.freeze(['sol', 'mira', 'lexi', 'vera', 'kai', 'otto', 'quinn', 'iris']);
/** Everything that spends on AI: the agents, plans read aloud, and Ask the team. */
export const SPEND_SOURCES = Object.freeze([...MODEL_AGENTS, 'voice', 'ask']);

const round4 = (x) => Math.round(x * 10_000) / 10_000;

/** US$ for one run, or null when the model has no known price. */
export function runCost(run) {
  if (run.characters) {
    const perMillion = CHARACTER_PRICES[run.model];
    return perMillion ? (run.characters * perMillion) / 1e6 : null;
  }
  const tokensIn = run.inputTokens ?? 0;
  const tokensOut = run.outputTokens ?? 0;
  if (!tokensIn && !tokensOut) return 0;
  const p = PRICES[run.model];
  return p ? (tokensIn * p.input + tokensOut * p.output) / 1e6 : null;
}

export async function measureSpend({ agentLog, sinceMs, agents = SPEND_SOURCES }) {
  const sinceIso = new Date(sinceMs).toISOString();
  const byAgent = {};
  const byModel = {};
  let spentUsd = 0;
  let runs = 0;
  let unpriced = 0;
  const lists = await Promise.all(agents.map(async (agent) => [agent, await agentLog.listRunsSince(agent, sinceIso)]));
  for (const [agent, list] of lists) {
    for (const r of list) {
      const usd = runCost(r);
      if (usd === 0) continue;
      runs += 1;
      if (usd === null) { unpriced += 1; continue; }
      spentUsd += usd;
      byAgent[agent] = (byAgent[agent] ?? 0) + usd;
      const m = byModel[r.model] ?? { usd: 0, inputTokens: 0, outputTokens: 0 };
      m.usd += usd;
      m.inputTokens += r.inputTokens ?? 0;
      m.outputTokens += r.outputTokens ?? 0;
      if (r.characters) m.characters = (m.characters ?? 0) + r.characters;
      byModel[r.model] = m;
    }
  }
  return {
    spentUsd: round4(spentUsd),
    byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, round4(v)])),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { ...v, usd: round4(v.usd) }])),
    runs,
    unpriced,
  };
}
