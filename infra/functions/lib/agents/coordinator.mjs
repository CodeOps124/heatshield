/**
 * KAI — Community Coordinator agent (every 3 hours, and on demand from a leader's dashboard).
 * Expertise encoded: community outreach / heat check-in programmes (who to call, by when, why).
 * Algorithms:
 *   - logistic urgency score over transparent features (hand-set weights, documented below;
 *     NOT a trained model — there is no labelled outcome data, and we say so)
 *   - earliest-deadline-first (EDF) scheduling: a check-in is due before the person's risky
 *     window starts, compared in absolute time because members live in different time zones
 *   - safest-shift search for outdoor workers: the 8-hour shift (starting 04:00-10:00 local, next
 *     36 hours) with the fewest Danger hours, then the least heat above Extreme Caution
 * The algorithm owns WHO and BY WHEN. The model writes WHAT to say and why, per person, from a
 * pseudonymous roster (no names, no contact details are sent to the model).
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { tierRank, TIER_LABELS, PROFILES, heatIndexF, tierForHeatIndexF, cToF, fToC } from '../heat.mjs';
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
export function buildCheckInSchedule(members, risks, nowMs, shifts = new Map()) {
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
      score: urgencyScore(f),
      deadline,
      checkInBy: deadline - nowMs <= 5 * 60_000 ? 'now' : `${localClock(deadline, offset)} their time`,
      hasEmail: !f.noEmail,
      shift: shifts.get(m.locationId) ?? null,
    });
  });
  // Sort on the exact score: sorting on the rounded one tied everyone at 0.98 and fell back to input order.
  rows.sort((a, b) => a.deadline - b.deadline || b.score - a.score);
  return rows.map(({ score, ...row }, i) => ({ ...row, urgency: Math.round(score * 100) / 100, order: i + 1, ref: `M${i + 1}` }));
}

const hhmm = (iso) => iso.slice(11, 16);
const plusHours = (iso, h) => new Date(Date.parse(`${iso}:00Z`) + h * 3600_000).toISOString().slice(0, 16);

/**
 * The safest `length`-hour shift in `hours` (local, consecutive, from now on), starting between
 * `earliest` and `latest` o'clock: fewest Danger hours first, then the least heat above Extreme
 * Caution (degree-hours), then the earliest start. Compared with a standard shift on the same day.
 * Returns null when no shift fits, or when even the standard shift stays below Extreme Caution.
 */
export function bestShift(hours, { length = 8, earliest = 4, latest = 10, standardStart = 7 } = {}) {
  const scored = hours.map((h) => {
    const hiF = heatIndexF(cToF(h.tempC), h.rh);
    return { time: h.time, hiC: fToC(hiF), tier: tierForHeatIndexF(hiF) };
  });
  const cost = (start) => {
    const slice = scored.slice(start, start + length);
    if (slice.length < length) return null;
    // Consecutive hours only (a gap in the forecast would make the window meaningless).
    if (slice.some((h, i) => i > 0 && Date.parse(`${h.time}:00Z`) - Date.parse(`${slice[i - 1].time}:00Z`) !== 3600_000)) return null;
    return {
      start: slice[0].time,
      dangerHours: slice.filter((h) => tierRank(h.tier) >= tierRank('danger')).length,
      extremeCautionHours: slice.filter((h) => tierRank(h.tier) === tierRank('extreme_caution')).length,
      excess: slice.reduce((s, h) => s + Math.max(0, h.hiC - 32.2), 0),
    };
  };
  const options = scored.map((h, i) => ({ h, i }))
    .filter(({ h }) => { const hour = Number(h.time.slice(11, 13)); return hour >= earliest && hour <= latest; })
    .map(({ i }) => cost(i)).filter(Boolean);
  if (!options.length) return null;
  const best = options.reduce((a, b) => (b.dangerHours < a.dangerHours || (b.dangerHours === a.dangerHours && b.excess < a.excess - 1e-9) ? b : a));
  const day = best.start.slice(0, 10);
  const stdIndex = scored.findIndex((h) => h.time === `${day}T${String(standardStart).padStart(2, '0')}:00`);
  const standard = stdIndex >= 0 ? cost(stdIndex) : null;
  if (standard && standard.dangerHours === 0 && standard.extremeCautionHours === 0) return null; // the choice does not matter
  const view = (w) => w && { start: hhmm(w.start), end: hhmm(plusHours(w.start, length)), dangerHours: w.dangerHours, extremeCautionHours: w.extremeCautionHours };
  return { day, length, best: view(best), standard: view(standard) };
}

const templateAction = (row) => `Contact them ${row.checkInBy === 'now' ? 'now' : `before ${row.checkInBy}`}: ask how they feel, and go through their plan for ${row.riskyHours ?? 'the hot hours'}.`;
const templateReason = (row) => `${TIER_LABELS[row.next12Tier]} expected; alerts from ${TIER_LABELS[row.alertTier]} for this profile.`;

// Kai sees pseudonymous refs, never names or genders, so "he" or "she" is always a guess
// (1 Oct: a member with a heart condition was called "she").
const GENDERED = /\b(he|she|him|his|her|hers|himself|herself)\b/i;
// "move to the safest shift to avoid all danger hours" when code's numbers say it still has some (1 Oct, Dubai: 3).
const AVOIDS_DANGER = /\b(avoid(?:s|ing)?|without|free of|no|zero|escapes?)\b[^.;]{0,30}\bdanger/i;

/**
 * What code can check in Kai's words: a guessed gender anywhere, or a check-in saying the safest shift
 * avoids Danger when the computed shift still has Danger hours.
 */
export function checkInProblems(plan) {
  const problems = [];
  for (const text of [plan.summary, plan.teamNote]) if (text && GENDERED.test(text)) problems.push({ text, message: 'you do not know anyone\'s gender, so refer to each person as "they" or by their role' });
  for (const c of plan.checkIns) {
    if (c.writtenBy !== 'model') continue;
    for (const text of [c.action, c.reason]) {
      if (GENDERED.test(text)) problems.push({ ref: c.ref, text, message: 'you do not know anyone\'s gender, so refer to each person as "they" or by their role' });
      else if (c.shift?.best?.dangerHours > 0 && AVOIDS_DANGER.test(text)) {
        problems.push({ ref: c.ref, text, message: `${c.ref}'s safest shift still has ${c.shift.best.dangerHours} Danger hour(s), so say it has fewer Danger hours, not that it avoids them` });
      }
    }
  }
  return problems;
}

/** After one chance to fix them, lines that still fail get the template wording instead. */
export function withoutProblems(plan, problems = checkInProblems(plan)) {
  const refs = new Set(problems.map((p) => p.ref).filter(Boolean));
  const bad = new Set(problems.map((p) => p.text));
  return {
    ...plan,
    summary: bad.has(plan.summary) ? `${plan.checkIns.length} people need a check-in.` : plan.summary,
    teamNote: plan.teamNote && bad.has(plan.teamNote) ? '' : plan.teamNote,
    checkIns: plan.checkIns.map((c) => (refs.has(c.ref) ? { ...c, action: templateAction(c), reason: templateReason(c), writtenBy: 'template' } : c)),
  };
}

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
      reason: byRef.get(s.ref)?.reason || templateReason(s),
      writtenBy: byRef.has(s.ref) ? 'model' : 'template',
    })),
  };
}

async function planGroup({ group, store, weather, agentLog, converse, models, nowMs, deadline, sentinel, allowModel = true }) {
  const members = await store.listGroupMembers(group.groupId);
  if (members.length === 0) return null; // nothing to plan for an empty group
  const risks = await riskForMany(weather, members);
  // Outdoor workers: the safest shift from the full forecast (the weather client has it cached).
  const shifts = new Map();
  for (const m of members.filter((x) => x.profile === 'outdoor_worker')) {
    try {
      const f = await weather.getForecast(m.lat, m.lon);
      const nowKey = f.current?.time?.slice(0, 13) ?? '';
      const ahead = f.hourly.filter((h) => h.time.slice(0, 13) >= nowKey).slice(0, 36);
      const shift = bestShift(ahead);
      if (shift) shifts.set(m.locationId, shift);
    } catch { /* no shift advice without a forecast */ }
  }
  const schedule = buildCheckInSchedule(members, risks, nowMs(), shifts);
  if (schedule.length === 0) {
    const plan = { allClear: true, summary: `Nobody in "${group.name}" reaches their alert level in the next 24 hours.`, checkIns: [], teamNote: '', members: members.length, model: null };
    await agentLog.putState('kai', `group#${group.groupId}`, plan);
    return { plan, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], turns: 0, model: null };
  }

  const forModel = schedule.slice(0, MAX_FOR_MODEL);
  const cells = new Set(members.map((m) => `${m.lat},${m.lon}`));
  const events = (sentinel?.events ?? []).filter((e) => cells.has(`${e.lat},${e.lon}`)).map(({ place, level, trend, headline }) => ({ place, level, trend, headline }));
  const shape = (rows) => rows.map(({ locationId, order, checkInBy, urgency, action, reason, next12Tier, riskyHours, writtenBy, shift }) => ({ locationId, order, checkInBy, urgency, action, reason, tier: next12Tier, riskyHours, writtenBy, shift: shift ?? null }));

  if (!allowModel) {
    // AI work is paused: the algorithm's order and deadlines stand, with template wording.
    const plan = {
      allClear: false,
      summary: `${schedule.length} people need a check-in. The order and deadlines come from the urgency score; AI wording is paused, so each action is a template.`,
      teamNote: '',
      checkIns: shape(schedule.map((s) => ({ ...s, action: templateAction(s), reason: `${TIER_LABELS[s.next12Tier]} expected.`, writtenBy: 'template' }))),
      members: members.length,
      heatEvents: events,
      model: null,
    };
    await agentLog.putState('kai', `group#${group.groupId}`, plan);
    return { plan, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [], turns: 0, model: null };
  }

  let attempt = 0;
  let sentBack = null;
  const run = await runAgent({
    agent: {
      name: 'kai',
      models,
      maxTurns: 4,
      maxTokens: 3000, // ten check-ins, plus a corrected reply when code sends one back

      system: 'You are Kai, HeatShield\'s community coordinator. You help one group leader (a foreman, teacher or outreach worker) decide how to check on the people in their group during heat. The check-in order and deadlines are already computed by an urgency score and earliest-deadline-first scheduling; do not change them. For each person write one concrete, kind, practical action for the leader (what to ask or do, fitted to the person\'s profile and risky hours) and a short reason. When a person has a safestShift, suggest moving their work to it if it avoids Danger hours. Base advice on CDC/NIOSH heat guidance: water and shade breaks, buddy checks, checking older adults twice a day, cool places, never leaving children in vehicles, and calling the local emergency number for heat-stroke signs. You know no one\'s name or gender: refer to each person as "they" or by their role, never "he" or "she". Use the tools.',
      tools: [
        {
          name: 'get_checkin_schedule',
          description: 'People who need a check-in, earliest deadline first, with urgency (0-1) and deadline in their local time. Pseudonymous refs only.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({
            group: group.name,
            people: forModel.map(({ ref, profile, place, localTime, nowTier, next12Tier, riskyHours, urgency, checkInBy, hasEmail, shift }) => ({
              ref, profile: PROFILES[profile]?.label ?? profile, place, localTime, nowTier, next12Tier, riskyHours, urgency, checkInBy, gets_email_alerts: hasEmail,
              ...(shift ? { safestShift: shift } : {}),
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
    // What code can check is sent back once; lines that still fail on the next answer get the template.
    // The check must never cost the plan: if the corrected answer is unusable (1 Oct: cut off mid-JSON),
    // the first answer is used with its failing lines replaced.
    validate: (text) => {
      attempt += 1;
      let parsed;
      try {
        parsed = parseCoordinatorOutput(text, forModel);
      } catch (err) {
        if (sentBack) return withoutProblems(sentBack);
        throw err;
      }
      const problems = checkInProblems(parsed);
      if (attempt === 1 && problems.length) {
        sentBack = parsed;
        throw new Error(problems.map((p) => `${p.message}; rewrite: "${p.text.slice(0, 120)}"`).join(' | '));
      }
      return withoutProblems(parsed, problems);
    },
  }).catch((err) => {
    // The corrected reply never came back usable (for example cut off at the token limit):
    // keep the first answer, with the lines code rejected replaced by the template.
    if (!sentBack) throw err;
    return { value: withoutProblems(sentBack), usage: err.usage ?? { inputTokens: 0, outputTokens: 0 }, toolCalls: err.toolCalls ?? [], turns: null, model: models[0] };
  });

  const parsed = run.value;
  const rest = schedule.slice(MAX_FOR_MODEL).map((s) => ({ ...s, action: templateAction(s), reason: `${TIER_LABELS[s.next12Tier]} expected.`, writtenBy: 'template' }));
  const plan = {
    allClear: false,
    summary: parsed.summary,
    teamNote: parsed.teamNote,
    checkIns: shape([...parsed.checkIns, ...rest]),
    members: members.length,
    heatEvents: events,
    model: run.model,
  };
  await agentLog.putState('kai', `group#${group.groupId}`, plan);
  return { plan, usage: run.usage, toolCalls: run.toolCalls, turns: run.turns, model: run.model };
}

export async function runCoordinator({ store, weather, agentLog, converse, models, groupId = null, nowMs = () => Date.now(), deadline = Date.now() + 240_000, allowModel = true }) {
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
    const r = await planGroup({ group, store, weather, agentLog, converse, models, nowMs, deadline, sentinel, allowModel });
    if (!r) continue;
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
