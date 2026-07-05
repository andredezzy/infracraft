---
"@infracraft/pulumi": minor
---

NeonRole gains in-place password rotation: bump the new `passwordVersion` input and the next `up` resets the role's password via Neon's reset_password endpoint as an UPDATE — never a replace, which would try to delete the role (Neon refuses for default roles, and it would drop grants for others). Everything consuming `password` (connection strings, env vars, dependent redeploys) cascades automatically.
