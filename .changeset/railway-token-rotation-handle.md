---
"@infracraft/pulumi": minor
---

RailwayProjectToken gains a `tokenVersion` rotation handle: bump it and the next `up` mints a fresh token BEFORE revoking the old one (create-before-delete for rotations; identity changes keep delete-first). No more target-replace URN archaeology — the parent ComponentResource has no diffable state of its own, so targeting it was a silent no-op.
