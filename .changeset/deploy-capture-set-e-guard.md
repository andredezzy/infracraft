---
"@infracraft/pulumi": patch
---

Fix: a failed `railway up` no longer dies silently. The deploy script runs under `set -e`, and the bare `IC_UP_OUT=$(railway up …); IC_UP_EXIT=$?` capture died AT THE ASSIGNMENT on a non-zero exit — before the exit code was saved and before the output was re-emitted, leaving zero diagnostics (live production incident). The capture is now if/else-guarded so the CLI's real output always surfaces and the monitor still owns pass/fail.
