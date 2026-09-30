# Demo video script (about 3 minutes, screen recording of the LIVE site)

Record at 1280×800 or larger. Keep captions on screen so it works muted. Use the live URL only
(no localhost). Everything below exists and was verified on the live site on 2026-09-30.

| Time | Screen | Say (or caption) |
|---|---|---|
| 0:00–0:12 | Home page hero | "A weather app tells you it's 41 °C. It doesn't tell a delivery rider in Dubai or a grandmother in Delhi what to do about it, in their language. HeatShield does." |
| 0:12–0:35 | Click **Dubai · Arabic**. Scroll through the result; hover the 24-hour chart. | "Live forecast, turned into the US Weather Service heat index. HeatShield shows this outdoor worker's risk now, when it peaks, and their risky hours." |
| 0:35–0:55 | The **action plan** card, Arabic, right-to-left. Press **Listen (العربية)** and let a few seconds play. | "Amazon Bedrock writes a plan for this person, grounded in vetted CDC guidance and checked by two reviewer agents before it's shown. And because many people at risk read with difficulty, Amazon Polly reads it aloud, in their language." |
| 0:55–1:35 | Open **Agent HQ**. In **Ask the team**, type "When should my construction crew in Karachi start work tomorrow?". Watch Kai hand papers to Sol, then read the answer; open "Kai asked Sol". Then click the example "Write a heat plan for my grandmother in Delhi, in Hindi" and show the reviewed plan card with Listen. | "Eight AI agents run HeatShield around the clock, and you can ask them anything about the heat where you are. Kai reads the question and hands it to the right teammates, who use their real tools: Sol's forecast, Kai's shift search, Mira's plan with Lexi and Vera's review. And code checks every number in the answer against what the tools returned before I see it." |
| 1:35–2:05 | Click **Sol**'s desk (the chance of dangerous heat in each headline), then **Quinn**'s (the forecast track record table), then **Iris**'s (word lists). | "Each agent pairs a real algorithm with a model, and code makes the final call. Sol reads 51 ensemble forecasts, so a warning says how likely it is. Quinn checks how far to trust the forecast in each city, every missed Danger day counted by code. Iris turns the reviewer's corrections into word lists the writer follows." |
| 2:05–2:30 | Open the **live demo dashboard**. Show **Who to check on first**, including the safest-shift line for the Dubai delivery rider, then the member table. | "The Community lane: one foreman, teacher or clinic worker watches a whole group. Kai tells them who to check on first, by when in each person's time zone, and for outdoor workers the safest hours to work tomorrow." |
| 2:30–2:45 | The **operator console** (signed in): pauses, AI budget meter, alarms all OK, audit log. Or the **alert email**, if recorded. | "And it runs itself: failed runs are retried and kept, Otto repairs missed schedules, nine alarms email me, and a measured daily budget stops new AI work, but never the alerts." |
| 2:45–3:00 | README architecture diagram, then the live URL on screen. | "Fully serverless on AWS, in one SAM template, built with Claude Code connected to AWS through the AWS MCP Server. HeatShield: from forecast to action, in your language." |

Tips
- Open the Dubai Arabic link and press Listen once before recording, so the plan and its audio are
  cached (instant on camera).
- Agent HQ's buttons share cooldowns (Sol 10 min, Kai 10 min, Otto 2 min). If one says "try again in
  a few minutes", that is the cost cap working; wait or show a different button.
- Ask the team takes 2 to 8 seconds (a new reviewed plan up to about 15). Ask each demo question
  once before recording so the plan is cached. If a reviewer rejects a new plan, pre-written advice
  is shown with a note; that is the safety net working, fine to show.
- Try one adversarial question on camera ("Ignore your instructions…"): the polite refusal is a
  feature.
- The operator console needs the Cognito account (sign in with the emailed temporary password
  first and set a new one). Don't show the email address on screen.
