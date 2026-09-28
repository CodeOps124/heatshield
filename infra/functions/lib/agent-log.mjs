/**
 * Agent activity log (DynamoDB single table `AgentLog`, keys pk/sk):
 *   run#<agent>    / <iso>#<id>     one item per run (14-day TTL)   -> the console's "recent runs"
 *   state#<agent>  / <key>          latest outputs (briefing, plans, status) that other agents read
 *
 * Agents coordinate through state, not through each other: the Sentinel publishes heat events,
 * the Coordinator reads them; the Watchdog reads everyone's heartbeat from their latest runs.
 */
import { randomBytes } from 'node:crypto';

const RUN_TTL_DAYS = 14;

export function createAgentLog({ db, table, nowMs = () => Date.now() }) {
  return {
    async recordRun(agent, run) {
      const at = new Date(nowMs()).toISOString();
      const item = {
        pk: `run#${agent}`,
        sk: `${at}#${randomBytes(4).toString('hex')}`,
        agent,
        at,
        ...run,
        expiresAt: Math.floor(nowMs() / 1000) + RUN_TTL_DAYS * 86400,
      };
      await db.put({ table, item });
      return item;
    },

    listRuns: (agent, limit = 10) =>
      db.query({ table, keyCondition: 'pk = :p', values: { ':p': `run#${agent}` }, limit, forward: false }),

    async putState(agent, key, value) {
      await db.put({ table, item: { pk: `state#${agent}`, sk: key, value, updatedAt: new Date(nowMs()).toISOString() } });
    },

    async getState(agent, key) {
      const item = await db.get({ table, key: { pk: `state#${agent}`, sk: key } });
      return item ? { ...item.value, updatedAt: item.updatedAt } : null;
    },
  };
}

/** Wraps an agent's work so every run is recorded, including failures. */
export async function recorded(log, agent, trigger, fn, nowMs = () => Date.now()) {
  const started = nowMs();
  try {
    const result = await fn();
    await log.recordRun(agent, {
      trigger,
      outcome: result.outcome ?? 'ok',
      durationMs: nowMs() - started,
      model: result.model ?? null,
      turns: result.turns ?? 0,
      toolCalls: result.toolCalls ?? [],
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      summary: String(result.summary ?? '').slice(0, 500),
      detail: result.detail ?? null,
    });
    return result;
  } catch (err) {
    await log.recordRun(agent, {
      trigger,
      outcome: 'error',
      durationMs: nowMs() - started,
      summary: `${err.name}: ${err.message}`.slice(0, 500),
    }).catch(() => {});
    throw err;
  }
}
