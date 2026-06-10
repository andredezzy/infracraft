---
"@infracraft/gate": minor
---

Deploy-target preflight: `gate vercel deploy --project <name>` now verifies the project exists before spawning the native CLI. A missing project triggers a create prompt — or is auto-created with the new gate-owned `--create-project` flag — and the deploy continues in the same run; non-interactive misses fail fast with an actionable hint instead of relaying the native error.
