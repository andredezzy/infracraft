---
"@infracraft/pulumi": minor
---

railway.Deploy: recover deployments Railway wedges in `INITIALIZING`. When a deployment stays in `INITIALIZING` past a threshold (default 5 min) without reaching `BUILDING`, the monitor redeploys from the same source onto a fresh build slot, cancels the wedged deployment, and watches the new one — the recovery an operator would do by hand. Bounded by `maxRedeploys` (default 1) so a genuinely broken deploy still fails fast.
