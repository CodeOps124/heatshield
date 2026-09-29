# Builder Center submission — HeatShield

**Category:** Social Good (Climate resilience) — `#social-good`
**Lane:** Community — `#community`
**Live app:** https://d3tda9dyutl7ux.cloudfront.net
**Agent HQ (the six agents, live):** https://d3tda9dyutl7ux.cloudfront.net/agents.html
**Demo dashboard (read-only):** https://d3tda9dyutl7ux.cloudfront.net/group.html#g=5NpOU_pMXAK_&k=Q51QdY6DIZK7P4pLCF9B8KAiofrIcFgj
**Repository:** `<add the public GitHub URL once published>`

---

## Title
HeatShield — heat early warning that tells you what to do, in your language, run by six AI agents

## One-line pitch
A weather app tells you it's 41 °C; HeatShield tells an outdoor worker, an older adult or a parent
what to do about it in the next few hours, in their own language, warns them before the hottest
hours arrive, and tells the person looking after a group who to check on first.

## The problem
Heat is linked to an estimated 489,000 deaths a year (WHO, 2000–2019 average). 2.4 billion of the
world's 3.4 billion workers are likely to be exposed to excessive heat at work, and heat causes an
estimated 18,970 work-related deaths a year (ILO, April 2024). The people most at risk (older
adults, people with chronic illness, outdoor workers, families without cooling) are the least
likely to get a warning that is specific to their body, their job and their language. A forecast
gives a number. Nobody turns it into "stop heavy work from 13:00 to 17:00, drink a cup of water
every 15–20 minutes, and here are the signs that mean call for help", in Urdu, Arabic or Hindi.

## What we built
- **Real heat science, per person:** live hourly forecast (Open-Meteo) → the US National Weather
  Service heat-index formula (verified against an independent implementation) → risk tier hour by
  hour, with the trend, the 24-hour peak, the person's risky hours ("now until 04:00 tomorrow") and
  a 4-day outlook. Older adults, pregnant people, young children and people with chronic conditions
  are warned one tier earlier.
- **An action plan in 13 languages, checked before anyone sees it:** Amazon Bedrock writes a
  headline, three concrete steps with clock times, and the warning signs to act on, grounded in
  vetted CDC/NIOSH facts; a language reviewer and a safety reviewer check it first.
- **Alerts people don't have to ask for:** EventBridge Scheduler re-checks everyone hourly; Amazon
  SNS emails people when their risk reaches their level (one alert per level per day, never at night).
- **The Community lane multiplier:** a foreman, teacher or clinic worker creates a group, shares one
  invite link, sees everyone's live risk on one private dashboard, and gets a check-in plan: who to
  contact first, by when in each person's time zone, and what to ask.
- **Six AI agents run it around the clock**, and anyone can watch them in Agent HQ, a live
  pixel-art office drawn from their real runs, and give them a task.

## The six agents (algorithm for the exact part, a model for judgment, code for the final call)
| Agent | Job | Algorithm | Model |
|---|---|---|---|
| Sol (hourly) | finds heatwaves, writes the situation briefing | Excess Heat Factor vs each city's 1991–2020 ERA5 climate; NWS tiers; OLS trend | Amazon Nova 2 Lite; can never exceed the algorithm's evidence ceiling |
| Mira | writes each plan | BM25 retrieval over 21 vetted facts | Nova 2 Lite (Claude Haiku 4.5 once enabled) |
| Lexi | checks the language | naive-Bayes language ID | Amazon Nova Pro back-translation |
| Vera | checks the safety | detectors for phone numbers, medicines, doses | Nova Pro rubric review, with a second reading of any harm objection |
| Kai (3-hourly) | plans group check-ins | logistic urgency score + earliest-deadline-first across time zones | Nova 2 Lite words each check-in; names never reach the model |
| Otto (15 min) | keeps the site up | probes, EWMA control charts, heartbeats, CloudWatch log scans | Nova 2 Lite incident reports, only for new incidents |

## Technical innovation & originality
- **Agents with real algorithms, not personas.** Each agent's exact part is an algorithm with a
  citation (EHF, BM25, naive Bayes, logistic scoring, EDF, EWMA); the model does the judgment; code
  makes the final call (evidence ceilings, trends and headlines computed from the numbers, reviewer
  verdicts computed from issue categories). Agents coordinate through shared state in DynamoDB.
- **Measured, not assumed.** A live evaluation script asks the deployed API for one plan per
  language. Before calibration, 1 of 5 new plans passed review (the reviewers blocked for the wrong
  reasons); after five measured steps, 47 of 52 (90%), and every rejected plan contained a real error.
- **Amazon Bedrock engineered for a public endpoint.** Prompts are built only from enumerated values
  (no user text reaches any model), approved plans are cached under a hash of the exact inputs, and
  every failure has a path: resample, next model, pre-written advice. A person at risk never sees a
  blank screen.

## Implementation quality
- Fully serverless, one SAM template: CloudFront (OAC, strict CSP/HSTS) + private S3, API Gateway
  HTTP API with per-route throttling, six least-privilege Lambda functions on Graviton, five
  on-demand DynamoDB tables, two SNS topics, four EventBridge schedules, CloudWatch Logs, X-Ray.
- 100 unit and regression tests. Every problem the live agents hit became a regression test named
  after the event; headless-Chrome end-to-end tests run against production.
- Privacy by design: locations rounded to ~1 km; emails never stored in our database (only in the
  SNS subscription, double opt-in); bearer secrets stored as SHA-256; one-click delete for members,
  and for leaders a whole-group delete.
- Cost measured: about US$0.01 per new plan, about US$0.05 a day for the background agents.

## How the coding agent (Claude Code) helped ship it
Claude Code was connected to AWS through the official AWS Agent Toolkit (browser `aws login`, then
the AWS MCP Server), and the process is logged with real output in `docs/BUILD_LOG.md`. Examples:
1. It took the Bedrock model IDs from a real `ListInferenceProfiles` call through the AWS MCP server.
2. It verified the heat-index code against MetPy reference values and the Excess Heat Factor against
   the published paper before coding them.
3. It ran a deploy → run → read back → fix loop through the MCP server (DynamoDB agent-log queries,
   CloudWatch Logs searches, Lambda invocations). That is how it found an Open-Meteo rate limit
   dropping cities, a "re-brief every 6 hours" rule that could never fire, a model headline that
   put dangerous heat on the wrong day, and reviewers blocking correct plans.
4. It found an IAM scoping bug with CloudTrail, and an abuse vector in its own code (sign-ups
   trigger AWS confirmation emails) that it throttled before launch.
5. It drove a real browser through the live site after every deploy and fixed what the screenshots
   showed.

## Community and market impact
HeatShield is free and works anywhere Open-Meteo covers (the whole planet). One leader can protect
up to 200 people per group today, and Kai tells them who to reach first. The serverless design costs
almost nothing when idle and scales with use. Natural adopters: construction and farm crews,
delivery fleets, senior-living and home-care networks, schools, and community health workers. Next
steps: SMS/WhatsApp delivery via AWS End User Messaging, fluent-speaker review of each language, and
WBGT for occupational use.

## Honest limitations
The heat index is a shade value (we say so on screen). Reviewer agents are models too: a rejected
plan falls back to pre-written advice, which exists in English, Spanish and French only (other
languages get English with a notice). Claude Haiku 4.5 is wired as the primary writer but needs a
one-time Anthropic use-case form on the account; until then Amazon Nova writes every plan. Email is
the live alert channel; SMS is not claimed. HeatShield gives safety information, not medical care.
