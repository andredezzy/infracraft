---
"@infracraft/pulumi": patch
---

Fix the deterministic "Unexpected struct type" on VercelVariable: its undefined output placeholders (envIds, contentHash) next to an Output-valued variables map failed engine serialization on every create/update. The placeholders are gone — both values are state-only bookkeeping nothing consumed as Outputs (the unused contentHash output was removed from the component).
