---
"@infracraft/pulumi": major
---

BREAKING: `VercelVariable` is removed. As a dynamic resource it hit a Pulumi engine-internal stateful bug on clean-slate first creates ("Unexpected struct type", strictly alternating pass/fail across identical from-zero runs, reproduced with plain-literal inputs on matched CLI/SDK versions — four structural theories falsified by bisection). Its replacement is `VercelDeploy.variables` (deploy-integrated application via the shared env-var REST logic). The official resource-shaped modeling — like the bridged Vercel provider's `ProjectEnvironmentVariable(s)` — returns with the native-provider graduation, on a substrate that can carry it.
