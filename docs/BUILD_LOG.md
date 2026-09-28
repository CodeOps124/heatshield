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
(Fill this in during Phase 0 — see .claude/skills/aws-connect-proof/SKILL.md)

- `aws sts get-caller-identity` output:
  ```
  <paste here>
  ```
- MCP connection status (`/mcp` or equivalent):
  ```
  <paste here>
  ```
- First real tool call + output:
  ```
  <paste here>
  ```

---

### YYYY-MM-DD — Project kickoff
- Chose HeatShield: multilingual heat-risk early warning + action guidance for underserved
  populations, Social Good category, Community lane.
- Scaffolded CLAUDE.md, PLAN.md, and project skills with Claude Code.
- Next: Phase 0 (AWS connection proof) and Phase 1 (skeleton deploy).
