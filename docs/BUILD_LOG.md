# Build Log

This is graded — the hackathon requires the submission to show the development process and how
the coding agent helped ship it. Update this after every real working session. Paste real command
output, not summaries.

## Template for each entry
```
### YYYY-MM-DD — <what was worked on>
- What Claude Code did:
- Commands run / AWS resources touched (real output):
- Decisions made and why:
- What's left:
```

## AWS ↔ Claude Code connection proof
Captured live on 2026-09-28 while following the official AWS Agent Toolkit setup
(`aws/agent-toolkit-for-aws/setup-instructions/setup.md`). Account ID partially redacted
(`6115****0540`); everything else is verbatim.

**1. Sign-in (setup step 3) — browser-based `aws login`, no access keys anywhere on disk or in `.env`:**
```
$ aws configure set region us-east-1 --profile heatshield
$ aws login --region us-east-1 --profile heatshield
Attempting to open your default browser. If the browser does not open, open the following URL.
...
Updated profile heatshield to use arn:aws:iam::6115****0540:root credentials.
EXIT_CODE=0
```

**2. Identity (setup step 4), 2026-09-28T18:11:02Z:**
```
$ aws sts get-caller-identity --profile heatshield
{
    "UserId": "6115****0540",
    "Account": "6115****0540",
    "Arn": "arn:aws:iam::6115****0540:root"
}
```
> Honest note: this session is signed in as the account's **root** user, which AWS (and our own
> PLAN.md) advise against for day-to-day work. See "What's left" for the planned switch to a
> least-privilege IAM identity.

**3. Agent Toolkit (setup step 5):** `aws configure agent-toolkit --yes --region us-east-1 --profile heatshield`
installed 24 AWS skills (amazon-bedrock, aws-serverless, aws-cloudformation, aws-iam, …) into
`~/.claude/skills` and wrote an `aws-mcp` server into Claude Code's config. It then crashed while
configuring a *different* agent on Windows (`FileNotFoundError: [WinError 2]` in
`agenttoolkit\agents.py::_configure_via_shell` — a `subprocess.run` of a CLI shim without a
shell); the Claude Code entry had already been written. Per the guide, the profile was then added:
```json
"aws-mcp": {
  "command": "uvx",
  "args": ["mcp-proxy-for-aws@latest", "https://aws-mcp.us-east-1.api.aws/mcp", "--metadata", "INSTALL_SOURCE=aws-cli"],
  "env": { "AWS_MCP_PROXY_PROFILES": "heatshield" }
}
```

**4. MCP connection status:**
```
$ claude mcp list
Checking MCP server health…
...
aws-mcp: uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli - ✔ Connected
```

**5. Toolkit verification (setup step 6):**
```
$ aws agent-toolkit list-available-skills --region us-east-1 --profile heatshield
{ "skills": [ { "name": "amazon-aurora-mysql", ..., "skillVersion": "v1", "categories": [] }, ... ] }
```

**6. First real tool call through the AWS MCP server** (JSON-RPC over stdio to the exact server
entry above: `initialize` → `tools/list` → `tools/call`). This call is also where the Bedrock model
IDs used in `infra/params.json` came from — nothing was guessed:
```
[2026-09-28T18:14:42.259Z] initialize -> server: {"name":"MCP Proxy for AWS","version":"1.7.0"} protocol 2025-06-18
[2026-09-28T18:14:43.637Z] tools/list -> 8 tools: aws___get_presigned_url, aws___get_tasks, aws___run_script,
    aws___get_regional_availability, aws___list_regions, aws___read_documentation, aws___retrieve_skill,
    aws___search_documentation
[2026-09-28T18:14:55.595Z] tools/call aws___run_script ->   (sts:GetCallerIdentity + bedrock:ListInferenceProfiles)
{ "status": "success",
  "return_value": {
    "callerArn": "arn:aws:iam::6115****0540:root",
    "inferenceProfiles": [
      {"id": "us.amazon.nova-2-lite-v1:0", "status": "ACTIVE", "routesTo": ["us-east-1","us-east-2","us-west-2"]},
      {"id": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "status": "ACTIVE", "routesTo": ["us-east-1","us-east-2","us-west-2"]},
      ... (nova-micro, nova-lite, nova-pro, nova-premier, global.* profiles)
    ]},
  "api_calls": [{"service": "sts", "operation": "GetCallerIdentity", "status": "success"},
                {"service": "bedrock", "operation": "ListInferenceProfiles", "status": "success",
                 "n_items": {"inferenceProfileSummaries": 88}}] }
```

**7. AWS rules added to `CLAUDE.md` (setup step 7)** between `<!-- BEGIN/END AWS Agent Toolkit rules -->`
markers, appended below the project's own instructions (which take precedence).

---

### 2026-09-28 — Session 1: from starter kit to a working, tested app (local)

**What Claude Code did**
- Read `CLAUDE.md`, `PLAN.md` and all six project skills before writing code, then fetched the
  official AWS Agent Toolkit setup instructions
  (`aws/agent-toolkit-for-aws/setup-instructions/setup.md`).
- Checked the machine before touching anything: AWS CLI `2.36.49` present (supports `aws login`),
  no `~/.aws` profile yet, SAM CLI missing, `uv 0.11.21`, Node `v24.14.0`.
- Installed SAM CLI with `uv tool install aws-sam-cli` → `SAM CLI, version 1.166.2`.
- Verified every domain fact against a primary source *before* coding it (no invented numbers):
  - NWS heat-index algorithm (Rothfusz regression + both adjustments) — wpc.ncep.noaa.gov
  - NWS tiers and "full sun adds up to 15 °F" — weather.gov/ama/heatindex
  - NIOSH hydration (1 cup / 15–20 min, ≤ 6 cups/h), acclimatization, buddy system — cdc.gov/niosh
  - CDC older-adult guidance (check twice a day, fans not a main cooling source) — cdc.gov
  - Heat-stroke / heat-exhaustion signs and first aid — cdc.gov/niosh/heat-stress/about/illnesses.html
  - WHO: ~489,000 heat-related deaths/year (2000–2019); ILO (Apr 2024): 2.41 bn of 3.4 bn workers
    exposed to excessive heat, 18,970 work deaths/year
  - CloudFront managed policy IDs (CachingOptimized, CachingDisabled, AllViewerExceptHostHeader)
  - Open-Meteo forecast + geocoding response shapes (called live with `curl`)
- Built the backend (Node.js 22 ESM, zero runtime dependencies), frontend (plain HTML/CSS/JS),
  SAM template, local dev server, and deploy/seed scripts. 3 commits.

**Heat-index engine verified against an independent implementation.** Claude Code generated
reference values with MetPy (a meteorology library that implements the same NWS algorithm) and
pinned them in unit tests:
```
$ uvx --with metpy python -c "...heat_index(...)..."
  [86, 50, 87.8883],   [90, 50, 94.5969],  [90, 70, 105.9220], [95, 40, 98.9894],
  [95, 60, 113.0903],  [100, 40, 109.2556], [100, 55, 123.6383], [104, 45, 124.4209],
  [110, 30, 122.3373], [96, 75, 132.1396],  [100, 10, 94.1225],  [105, 5, 96.8712],
  [82, 90, 91.9917],   [85, 95, 104.6123],  [120, 20, 129.9149], [88, 40, 87.9036],
```
MetPy's *low-temperature* shortcut differs slightly from the NWS text (it switches at 79 °F using
a different simple formula), so we follow the NWS text and only use MetPy points inside the
regression regime. That discrepancy was found by reading MetPy's source, not assumed.

**Live data smoke test (real Open-Meteo, 2026-09-28, outdoor-worker profile):**
```
Karachi  2026-09-28T22:30 now 27.4C 77% HI 30.3 caution         | peak 13:00 33.9 extreme_caution | window 10:00-17:00 | alert true
Dubai    2026-09-28T21:30 now 31.5C 79% HI 42.2 danger          | peak 20:00 44.3 danger | window 21:00-04:00 | alert true
Lagos    2026-09-28T18:30 now 25.6C 86% HI 26.5 lower           | peak 13:00 30.4 caution | window none | alert false
Phoenix  2026-09-28T10:30 now 26.8C 64% HI 28.1 caution         | peak 11:00 29.8 caution | window none | alert false
Cuiaba   2026-09-28T13:30 now 39.6C 25% HI 40.4 danger          | peak 13:00 40.6 danger | window 13:00-01:00 | alert true
geocode: Lagos, Nigeria 6.45,3.39 | Lagos, France 43.21,-0.22
```
(Dubai at 21:30 is "Danger" because of 79 % humidity — exactly the case raw temperature misses.)

**Tests and template lint:**
```
$ npm test
ℹ tests 46
ℹ pass 46
ℹ fail 0

$ sam validate --lint --template-file infra/template.yaml --region us-east-1
C:\Users\nilay\Downloads\AWS Hackathon\infra\template.yaml is a valid SAM Template
```

**UI verified in a real browser, not assumed.** Claude Code drove the installed Chrome headlessly
(playwright-core) through the whole flow on the local dev server: check risk → create group → join
via invite link (with a `<script>` tag as the name) → leader dashboard (dark mode) → personal page
→ mobile (390 px, Arabic, RTL). Result: no JavaScript errors, `mobileHorizontalOverflowPx: 0`, the
injected name rendered as inert text, chart tooltip + keyboard navigation working
(`"13:00 (tomorrow): heat index 34 °C, Extreme caution"`). The screenshots caught three real
bugs, all fixed in the same session:
1. A broad `.chart-wrap svg` CSS rule also matched the icon inside the tooltip's tier badge and
   blew it up to full width → scoped to `.chart-wrap > svg`.
2. On a 390 px phone the hourly x-axis labels collided ("Now00:00") → tick spacing now adapts
   to width (3 h or 6 h).
3. Forecast-tile tier badges overflowed their tiles, and the sticky header covered the top of the
   result card after scrolling → badge wrapping + `scroll-margin-top`.

**Decisions made and why**
- *Bedrock via the Converse API, not the Anthropic SDK:* it ships inside the Lambda runtime (no
  bundling) and the same call works for Claude and Amazon Nova, which is what makes the
  Claude → Nova → static-text fallback chain one code path.
- *Prompt receives only enumerated values* (tiers, clock hours, profile, language) — never user
  text. Consequences: no prompt-injection surface, and a finite cache-key space, so a public
  endpoint cannot be used to run up the Bedrock bill with unique requests.
- *Model output is validated* (JSON shape, lengths, and Unicode script — Arabic requested must
  come back in Arabic script) before anyone sees it; failures fall through to the next model,
  then to hand-written guidance (EN/ES/FR) with an honest "shown in English" notice.
- *Privacy by design:* coordinates rounded to ~1 km before storage; emails never stored in our
  database (only inside the SNS subscription, double opt-in); bearer secrets stored as SHA-256;
  secrets kept in the URL `#fragment` so they never reach server logs; one-click delete.
- *Alert dedupe is atomic:* a DynamoDB conditional write claims "one alert per person per tier
  per local day"; if SNS delivery fails the claim is released so the next hourly run retries.
- *Quiet hours* (21:00–06:00 local): an early warning at 3 a.m. helps nobody; the 06:00 run
  warns about the afternoon peak.
- *SMS deliberately not claimed:* SNS SMS needs registered origination numbers in many countries
  (weeks of paperwork). Email alerts are real; SMS is documented as the next channel.
- *Second-opinion review:* the global workflow calls for a Codex (GPT) review of new modules.
  The Codex MCP call returned "You've hit your usage limit … try again at Oct 14th, 2026", so
  this session's review was done by re-reading the code and by the tests + browser checks above.

**What was left at the end of the local phase** (all but the email proof done in session 2 below)
- Finish AWS sign-in + Agent Toolkit setup and paste the real connection proof above.
- Confirm Bedrock model access and the exact inference-profile IDs from `aws bedrock` output.
- First `sam deploy`, seed the read-only demo group, trigger one real alert email.
- README with live URL, architecture diagram, demo video.

---

### 2026-09-28 — Session 2: connected to AWS, first deploy, verified live

**Bedrock reality check before deploying (real CLI output, not assumptions).** The first call to
Claude on the brand-new account failed; Amazon Nova worked:
```
2026-09-28T18:15:14Z  $ aws bedrock-runtime converse --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 ...
AccessDeniedException: Your account is currently being verified. Verification normally takes less than 2 hours.

$ aws bedrock-runtime converse --model-id us.amazon.nova-2-lite-v1:0 ...  (the real production prompt, Arabic, live Dubai data)
stopReason: end_turn | usage: {"inputTokens":844,"outputTokens":152,"totalTokens":996} | latencyMs: 1375
--- VALIDATION: PASS (JSON shape + Arabic script) ---
```
Decision: ship with Claude Haiku 4.5 as primary and Nova 2 Lite as automatic fallback, so the
app works immediately and upgrades itself when Claude access arrives.

**First deploy** (`node scripts/deploy.mjs`: tests → `sam validate --lint` → `sam build` →
`sam deploy` → S3 sync → CloudFront invalidation → smoke test on the public URL):
```
Successfully created/updated stack - heatshield in us-east-1
Smoke test
  https://d3tda9dyutl7ux.cloudfront.net/            -> 200
  https://d3tda9dyutl7ux.cloudfront.net/api/health  -> {"ok":true,"service":"heatshield-api","version":"0f237b7","region":"us-east-1","time":"2026-09-28T18:23:09.462Z"}
Live: https://d3tda9dyutl7ux.cloudfront.net   (version 0f237b7)
```
36 resources created (3 Lambda functions + roles, HTTP API + stage, 4 DynamoDB tables, SNS topic,
EventBridge schedule, S3 bucket + policy, CloudFront distribution + OAC + response-headers policy,
log groups).

**What the Lambda logs showed about Bedrock (CloudWatch Logs, `bedrock_guidance_*` events):**
```
{"msg":"bedrock_guidance_generated","modelId":"us.anthropic.claude-haiku-4-5-20251001-v1:0","language":"es","latencyMs":3354,"inputTokens":931,"outputTokens":270}
{"msg":"bedrock_guidance_failed","modelId":"us.anthropic.claude-haiku-4-5-20251001-v1:0","error":"ResourceNotFoundException","message":"Model use case details have not been submitted for this account. ..."}
{"msg":"bedrock_guidance_generated","modelId":"us.amazon.nova-2-lite-v1:0","language":"ar","latencyMs":1202,"inputTokens":844,"outputTokens":133}
{"msg":"bedrock_guidance_failed","modelId":"us.amazon.nova-2-lite-v1:0","error":"Error","message":"Model output was truncated"}
```
So: one Claude call succeeded, then Anthropic's one-time *use-case form* became the blocker
(an account-owner action). Nova served Arabic and Bengali; a Swahili request hit Nova's token
limit, failed validation, and the user got the hand-written fallback — the safety net worked as
designed, visibly labelled "Pre-written safety guidance".

**Multilingual quality, checked by reading the output (not just by the validator).** Same live
Dubai scenario on Nova 2 Lite, all five passed the automated JSON + script checks:
```
[es] PASS 1120ms | El calor es peligroso ahora y hasta la madrugada.
[hi] PASS 1180ms | अब बहुत ज़्यादा गर्मी का ख़तरा है, ध्यान रखें।
[bn] PASS 1583ms | আজ রাতের মধ্যে জরার ঝুঁকি খুব বেশি।
[sw] PASS 1708ms | Hatari kubwa ya joto leo usiku na kesho
[zh] PASS 1653ms | 现在和今晚要非常小心高温。
```
Reading them: Spanish, Hindi and Chinese are correct. The Bengali headline uses জরা ("old age")
where it means heat, and a later Bengali reply had non-words; the Swahili actions were partly
ungrammatical. Lesson recorded in the README's limitations: a script check proves the *language*,
not the *meaning*; lower-resource languages need a fluent reviewer, and Claude should be primary.

**Live end-to-end test in a real browser** (headless Chrome against the CloudFront URL): home →
Dubai/Arabic result (risk 927 ms, guidance 962 ms from cache, `dir=rtl lang=ar`) → create group →
join via invite → leader dashboard → read-only demo dashboard (10 rows, 0 remove buttons) → personal
page → *delete my data* → dashboard empty again → mobile 390 px (0 px horizontal overflow).
`"errors": []` — no console errors, so the strict CSP breaks nothing.

**Live security checks:**
```
Content-Security-Policy: default-src 'self'; script-src 'self'; ... frame-ancestors 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: DENY / X-Content-Type-Options: nosniff / Referrer-Policy: strict-origin-when-cross-origin
direct S3 object access (must be 403): 403
http://… -> 301 Moved Permanently -> https://…
```

**Bugs found on the live site and fixed the same session**
1. *Ambiguous risky hours.* The live dashboard read "Risky 14:00–13:00" (meaning: now until
   13:00 tomorrow) and showed "Lower risk (next 12 h)" beside a window that was actually tomorrow.
   The risk engine now returns day offsets, a correct exclusive end, and a plain-English label
   ("now until 13:00 tomorrow", "10:00 tomorrow to 19:00", "all of the next 24 hours") used by the
   UI, dashboard, alert email and the Bedrock prompt (prompt v2). 2 regression tests added.
2. *A literal "null" under the action plan.* Native `Element.append(null)` renders the text
   "null". Fixed with a `fill()` helper; the live E2E test now fails if any page shows
   "null", "undefined" or "NaN".
3. *Abuse vector found in self-review:* `POST /api/locations` can make AWS send a confirmation
   email to any address typed in. Sign-up routes are now throttled to 1 req/s, burst 3
   (verified with `aws apigatewayv2 get-stage`). A per-IP AWS WAF rule is the production fix
   (~$6–7/month, not added without the owner's approval).

4. *IAM scope bug, found with CloudTrail.* After registering a real email, the personal page
   showed email status "unknown" instead of "pending". The code had swallowed the error, so
   Claude Code looked it up in CloudTrail instead of guessing:
   ```
   $ aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSubscriptionAttributes ...
   "errorCode": "AccessDenied",
   "errorMessage": "User: arn:aws:sts::6115****0540:assumed-role/heatshield-EnrollmentApiFunctionRole-…/heatshield-EnrollmentApiFunction-…
     is not authorized to perform: SNS:GetSubscriptionAttributes on resource:
     arn:aws:sns:us-east-1:6115****0540:heatshield-AlertsTopic-3ehD7DOOF0Rj because no identity-based policy allows ..."
   ```
   SNS authorizes subscription-level actions against the **topic** ARN; the policy had been scoped
   to `topic:*` (subscription ARNs). This had been flagged as an unverified AWS fact when the
   template was written, and it was caught on the live stack as planned. The same gap would have
   made *delete my data* fail to unsubscribe email users. Fix: both ARNs in the policy, and the
   error is now logged (`subscription_status_failed`). Verified after deploy `fbe3fa6`:
   `emailStatus: pending`.

**Scheduled alert loop, invoked manually:**
```
$ aws lambda invoke --function-name heatshield-AlertCheckFunction-… --payload '{}' out.json
{ "status": 200, "error": null }
{"checked":10,"sent":0,"dashboardOnly":1,"quiet":7,"belowThreshold":2,"alreadyAlerted":0,"errors":0}
```
(7 demo members were in local quiet hours, 2 below their threshold, 1 — Cuiabá at 14:30 local,
Danger — recorded for the dashboard; demo members have no email by design.)

**On a suggestion to rewrite the core in C++ for speed:** measured before deciding.
`assessRisk` (full 96-hour assessment) takes **14.4 µs**; one Open-Meteo call takes **587 ms**;
a Bedrock call 1–3 s. Compute is ~0.002 % of a request, so a C++ rewrite (custom Lambda runtime,
cross-compiling for arm64) would add ship-gate risk for no user-visible gain. Kept JavaScript.

**What's left (needs the account owner)**
- Submit Anthropic's one-time use-case form for Bedrock (console → Bedrock → Model catalog →
  Claude Haiku 4.5) so Claude becomes the primary model again.
- One real alert email: register an email, click "Confirm subscription", then invoke the alert
  Lambda with `{"forceLocationId": …}` and screenshot the inbox.
- Switch day-to-day CLI work from the root user to a least-privilege IAM identity.
- Publish the repo (GitHub), record the 2–3 minute demo video, tag `#social-good` + `#community`
  in Builder Center.

### 2026-09-28/29 — Session 3: six AI agents, and what their first live night exposed

**Goal:** make HeatShield run itself, with agents that each own a real job, as other entries in the
hackathon do, but with real algorithms under each one rather than a prompt with a persona.

**Built (commit `8606bf4`, 28 Sep 20:09 UTC):** an auditable Bedrock Converse tool-use loop
(`agent-runtime.mjs`: the model picks tools; the runtime enforces turns, deadline and output size;
every run is recorded to a new DynamoDB `AgentLog` table), then six agents:

| Agent | Algorithm (the exact part) | Model (the judgment part) |
|---|---|---|
| Sol, hourly | Excess Heat Factor (Nairn & Fawcett 2015, checked against the paper, PMC4306859) vs each city's 1991–2020 ERA5 climatology, NWS tiers, OLS trend | which areas get a watch/warning/emergency, capped by the algorithm's evidence ceiling |
| Mira | BM25 retrieval over a 21-fact vetted CDC/NIOSH/NWS library | the plan, in 13 languages |
| Lexi | multinomial naive-Bayes language ID (free, before any model call) | literal back-translation and review (Nova Pro) |
| Vera | detectors for phone numbers, medicines, doses | rubric review (Nova Pro) |
| Kai, 3-hourly | logistic urgency score + earliest-deadline-first scheduling across time zones | the wording of each check-in; names never reach the model |
| Otto, every 15 min | 5 probes, EWMA control charts, heartbeats, CloudWatch error counts | an incident report, only for a new incident |

**The first live night (28 Sep 20:31 → 29 Sep 10:30 UTC)**, read back from `AgentLog` and CloudWatch
through the AWS MCP server: 56 Otto runs, 15 Sol, 14 Dispatcher, 5 Kai, 2 each for Mira, Lexi and
Vera. It exposed six real problems, each fixed with a regression test named after the event
(commit `52dfae5`, `infra/tests/regressions.test.mjs`):
1. Sol failed once on malformed model JSON → one repair turn for every agent's structured output.
2. Lexi and Vera rejected correct drafts over style and over "a cup every 15 minutes" (the fact
   says 15–20) → issues carry a category and severity, and **code computes the verdict**.
3. The Dispatcher "emailed" an unconfirmed SNS subscription, which SNS silently drops → pending
   subscriptions are dashboard-only.
4. Otto missed guidance failures in the alert Lambda and blamed a latency blip on "resource
   contention" → it counts both functions and probes Open-Meteo separately (`upstream_slow`).
5. Sol lost areas to the Open-Meteo archive's rate limit on its first runs → at most 3 new 30-year
   climatologies per run; heat-index-only judgement meanwhile.
6. Kai counted empty test groups → skipped; `DELETE /api/groups/{id}` added.

Then (commit `acc9982`) visitors can run Sol and Otto on demand, behind a **global** per-agent
cooldown and route throttling, so spend is capped however many people click. Otto finds log groups
by stack prefix and gets the site URL from the schedule's `Input`, which avoids a CloudFormation
dependency cycle (the public API invokes Otto, and Otto watches the public API).

### 2026-09-29 — Session 4: Agent HQ, and a day of deploy → measure → fix

**Goal:** show the agents working (a pixel-art office, like the "AI agents in an office" videos),
and make everything they say correct. Thirteen commits, `18d21bb` (11:18 UTC) to `5df01e1`
(12:27 UTC), each deployed with `npm run deploy` and checked live before the next.

**Agent HQ** (`/agents.html`): a 320×192 office drawn in code (no image assets) with crisp HTML
overlays, driven by `GET /api/agents` every 20 s. Status lamps, a wall map of Sol's cities and heat
events, speech from each agent's last real run (with its age once it is older than 30 minutes),
the activity feed, an agent panel, and buttons that run real agents. Headless-Chrome screenshots
caught three layout bugs before users did: speech bubbles covering name plates, an empty wall map
(the stored state predated city coordinates; events now plot as a fallback), and a CSS rule
(`.section { padding: 40px 0 }`) that silently removed the 16 px side gutter on phones on five pages.

**What reading the live output taught us.** Every item below was found by deploying, running the
agent, and reading its output back through the AWS MCP server (DynamoDB `GetItem`/`Query` on
`AgentLog`, CloudWatch `FilterLogEvents`, Lambda `Invoke`), then checking it against the forecast.

- *Open-Meteo refused 2 of Sol's 10 cities.* Sol's stored state, read through the MCP server:
  ```
  "failures": [{"place": "Manila, Philippines", "stage": "forecast", "message": "Open-Meteo HTTP 429"},
               {"place": "Lagos, Nigeria", "stage": "forecast", "message": "Open-Meteo HTTP 429"}]
  ```
  Open-Meteo limits per IP, and Lambda shares outbound IPs. The weather client now retries a 429
  once; Sol retries refused cities after a pause; a city still refused keeps its last good data for
  up to 3 hours, marked stale. The board count had been flapping (10 → 9 → 10 → 8).
- *A rule that could never fire.* Sol's "re-brief at least every 6 hours" compared against
  `updatedAt`, which every "unchanged" re-check refreshed. It now uses `briefedAt`. The regression
  test fails on the old code (verified by reverting the line).
- *Trends and wording.* After a forced re-brief, Dubai, Cuiabá and Dhaka were all "new" although
  they were in the previous briefing, and the text said "danger-tier heat indices". Trends are now
  arithmetic (level vs the previous briefing). A plain-language rewrite then produced
  "Cuiabá keeps unusually hot for this place and time of year": the prompt had offered phrase
  substitutions and the model applied them literally, then copied its own awkward text from the
  previous briefing. The prompt now describes intent with full-sentence examples, and the model sees
  only the previous levels, not the prose.
- *A factual error in a headline.* The model wrote "dangerous heat in Cuiabá on Wednesday and
  Thursday"; `/api/risk` showed Thursday one tier lower:
  ```
  Cuiaba Tue 09-29 extreme_caution 39.4 | Wed 09-30 danger 41.1 | Thu 10-01 extreme_caution 36.3 | Fri 10-02 extreme_caution 32.6
  ```
  Event headlines are now written by code from the tiers, with weekday names computed from the dates
  ("Cuiabá: dangerous heat and humidity on Wednesday; hotter than usual for this time of year on
  Tuesday"). The model still chooses levels and writes the briefing paragraph.
- *Otto's diagnosis.* Every uncached plan tries Claude Haiku first. CloudWatch, through the MCP server:
  ```
  {"level":"warn","msg":"bedrock_guidance_failed","modelId":"us.anthropic.claude-haiku-4-5-20251001-v1:0",
   "error":"ResourceNotFoundException","message":"Model use case details have not been submitted for this account. ..."}
  ```
  Otto marked the site "degraded" and guessed "transient primary model unavailability". It now
  samples the actual error lines: access/setup errors become an info note with the real reason, and
  the site stays healthy; other failures still degrade.

**The reviewers, measured.** The Dubai/Arabic featured example fell back to pre-written English
advice in the end-to-end test. The agent log showed why: 22 of Lexi's 24 blocking objections were
"fact" (a headline about today's peak read as a claim about the risk right now), and Vera objected
that "sunscreen and a head covering may raise body temperature". `scripts/eval-guidance.mjs` asks
the live API for one plan per language and reports each plan's review rounds. Calibration, one
deploy per step:

| Step | Change | New plans | Published |
|---|---|---|---|
| baseline (11:35–11:43 window) | — | 5 | 1 |
| 1 | Lexi judges language (fact notes optional); Vera told vetted advice is never a violation | 15 | 12 |
| 2 | writer resamples runaway replies (a Swahili reply hit the 1000-token limit); style vs omission defined | 16 | 10 |
| 3 | Vera judges against the whole library (with only the retrieved subset she called "a cup every 15 minutes" overhydration); tolerant JSON (Chinese: raw newline, trailing comma); Nova Pro writes as a last resort | 19 | 10 |
| 4 | code keeps wording complaints and omissions as notes; real errors still block (tested with the exact objections from steps 1–3) | 22 + 13 | 20 + 12 |
| 5 | a harm objection must survive a second reading that points at words really in the message (Vera had blocked "a fan as the main cooling" while quoting a sentence about clothing) | 13 + 4 featured | 12 + 3 |

After steps 4–5: **47 of 52 new plans published (90%)**, and each of the 5 rejections contained a
real error: invented Swahili words (three times; "kichocho" means bilharzia, not dizzy), "barafu"
(ice) where "baridi" (cool) was meant, "गड़गड़ाहट" (thunder) where "confusion" was meant among the
Hindi heat-stroke signs, and a wrong decimal separator in Vietnamese. Measured Bedrock cost that
day (~90 new plans plus all background agents): about US$0.72; about US$0.01 per new plan.

**Other fixes from reading the product as a judge would:**
- The leader dashboard never showed Kai's plan, although the API returned it and Agent HQ said
  plans "live on each leader's private dashboard". It now has "Who to check on first".
- Kai sorted on the rounded urgency (everyone 0.98), so ties fell back to input order.
- Leaders can delete their group from the dashboard (the endpoint existed; the UI did not).
- The page said "AI guidance is temporarily unavailable" when reviewers had rejected a draft; the
  API already returned the reason.
- "Revised a English plan" → "an English plan".

**Testing.** 100 unit and regression tests. `scripts/e2e/live-flow.cjs` and
`scripts/e2e/agent-hq.cjs` (headless Chrome, production) pass: risk → plan → group → join →
dashboards with Kai's plan → delete my data → delete group → phone layout; every Agent HQ button
(200, or 429 from a shared cooldown). Codex was unavailable this session (usage limit), so the second
opinion on each change came from live measurement and from re-reading the diff adversarially.

**Still open (needs the account owner):** the Anthropic use-case form (Claude becomes primary on
its own afterwards); a confirmed email subscription for the alert proof; moving CLI work off the
root user; publishing the repo; the demo video; Builder Center tags. And a decision: pre-written
fallback advice exists in English, Spanish and French only (other languages fall back to English
with a notice). Machine translations checked by the review agents would close that gap, but no
native speaker would have checked them.
