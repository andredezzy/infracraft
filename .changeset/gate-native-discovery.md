---
"@infracraft/gate": minor
---

Native-session discovery: interactive commands now notice when the native CLI is logged into an account gate doesn't know and offer to import it. Declining is remembered per identity (`gate <provider> import` always works manually and un-declines). The empty-store error now mentions `import` alongside `login`.
