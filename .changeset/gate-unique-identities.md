---
"@infracraft/gate": minor
---

Unique identities: a provider account can no longer appear twice in gate's store. Existing duplicates trigger a mandatory merge prompt (pick the surviving label); `login` and `import` now offer update-or-rename when the identity is already stored.
