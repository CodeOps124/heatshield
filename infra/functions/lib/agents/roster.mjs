/**
 * The six agents (plus the deterministic alert dispatcher) as shown in the Agent HQ office.
 * `schedule.everyMin` / `offsetMin` mirror the EventBridge Scheduler cron expressions in
 * infra/template.yaml so the UI can show a truthful "next run" countdown.
 */
export const ROSTER = [
  {
    id: 'sol', name: 'Sol', role: 'Heat Sentinel', desk: 'Forecast desk',
    expertise: 'Heat-health early warning: detects heatwaves relative to each place\'s own climate.',
    algorithm: 'Excess Heat Factor (Nairn & Fawcett 2015) vs. 1991–2020 ERA5 climatology · NWS heat-index tiers · least-squares temperature trend',
    decides: 'Which areas get a heat watch, warning or emergency (never above the algorithm\'s evidence ceiling), and writes the situation briefing.',
    model: 'Amazon Nova 2 Lite', tools: ['list_heat_signals', 'get_area_detail', 'get_previous_briefing'],
    trigger: 'Every hour at :05', schedule: { everyMin: 60, offsetMin: 5 },
  },
  {
    id: 'mira', name: 'Mira', role: 'Health Advisor', desk: 'Advice desk',
    expertise: 'Public-health communication grounded in CDC/NIOSH/NWS guidance.',
    algorithm: 'Okapi BM25 retrieval over a vetted 21-fact library (only the facts relevant to this person reach the model)',
    decides: 'What this person should do in the coming hours; rewrites when the reviewers push back.',
    model: 'Claude Haiku 4.5 → Amazon Nova 2 Lite', tools: [],
    trigger: 'Every new action plan (cached plans are reused)', schedule: null,
  },
  {
    id: 'lexi', name: 'Lexi', role: 'Language Reviewer', desk: 'Translation desk',
    expertise: 'Translation review and plain-language editing in 13 languages.',
    algorithm: 'Multinomial naive-Bayes language identification (function-word profiles) + Unicode-script rules, then a literal back-translation',
    decides: 'Approve, or send the plan back with the exact wrong words and fixes.',
    model: 'Amazon Nova Pro', tools: [],
    trigger: 'Reviews every new action plan', schedule: null,
  },
  {
    id: 'vera', name: 'Vera', role: 'Safety Reviewer', desk: 'Safety desk',
    expertise: 'Clinical-safety review against vetted public-health facts.',
    algorithm: 'Deterministic detectors (phone numbers, medicines, doses) + LLM-as-judge with a fixed five-rule rubric',
    decides: 'Approve, or send the plan back citing the rule it broke.',
    model: 'Amazon Nova Pro', tools: [],
    trigger: 'Reviews every new action plan', schedule: null,
  },
  {
    id: 'kai', name: 'Kai', role: 'Community Coordinator', desk: 'Outreach desk',
    expertise: 'Community heat check-in programmes: who to call, by when, and what to say.',
    algorithm: 'Logistic urgency score (transparent hand-set weights) + earliest-deadline-first scheduling across time zones',
    decides: 'The words of each check-in; the order and deadlines come from the algorithm.',
    model: 'Amazon Nova 2 Lite', tools: ['get_checkin_schedule', 'get_heat_events'],
    trigger: 'Every 3 hours at :15, and on demand from a leader\'s dashboard', schedule: { everyMin: 180, offsetMin: 15 },
  },
  {
    id: 'otto', name: 'Otto', role: 'Ops Watchdog', desk: 'Ops desk',
    expertise: 'Site reliability engineering for the live service.',
    algorithm: 'Synthetic probes of the public URL · EWMA control charts (3σ) on latency · agent heartbeats · CloudWatch error counts',
    decides: 'Healthy / degraded / down, and writes incident reports when something new breaks.',
    model: 'Amazon Nova 2 Lite (only when something is wrong)', tools: ['get_triage', 'get_error_samples'],
    trigger: 'Every 15 minutes', schedule: { everyMin: 15, offsetMin: 0 },
  },
];

export const WORKERS = [
  {
    id: 'dispatch', name: 'Dispatcher', role: 'Alert dispatcher (deterministic worker, not an AI agent)',
    trigger: 'Every hour at :00', schedule: { everyMin: 60, offsetMin: 0 },
  },
];

/** Next run time for a schedule aligned to UTC midnight: minutes ≡ offset (mod everyMin). */
export function nextRunAt(schedule, nowMs) {
  if (!schedule) return null;
  const minute = Math.floor(nowMs / 60_000);
  const dayStart = Math.floor(minute / 1440) * 1440;
  let m = dayStart + schedule.offsetMin;
  while (m <= minute) m += schedule.everyMin;
  return new Date(m * 60_000).toISOString();
}
