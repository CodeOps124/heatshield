/**
 * KAI — Community Coordinator agent (every 3 hours, and on demand from a leader's dashboard).
 * Expertise encoded: community outreach / heat check-in programmes (who to call, by when, why).
 * Algorithms:
 *   - logistic urgency score over transparent features (hand-set weights, documented below;
 *     NOT a trained model — there is no labelled outcome data, and we say so)
 *   - earliest-deadline-first (EDF) scheduling: a check-in is due before the person's risky
 *     window starts, compared in absolute time because members live in different time zones
 * The algorithm owns WHO and BY WHEN. The model writes WHAT to say and why, per person, from a
 * pseudonymous roster (no names, no contact details are sent to the model).
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { tierRank, TIER_LABELS, PROFILES } from '../heat.mjs';
import { logistic } from '../algorithms/stats.mjs';
import { riskForMany } from '../risk-batch.mjs';

const VULNERABLE = new Set(['elderly', 'chronic_condition', 'child', 'pregnant']);
const MAX_FOR_MODEL = 25;
const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Urgency model: z = W.bias + W.atThreshold·(1 + tiers above threshold) + W.soon·soon + ...
export const URGENCY_WEIGHTS = Object.freeze({ bias: -3, atThreshold: 2, laterWindow: 0.5, soon: 1, vulnerable: 0.8, tropicalNight: 0.5, noEmail: 0.6 });

const localEpoch = (localIso, offsetSeconds) => Date.parse(`${localIso.slice(0, 16)}:00Z`) - offsetSeconds * 1000;
const localClock = (epoch, offsetSeconds) => new Date(epoch + offsetSeconds * 1000).toISOString().slice(11, 16);

export function urgencyFeatures(member, risk, nowMs) {
  const gap = tierRank(risk.alert.levelTier) - tierRank(risk.profile.alertTier);
  const windowStart = risk.riskWindow ? localEpoch(risk.riskWindow.start, risk.utcOffsetSeconds ?? 0) : null;
  return {
    gap,
    hasWindow: Boolean(risk.riskWindow),
    soon: Boolean(risk.riskWindow && (risk.riskWindow.startsNow || windowStart - nowMs <= 3 * 3600_000)),
    vulnerable: VULNERABLE.has(member.profile),
    tropicalNight: Boolean(risk.night?.tropicalNight),
    noEmail: !member.subscriptionArn,
    windowStart,
  };
}

export function urgencyScore(f, W = URGENCY_WEIGHTS) {
  const z = W.bias
    + (f.gap >= 0 ? W.atThreshold * (1 + f.gap) : f.hasWindow ? W.laterWindow : 0)
    + W.soon * f.soon + W.vulnerable * f.vulnerable + W.tropicalNight * f.tropicalNight + W.noEmail * f.noEmail;
  return logistic(z);
}

/** Who needs a check-in, how urgent, and by when — ordered earliest deadline first. */
export function buildCheckInSchedule(members, risks, nowMs) {
  const rows = [];
  members.forEach((m, i) => {
    const r = risks[i];
    if (!r) return;
    const f = urgencyFeatures(m, r, nowMs);
    const needs = f.gap >= 0 || (f.hasWindow && f.vulnerable);
    if (!needs) return;
    const offset = r.utcOffsetSeconds ?? 0;
    const deadline = f.windowStart !== null ? Math.max(nowMs, f.windowStart - 3600_000) : nowMs + 2 * 3600_000;
    rows.push({
      locationId: m.locationId,
      name: m.name,
      profile: m.profile,
      place: m.placeName,
      localTime: r.localTime.slice(11, 16),
      nowTier: r.current.tier,
      next12Tier: r.alert.levelTier,
      alertTier: r.profile.alertTier,
      riskyHours: r.riskWindow?.label ?? null,
      urgency: Math.round(urgencyScore(f) * 100) / 100,
      deadline,
      checkInBy: deadline - nowMs <= 5 * 60_000 ? 'now' : `${localClock(deadline, offset)} their time`,
      hasEmail: !f.noEmail,
    });
  });
  rows.sort((a, b) => a.deadline - b.deadline || b.urgency - a.urgency);
  return rows.map((row, i) => ({ ...row, order: i + 1, ref: `M${i + 1}` }));
}

const templateAction = (row) => `Contact them ${row.checkInBy === 'now' ? 'now' : `before ${row.checkInBy}`}: ask how they feel, and go through their plan for ${row.riskyHours ?? 'the hot hours'}.`;

export function parseCoordinatorOutput(text, schedule) {
  const raw = extractJson(text);
  const byRef = new Map();
  for (const c of Array.isArray(raw.checkIns) ? raw.checkIns : []) {
    if (schedule.some((s) => s.ref === c?.ref) && !byRef.has(c.ref)) {
      byRef.set(c.ref, { action: clean(c.action, 220), reason: clean(c.reason, 220) });
    }
  }
  return {
    summary: clean(raw.summary, 600) || `${schedule.length} people need a check-in.`,
    teamNote: clean(raw.teamNote, 300),
    // The algorithm's order and deadlines are kept; the model only fills in the words.
    checkIns: schedule.map((s) => ({
      ...s,
      action: byRef.get(s.ref)?.action || templateAction(s),
      reason: byRef.get(s.ref)?.reason || `${TIER_LABELS[s.next12Tier]} expected; alerts from ${TIER_LABELS[s.alertTier]} for this profile.`,
      writtenBy: byRef.has(s.ref) ? 'model' : 'template',
    })),
  };
}

async function planGroup({ group, store, weather, agentLog, converse, models, nowMs, deadline, sentinel }) {
  const members = await store.listGroupMembers(group.groupId);
  const risks = await riskForMany(weather, members);
  const schedule = buildCheckInSchedule(members, risks, nowMs());
  if (schedule.length === 0) {
    const plan = { allClear: true, summary: `Nobody in "${group.name}" reaches their alert level in the next 24 hours.`, checkIns: [], teamNote: '', members: members.length, model: null };
    await agentLog.putState('kai', `group#${group.groupId}`, plan);
    return { plan, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], turns: 0, model: null };
  }

  const forModel = schedule.slice(0, MAX_FOR_MODEL);
  const cells = new Set(members.map((m) => `${m.lat},${m.lon}`));
  const events = (sentinel?.events ?? []).filter((e) => cells.has(`${e.lat},${e.lon}`)).map(({ place, level, trend, headline }) => ({ place, level, trend, headline }));

  const run = await runAgent({
    agent: {
      name: 'kai',
      models,
      maxTurns: 4,
      maxTokens: 1800,
      system: 'You are Kai, HeatShield\'s community coordinator. You help one group leader (a foreman, teacher or outreach worker) decide how to check on the people in their group during heat. The check-in order and deadlines are already computed by an urgency score and earliest-deadline-first scheduling; do not change them. For each person write one concrete, kind, practical action for the leader (what to ask or do, fitted to the person\'s profile and risky hours) and a short reason. Base advice on CDC/NIOSH heat guidance: water and shade breaks, buddy checks, checking older adults twice a day, cool places, never leaving children in vehicles, and calling the local emergency number for heat-stroke signs. Use the tools.',
      tools: [
        {
          name: 'get_checkin_schedule',
          description: 'People who need a check-in, earliest deadline first, with urgency (0-1) and deadline in their local time. Pseudonymous refs only.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({
            group: group.name,
            people: forModel.map(({ ref, profile, place, localTime, nowTier, next12Tier, riskyHours, urgency, checkInBy, hasEmail }) => ({
              ref, profile: PROFILES[profile]?.label ?? profile, place, localTime, nowTier, next12Tier, riskyHours, urgency, checkInBy, gets_email_alerts: hasEmail,
            })),
          }),
        },
        {
          name: 'get_heat_events',
          description: 'Heat watches/warnings from the Heat Sentinel for this group\'s areas.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ events }),
        },
      ],
    },
    input: `Plan today's heat check-ins for the group "${group.name}". Use your tools, then reply with ONLY this JSON:\n{"summary":"2-3 sentences for the leader","checkIns":[{"ref":"M1","action":"...","reason":"..."}],"teamNote":"one line for the whole group"}`,
    converse,
    deadline,
  });

  const parsed = parseCoordinatorOutput(run.text, forModel);
  const rest = schedule.slice(MAX_FOR_MODEL).map((s) => ({ ...s, action: templateAction(s), reason: `${TIER_LABELS[s.next12Tier]} expected.`, writtenBy: 'template' }));
  const plan = {
    allClear: false,
    summary: parsed.summary,
    teamNote: parsed.teamNote,
    checkIns: [...parsed.checkIns, ...rest].map(({ locationId, order, checkInBy, urgency, action, reason, next12Tier, riskyHours, writtenBy }) => ({ locationId, order, checkInBy, urgency, action, reason, tier: next12Tier, riskyHours, writtenBy })),
    members: members.length,
    heatEvents: events,
    model: run.model,
  };
  await agentLog.putState('kai', `group#${group.groupId}`, plan);
  return { plan, usage: run.usage, toolCalls: run.toolCalls, turns: run.turns, model: run.model };
}

export async function runCoordinator({ store, weather, agentLog, converse, models, groupId = null, nowMs = () => Date.now(), deadline = Date.now() + 240_000 }) {
  const groups = groupId ? [await store.getGroup(groupId)].filter(Boolean) : await store.listAllGroups();
  const sentinel = await agentLog.getState('sol', 'latest');
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls = [];
  let planned = 0;
  let checkIns = 0;
  let model = null;
  let turns = 0;
  for (const group of groups.slice(0, 20)) {
    if (deadline - nowMs() < 20_000) break;
    const r = await planGroup({ group, store, weather, agentLog, converse, models, nowMs, deadline, sentinel });
    planned += 1;
    checkIns += r.plan.checkIns.length;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    toolCalls.push(...r.toolCalls);
    turns += r.turns;
    model = r.model ?? model;
  }
  return {
    outcome: checkIns ? 'planned' : 'all-clear',
    summary: `Planned ${planned} group(s): ${checkIns} check-in(s) scheduled.`,
    model, usage, toolCalls, turns,
    detail: { groupsPlanned: planned, checkIns },
  };
}
