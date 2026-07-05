---
"@infracraft/pulumi": minor
---

Security: RailwayDeploy no longer embeds the project token in the deploy command script. pulumi-command includes the executed command verbatim in its failure error, and Pulumi does not scrub secrets from provider diagnostics — so an inlined token printed in plaintext whenever a deploy failed. The token now travels via the command's stdin (`createDeployCommand` gained an optional `stdin` input), which stays out of the script text and remains secret-masked in diffs. Tokens minted before this fix that ever hit a failed deploy should be treated as compromised and rotated.
