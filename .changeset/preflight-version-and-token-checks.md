---
"@infracraft/pulumi": minor
---

Add two opt-in preflight guards under the new `@infracraft/pulumi/preflight` subpath, each catching a class of failure this session hit at apply time:

- `assertPulumiVersionMatch(options?)` — compares the running Pulumi CLI version against the installed `@pulumi/pulumi` Node SDK version and throws (default) or warns on a major.minor skew. The Go engine (CLI) and the Node serializer (SDK) must agree on the wire format; a skew caused intermittent "Unexpected struct type" marshal failures on dynamic resources. Best-effort: warns and skips when the SDK cannot be resolved from the program's working directory. Accepts `mode: "throw" | "warn"` and injectable `readCliVersion` / `readSdkVersion` readers for testing.
- `assertCloudflareTokenScopes(options)` — verifies a Cloudflare API token is valid and active via `GET /user/tokens/verify` (through the shared resilient transport) before a run relies on it, turning a mid-`up` 403 (a DNS-only token that silently lacked `Zone Settings:Edit`) into a plan-time error. Limitation: the verify endpoint returns only `{ id, status }`, not per-permission-group grants — so the check enforces active-status only, and `requiredPermissionGroups` is echoed as a manual-confirmation reminder rather than enforced (documented in JSDoc; it never claims to verify a scope it cannot).

Both are opt-in top-of-program guards — neither is invoked automatically by any deploy path. Documented alongside `assertHostBinaries` in the new README "Preflight checks" section.
