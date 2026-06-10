---
"@infracraft/gate": minor
---

Refresh-aware discovery: an expired-but-refreshable native session (Vercel) is now silently refreshed during discovery and `import` instead of classifying as invalid, so a stale `auth.json` no longer hides the import offer. The refreshed tokens are written back to the native auth file immediately (OAuth refresh rotates the refresh token), which also revives the native CLI session.
