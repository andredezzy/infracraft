---
"@infracraft/gate": minor
---

`--project <name>` now works on EVERY vercel command through the passthrough: `gate vercel env ls --project hat-rec` resolves the project via the API and injects `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID` (the CLI's official link substitute) — no `.vercel` link needed, team projects included. Resolution failures abort the command (never silently falls back to the linked project). Gate's deploy verb keeps forwarding `--project` natively with its create-preflight.
