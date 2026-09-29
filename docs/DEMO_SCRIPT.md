# Demo video script (about 3 minutes, screen recording of the LIVE site)

Record at 1280×800 or larger. Keep captions on screen so it works muted. Use the live URL only
(no localhost). Everything below exists and was verified on the live site on 2026-09-29.

| Time | Screen | Say (or caption) |
|---|---|---|
| 0:00–0:12 | Home page hero | "A weather app tells you it's 41 °C. It doesn't tell a delivery rider in Dubai or a grandmother in Delhi what to do about it, in their language. HeatShield does." |
| 0:12–0:40 | Click **Dubai · Arabic**. Scroll through the result; hover the 24-hour chart. | "Live forecast, turned into the US Weather Service heat index. HeatShield shows this outdoor worker's risk now, when it peaks, and their risky hours." |
| 0:40–1:00 | The **Your action plan** card, Arabic, right-to-left. Point at the provenance line. | "Amazon Bedrock writes a plan for this person: three steps with clock times and the warning signs, grounded in vetted CDC guidance, and checked by two reviewer agents before it's shown." |
| 1:00–1:45 | Open **Agent HQ**. Let the office run for a few seconds, then press **Give the team a task**. Watch the papers go to Lexi and Vera and the verdict bubbles appear; scroll to the result card and open Lexi's back-translation. | "Six AI agents run HeatShield around the clock, and this office is drawn from their real runs. Sol watches ten cities for heatwaves against each city's own climate; the dots on the wall are his heat events. When I give the team a task, Mira writes the plan, Lexi checks the language, Vera checks the safety, and anything they block goes back for a rewrite." |
| 1:45–2:10 | Click **Sol**'s desk (panel: algorithm, briefing, events), then **Otto**'s (probes, moving averages). | "Each agent pairs a real algorithm with a model: the Excess Heat Factor for Sol, control charts for Otto. Code, not the model, makes the final call." |
| 2:10–2:35 | Open the **live demo dashboard**. Show **Who to check on first**, then the member table. | "The Community lane: one foreman, teacher or clinic worker watches a whole group. Kai, the coordinator agent, tells them who to check on first, by when in each person's time zone, and what to ask." |
| 2:35–2:45 | The **alert email** in the inbox (from the manual trigger), if recorded. | "And nobody has to remember to check: every hour EventBridge re-scores everyone and Amazon SNS emails people whose risk reaches their level." |
| 2:45–3:00 | README architecture diagram, then the live URL on screen. | "Fully serverless on AWS: Bedrock, Lambda, DynamoDB, EventBridge, SNS, CloudFront, in one SAM template, built with Claude Code connected to AWS through the AWS MCP Server. HeatShield: from forecast to action, in your language." |

Tips
- Open the Dubai link once before recording so the plan is cached (instant on camera).
- Agent HQ's buttons share cooldowns (Sol 10 min, Kai 10 min, Otto 2 min). If one says "try again in
  a few minutes", that is the cost cap working; wait or show a different button.
- "Give the team a task" picks a random place, profile and language. If the reviewers reject a
  draft, the result says so and shows pre-written advice; that is the safety net working, fine to
  show, or press the button again for another task.
