# @infracraft/pulumi

## 1.22.0

### Minor Changes

- d910e03: Security: RailwayDeploy no longer embeds the project token in the deploy command script. pulumi-command includes the executed command verbatim in its failure error, and Pulumi does not scrub secrets from provider diagnostics — so an inlined token printed in plaintext whenever a deploy failed. The token now travels via the command's stdin (`createDeployCommand` gained an optional `stdin` input), which stays out of the script text and remains secret-masked in diffs. Tokens minted before this fix that ever hit a failed deploy should be treated as compromised and rotated.

## 1.21.0

### Minor Changes

- 4b0fa67: RailwayDomain: expose ownership-verification TXT record (verificationTxtName/verificationTxtValue)

## 1.20.0

### Minor Changes

- 0c1e4ba: VercelDomain: dynamic cnameTarget from Vercel domain config (replaces static VERCEL_CNAME_TARGET export)

## 1.19.0

### Minor Changes

- 6809748: RailwayDomain: expose `cnameTarget` (the DNS record to point a custom domain's CNAME at, extracted from Railway's traffic-routing DNS record) — verified multi-domain-safe, since adoption/deletion already scope by exact domain name and domainId respectively.

## 1.18.0

### Minor Changes

- dcb7e4b: Add VercelDomain — attach a custom domain to a Vercel project (adopt-or-create)

### Patch Changes

- dcb7e4b: RailwayService: scope serviceCreate to the target environment (environmentId was omitted, first deploy landed in the default environment)

## 1.17.4

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.

## 1.17.3

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.

## 1.17.2

### Patch Changes

- 00b9131: Sandbox internals moved to `@infracraft/sandbox` and re-exported unchanged from `@infracraft/pulumi/sandbox` — no API change.
