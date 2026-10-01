# Builder Center submission — HeatShield

**Category:** Social Good (Climate resilience) — `#social-good`
**Lane:** Community — `#community`
**Live app:** https://d3tda9dyutl7ux.cloudfront.net
**Agent HQ (the eight agents, live):** https://d3tda9dyutl7ux.cloudfront.net/agents.html
**Demo dashboard (read-only):** https://d3tda9dyutl7ux.cloudfront.net/group.html#g=5NpOU_pMXAK_&k=Q51QdY6DIZK7P4pLCF9B8KAiofrIcFgj
**Demo video:** https://d3tda9dyutl7ux.cloudfront.net/demo.html (4:34, captions, chapters, transcript)
**Repository:** https://github.com/CodeOps124/heatshield

---

## Title
HeatShield — heat early warning that tells you what to do, in your language, run by eight AI agents

## One-line pitch
A weather app tells you it's 41 °C; HeatShield tells an outdoor worker, an older adult or a parent
what to do about it in the next few hours, in their own language (and reads it aloud), warns them
before the hottest hours arrive, and tells the person looking after a group who to check on first.

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
  hour, with the trend, the 24-hour peak, the person's risky hours and a 4-day outlook. Older adults,
  pregnant people, young children and people with chronic conditions are warned one tier earlier.
- **An action plan in 13 languages, checked before anyone sees it, and read aloud:** Amazon Bedrock
  writes a headline, three concrete steps with clock times, and the warning signs to act on,
  grounded in vetted CDC/NIOSH facts; a language reviewer and a safety reviewer check it first.
  Amazon Polly reads it aloud in 7 of the 13 languages (no voice exists yet for the other 6).
- **Alerts people don't have to ask for:** EventBridge Scheduler re-checks everyone hourly; Amazon
  SNS emails people when their risk reaches their level (one alert per level per day, never at night).
- **The Community lane multiplier:** a foreman, teacher or clinic worker creates a group, shares one
  invite link, sees everyone's live risk on one private dashboard, and gets a check-in plan: who to
  contact first, by when in each person's time zone, what to ask, and for outdoor workers the safest
  8-hour shift tomorrow.
- **Eight AI agents run it around the clock**, and anyone can watch them in Agent HQ, a live
  pixel-art office drawn from their real runs.
- **Ask the team:** type a question in any of the 13 languages. Kai assigns it to the agents' real,
  read-only tools (Sol's heat read, Quinn's audit, Mira's reviewed plan, Kai's shift search, Vera's
  vetted facts, Otto's status), and code checks every number and health statement before the answer
  is shown. About US$0.003 a question; nothing typed is stored.
- **Always on, and under control:** failed runs are retried and kept in a dead-letter queue, Otto
  re-runs agents that miss their schedule, nine CloudWatch alarms email the operator, a measured
  daily AI budget stops new AI work (never the alerts), and an operator console behind Amazon
  Cognito can pause agents, switch AI off, set the budget, post a site-wide notice and recall a plan.

## The eight agents (algorithm for the exact part, a model for judgment, code for the final call)
| Agent | Job | Algorithm | Model |
|---|---|---|---|
| Sol (hourly) | finds heatwaves, writes the situation briefing | Excess Heat Factor vs each city's 1991–2020 ERA5 climate; chance of Danger from the 51-member ECMWF ensemble; NWS tiers; OLS trend | Amazon Nova 2 Lite; can never exceed the evidence ceiling |
| Quinn (daily) | audits the forecast | 14-day verification of day-ahead and 3-day-ahead peaks: error, bias, tier agreement, Danger hits / misses / false alarms | Nova 2 Lite picks claims; code checks each and writes the sentence |
| Mira | writes each plan | BM25 retrieval over 22 vetted facts, plus Iris's word list | Amazon Nova 2 Lite (Nova Pro as backup) |
| Lexi | checks the language | naive-Bayes language ID | Amazon Nova Pro back-translation |
| Vera | checks the safety | detectors for phone numbers, medicines, doses | Nova Pro rubric review, with a second reading of any harm objection |
| Kai (3-hourly, and every question) | plans group check-ins; coordinates Ask the team | logistic urgency score + earliest-deadline-first across time zones; safest-shift search | Nova 2 Lite words each check-in (names never reach the model); Kimi K2.5 coordinates questions, every number checked by code |
| Iris (daily) | teaches the team | word-level corrections from 7 days of Lexi's reviews, conflicting fixes dropped | Nova Pro second opinion before anything is published |
| Otto (15 min) | keeps the site up and the bill bounded | probes, EWMA control charts, heartbeats, CloudWatch log scans, measured AI spend | Nova 2 Lite incident reports, only for new incidents |

## Technical innovation & originality
- **Agents with real algorithms, not personas.** Each agent's exact part is an algorithm with a
  citation (EHF, ensemble exceedance, forecast verification, BM25, naive Bayes, logistic scoring,
  EDF, EWMA); the model does the judgment; code makes the final call (evidence ceilings, headlines
  and trends computed from the numbers, reviewer verdicts computed from issue categories, Quinn's
  claims checked against the scores). Agents coordinate through shared state in DynamoDB.
- **A team that audits and teaches itself.** Quinn measures how far the forecast can be trusted in
  each city and Sol is given that track record; Iris turns the language reviewer's corrections into
  word lists the writer follows. Both were fact-checked against their own numbers on their first live
  run, and each error found became a rule in code and a regression test.
- **A model chosen by measurement.** For Ask the team, five Bedrock models ran the same prompts;
  Kimi K2.5 routed 10 of 10 and invented the fewest numbers, while gpt-oss-120b invented numbers in
  4 of 5 answers (including a "999" phone number) and Mistral Large 3 printed tool calls as text.
  Whatever the model, code checks each answer's numbers against the tools before it is shown.
- **Measured, not assumed.** A live evaluation script asks the deployed API for one plan per
  language. Before calibration, 1 of 5 new plans passed review; after five measured steps, 47 of 52
  (90%), and every rejected plan contained a real error.
- **Amazon Bedrock and Amazon Polly engineered for a public endpoint.** No user text reaches any
  model, approved plans are cached under a hash of the exact inputs, only HeatShield's own text can
  be spoken, and every failure has a path: resample, next model, pre-written advice.

## Implementation quality
- Fully serverless, one SAM template: CloudFront (OAC, strict CSP/HSTS) + private S3, API Gateway
  HTTP API with per-route throttling and a Cognito JWT authorizer, nine least-privilege Lambda
  functions on Graviton, five on-demand DynamoDB tables, two SNS topics, an SQS dead-letter queue,
  six EventBridge schedules, nine CloudWatch alarms, X-Ray.
- 157 unit and regression tests. Every problem the live agents hit became a regression test named
  after the event; headless-Chrome end-to-end tests run against production.
- Privacy by design: locations rounded to ~1 km; emails never stored in our database (only in the
  SNS subscription, double opt-in); bearer secrets stored as SHA-256; one-click delete for members,
  and for leaders a whole-group delete.
- Cost measured from the agent log: about US$0.008 per new plan, about US$0.005 per plan read aloud,
  about US$0.003 per question, about US$0.05–0.10 a day for the background agents, and a daily budget
  that caps the worst case.

## How I built it: a coding agent connected to AWS
I connected my coding agent to AWS through the official AWS Agent Toolkit (browser `aws login`, then
the AWS MCP Server), and the process is logged with real output in `docs/BUILD_LOG.md`. Examples:
1. The Bedrock model IDs came from a real `ListInferenceProfiles` call and Polly's voices from a
   real `DescribeVoices` call through the AWS MCP server, and each voice was tested before use.
2. The heat-index code was verified against MetPy reference values and the Excess Heat Factor against
   the published paper before coding them.
3. A deploy → run → read back → fix loop ran through the MCP server (DynamoDB agent-log queries,
   CloudWatch Logs searches, Lambda invocations). That is how I found an Open-Meteo rate limit
   dropping cities, a model headline that put dangerous heat on the wrong day, reviewers blocking
   correct plans, an auditor calling a forecast record "perfect" that had missed 2 Danger days, a
   word list that would have dropped a heat-stroke sign, and a watchdog reading only the first page
   of log results.
4. AWS behaviour was checked against the documentation before relying on it (for example that
   CloudWatch Logs can return an empty page before the matching events, and that EventBridge
   Scheduler invokes Lambda asynchronously, so retries and the dead-letter queue apply).
5. A real browser was driven through the live site after every deploy, and what the screenshots
   showed was fixed.

## Community and market impact
HeatShield is free and works anywhere Open-Meteo covers (the whole planet). One leader can protect
up to 200 people per group today, and Kai tells them who to reach first and which hours to work.
The serverless design costs almost nothing when idle, scales with use, and cannot overspend.
Natural adopters: construction and farm crews, delivery fleets, senior-living and home-care
networks, schools, and community health workers. Next steps: SMS/WhatsApp delivery via AWS End User
Messaging, fluent-speaker review of each language, voices for the six languages Polly lacks, and
WBGT for occupational use.

## Honest limitations
The heat index is a shade value (we say so on screen). Reviewer agents are models too: a rejected
plan falls back to pre-written advice, which exists in English, Spanish and French only (other
languages get English with a notice). Listen covers 7 of 13 languages. Quinn scores the forecast
against the model's own analysis, not weather stations. Every plan is written by Amazon Nova models. Email is the live alert channel; SMS is not claimed. HeatShield gives safety
information, not medical care.
