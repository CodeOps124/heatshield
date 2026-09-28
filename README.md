# HeatShield

A free, multilingual heat-risk early-warning and action-guidance platform for people who don't
get told, in their own language, what dangerous heat means for them specifically — outdoor
workers, elderly residents, and anyone without reliable AC, anywhere in the world.

> **This README is a starter — fill in the live URL, demo video, and real screenshots as the
> project progresses.** See `CLAUDE.md` for the full project brief and `PLAN.md` for the build
> order. Do not submit with placeholder text still in this file.

## The problem
Generic weather apps report a temperature. They don't tell an elderly person living alone, or an
outdoor construction crew, what to actually *do* in the next few hours — in their own language, at
a reading level that doesn't require a medical dictionary.

## The idea
Register a location and a risk profile (outdoor worker / elderly / chronic condition / child /
general). HeatShield computes a real, humidity-adjusted heat-risk score, uses Amazon Bedrock to
turn it into a short, specific, localized action paragraph, and sends an alert automatically when
risk crosses a threshold for that profile — so people don't have to remember to check. Community
leaders (a foreman, a teacher) can watch a whole group at a glance.

## Live app
`<PUBLIC URL — fill in once deployed>`

## Category & lane
`#social-good` (Climate resilience) · `#community`

## Architecture
```
Browser
  │
CloudFront + S3  (frontend)
  │
API Gateway (HTTP API)
  │
Lambda ── DynamoDB (Locations, Alerts)
  │
  ├── Open-Meteo (weather data)
  ├── Amazon Bedrock (localized guidance generation)
  └── EventBridge Scheduler → Lambda → Amazon SNS (proactive alerts)
```
`<Replace with a real diagram image once the build stabilizes — see .claude/skills/submission-storytelling/SKILL.md>`

## AWS services used
- **Amazon Bedrock** — generates short, specific, profile- and language-specific action guidance
  from structured risk data (not a static FAQ).
- **AWS Lambda + API Gateway** — serverless API, no servers to manage.
- **Amazon DynamoDB** — locations, risk profiles, alert history, guidance cache.
- **Amazon S3 + CloudFront** — static frontend, public HTTPS URL.
- **Amazon EventBridge Scheduler + Amazon SNS** — periodic risk re-checks and proactive SMS/email alerts.
- **AWS SAM** — infrastructure as code for the whole stack.

## How the coding agent helped ship this
`<Pull 3-5 concrete examples from docs/BUILD_LOG.md — see .claude/skills/submission-storytelling/SKILL.md>`

## Demo
`<Link the 2-3 minute demo video/GIF once recorded>`

## Development
See `CLAUDE.md` (project brief) and `PLAN.md` (build plan) for how this was built, and
`.claude/skills/` for the specific playbooks Claude Code followed for each part of the system.

## License
`<pick one, e.g. MIT>`
