---
"@infracraft/pulumi": minor
---

Adopt the official-provider namespace pattern: every platform-prefixed export loses its prefix inside its own module, so consumers write `import * as railway from "@infracraft/pulumi/railway"` and `new railway.Project(...)` — matching how `@pulumiverse/*` and `@pulumi/*` providers read. Applies to all four modules (`railway`, `neon`, `vercel`, `fly`), including `*Args` types and enums (`railway.Builder`, `fly.IpType`, …). Pulumi type tokens are untouched, so existing stack state is unaffected.

Migrate by switching each named import to a namespace import and dropping the prefix at use sites: `import { RailwayProject } from "@infracraft/pulumi/railway"` + `new RailwayProject(...)` → `import * as railway from "@infracraft/pulumi/railway"` + `new railway.Project(...)`. When `@pulumiverse/vercel` is imported as `vercel` in the same file, alias this package's module (e.g. `import * as infravercel from "@infracraft/pulumi/vercel"`).
