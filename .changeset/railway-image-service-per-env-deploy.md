---
"@infracraft/pulumi": minor
---

RailwayService now converges image-sourced services in ANY environment. Railway configures `ServiceCreateInput.source` only on the default environment's instance; instances in other environments were born with `source: null`, deploy triggers no-op'd silently (`environmentTriggersDeploy` returns success without creating anything for a never-deployed service), and the service's private DNS never registered. The provider now applies `source` per target-environment instance via `serviceInstanceUpdate` and owns the deploy for image services (`serviceInstanceDeployV2`) on both create and update — code-sourced services are untouched (RailwayDeploy remains their deploy path). `startCommand` remains a regular `Input<string>`, so secret-bearing commands (e.g. `redis-server --requirepass …`) belong here rather than in raw command wrappers.
