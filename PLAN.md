# HeatShield — Build Plan

## Status (updated 2026-09-30)
Live: https://d3tda9dyutl7ux.cloudfront.net — details and real command output in `docs/BUILD_LOG.md`.

| Phase | Status |
|---|---|
| 0 · AWS connection + proof | Done: `aws login`, AWS Agent Toolkit, AWS MCP Server `✔ Connected`, first MCP tool call logged. Signed in as root (switch to IAM identity pending). |
| 1 · Skeleton deploy / public URL | Done: SAM stack `heatshield` (us-east-1), CloudFront + S3 (OAC) + HTTP API. |
| 2 · Data model + weather + risk engine | Done: 4 DynamoDB tables, Open-Meteo, NWS heat index verified vs MetPy. |
| 3 · Registration + leader dashboard | Done: groups, invite links, dashboard, personal page, delete-my-data, read-only demo group. |
| 4 · Bedrock localized guidance | Done: Mira writes, Lexi + Vera review (up to 2 revisions); cache; validation; 13 languages. Measured: 47 of 52 new plans published after calibration. Claude Haiku 4.5 is primary once the Anthropic use-case form is submitted (owner action); Nova serves until then. |
| 5 · Alert loop | Done: EventBridge Scheduler hourly → Lambda → SNS; invoked manually (0 errors). Real email proof pending owner's subscription confirmation. |
| 6 · Polish for judging | README, architecture diagram, screenshots, submission text, demo script updated for eight agents, operations, the console and Listen (30 Sep). Remaining: public repo, demo video, Builder Center tags. |
| 7 · Six AI agents (beyond the original plan) | Done: Sol, Mira, Lexi, Vera, Kai, Otto on schedules and on demand; AgentLog; regression test per live incident; 100 tests. |
| 8 · Agent HQ | Done: live pixel-art office, activity feed, agent panels, buttons that run real agents; home-page teaser; Kai's plan on the leader dashboard. |
| 9 · Always on + operator console | Done: retry once then an SQS dead-letter queue, 9 CloudWatch alarms to the ops topic, Otto self-repair, uptime record and a measured AI budget brake; admin console behind Amazon Cognito (pauses, AI kill switch, budget, notice, run now, recall, failed runs, 90-day audit log). Owner: confirm the ops email subscription, first sign-in. |
| 10 · Smarter agents | Done: Sol's ensemble chances, Quinn (forecast audit) and Iris (word lists) as agents seven and eight, Kai's safest shift; first outputs fact-checked against their numbers, four errors fixed with regression tests; 141 tests. |
| 11 · Listen (Amazon Polly) | Done: approved plans read aloud in 7 of 13 languages (no Polly voice for the other 6), content-hashed audio in S3, metered in the AI budget. |
| 12 · Ask the team | Done: a prompt box on Agent HQ; Kai (Kimi K2.5, chosen by measuring five models; Nova Pro fallback) assigns questions to the agents' read-only tools; code checks every number, health statement, link and the emergency sentence; about US$0.003 a question. |

Read `CLAUDE.md` first. This is the order of operations, sized for a hackathon timeline
(assume 3–5 focused working sessions before the deadline; adjust dates once you know the
actual submission deadline and put it at the top of this file).

## Phase 0 — Setup & proof of connection (do this first, it's a hard requirement)
1. Create/confirm AWS account, set up IAM Identity Center or an IAM user scoped to what we need
   (avoid root credentials for anything).
2. Connect Claude Code to AWS using the AWS MCP Server (`.claude/skills/aws-connect-proof/SKILL.md`).
3. Capture proof immediately: `aws sts get-caller-identity` output, `/mcp` connection status,
   first few tool calls — paste into `docs/BUILD_LOG.md`. Do not wait until the end to do this.
4. Pick IaC tool (SAM recommended for speed) and commit an empty `template.yaml` + `sam --version`
   output to prove the toolchain works end to end before writing real resources.

## Phase 1 — Skeleton deploy (get a public URL live on day one)
Goal: an empty "Hello HeatShield" page on a real public AWS URL, deployed via the coding agent,
before any real feature work. This de-risks the ship gate — if something breaks later, we still
have a live URL.
1. S3 bucket (static site) + CloudFront distribution.
2. API Gateway HTTP API + one Lambda ("healthcheck") returning JSON.
3. Deploy via SAM. Record the CloudFront URL in `CLAUDE.md` under "What done looks like" and in
   `docs/BUILD_LOG.md`.
4. Confirm the URL loads from a phone/incognito window, not just the dev machine.

## Phase 2 — Data model & weather ingestion
1. DynamoDB tables: `Locations` (PK: locationId; fields: lat, lon, label, riskProfile, language,
   phone/email, groupOwnerId), `Alerts` (PK: alertId; fields: locationId, sentAt, riskScore, channel).
2. Lambda: given lat/lon, call Open-Meteo (or NWS for US coords), return current + forecast temp,
   humidity, and a computed heat-index risk score (see `.claude/skills/heat-risk-engine/SKILL.md`
   for the exact formula and thresholds — don't reinvent the heat-index math, use the skill).
3. Wire this Lambda behind an API route (`GET /risk?locationId=...`) and test against 2–3 real
   world coordinates spanning different climates (e.g., Phoenix, Lagos, Dubai) to sanity-check
   the risk tiers feel right.

## Phase 3 — Registration flow (frontend + API)
1. Simple form: name/label, location (address → geocode, or lat/lon directly), risk profile
   (outdoor worker / elderly / chronic condition / child / general), preferred language, contact
   (phone for SMS or email).
2. `POST /locations` Lambda writes to DynamoDB.
3. Frontend shows the current risk score + (once Phase 4 lands) the generated action paragraph
   for a registered location.
4. "Community leader" view: list all locations tied to one groupOwnerId, each with its current
   risk tier at a glance — this is the Community-lane story, make it visually obvious.

## Phase 4 — AI localization/guidance layer (the innovation centerpiece)
1. Lambda calls Amazon Bedrock with the structured risk data + risk profile + target language,
   using a tight prompt template (see `.claude/skills/bedrock-multilingual-guidance/SKILL.md`)
   to produce a short, specific, plain-language action paragraph — not a generic "stay hydrated."
2. Cache the generated text per (locationId, risk tier, language) for a few hours in DynamoDB to
   avoid regenerating identical guidance on every page load (cost + latency control).
3. Test in at least two languages end to end (e.g., English + Arabic, or English + Spanish) —
   this is a judged "worldwide problem" signal, don't skip it.

## Phase 5 — Alerting loop
1. EventBridge Scheduler → Lambda runs every N hours (e.g., every 3h), pulls all `Locations`,
   recomputes risk, and for any location crossing its profile's threshold and not already alerted
   in the last N hours (check `Alerts` table), sends an SNS SMS/email with the localized guidance.
2. Manually trigger the scheduled Lambda once and capture a real sent alert (screenshot/log) for
   the submission — this is the single most convincing "it actually works" artifact we can show.

## Phase 6 — Polish for judging
1. README.md: problem statement (numbers, not adjectives), architecture diagram, tech stack list
   with AWS services named explicitly, live URL, demo GIF/video link, how the coding agent was
   used (link or excerpt from `docs/BUILD_LOG.md`).
2. Architecture diagram (can be a simple draw.io/excalidraw export or ASCII — clarity over polish).
3. 2–3 minute demo video: registration → risk score → localized action text in two languages →
   a triggered alert. Screen record, don't overproduce.
4. Run the full checklist in `.claude/skills/ship-gate-check/SKILL.md` — literally go through it
   line by line before touching Builder Center.
5. Use `.claude/skills/submission-storytelling/SKILL.md` to draft the Builder Center submission
   text against the actual judging criteria (creativity, technical innovation, impact, communication).
6. Tag `#social-good` + `#community` (or `#startups` — pick one, see lane-flexibility note below)
   in Builder Center before the deadline.

## Lane flexibility (Community vs Startup)
The build is identical either way — only the submission narrative changes:
- **Community:** frame around one campus/labor crew/neighborhood adopting HeatShield, the
  "community leader dashboard" front and center, low-friction free access.
- **Startup:** frame around a path to sustainability (e.g., municipal/NGO/employer licensing of
  the dashboard for their workforce or residents), a first pilot partner, growth plan.
Decide which story we're telling *before* Phase 6 so the README and demo match the tag.

## Explicit non-goals (don't let scope creep eat the timeline)
- No native mobile app — a responsive web page is enough.
- No custom ML model training — Bedrock's foundation models via prompting is the right scope.
- No payments/billing, even if pitching the Startup lane — describe the plan, don't build it.
- No multi-tenant auth system beyond a simple shared enrollment link/light Cognito if time allows.
