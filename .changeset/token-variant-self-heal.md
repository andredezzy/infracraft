---
"@infracraft/gate": minor
---

Self-healing sessions: when the native CLI holds a valid session for an identity gate already stores (a re-login or auto-refreshed token), the stored entries silently adopt the fresh session. The active marker now compares tokens per entry, so duplicate-identity entries all show as active when they hold the live session.
