---
"@infracraft/pulumi": minor
---

CRITICAL: RailwayVolume adoption is now environment-scoped. Volume lookup matched by serviceId alone, and services are project-level — so a new stack adopted a SIBLING environment's volume (production adopted staging's, risking data mixing or running without persistence). A volume instance must now match BOTH serviceId and environmentId; a stack whose environment has no instance creates its own volume and triggers the attach deploy.
