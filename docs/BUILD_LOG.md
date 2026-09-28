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
(Filled in during Phase 0 — see .claude/skills/aws-connect-proof/SKILL.md. Section below is
updated with real output as soon as the connection is live.)

- `aws sts get-caller-identity` output:
  ```
  <pending: captured right after `aws login` completes>
  ```
- MCP connection status (`/mcp` or equivalent):
  ```
  <pending>
  ```
- First real tool call + output:
  ```
  <pending>
  ```

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

**What's left**
- Finish AWS sign-in + Agent Toolkit setup and paste the real connection proof above.
- Confirm Bedrock model access and the exact inference-profile IDs from `aws bedrock` output.
- First `sam deploy`, seed the read-only demo group, trigger one real alert email.
- README with live URL, architecture diagram, demo video.
