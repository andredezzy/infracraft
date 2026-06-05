import * as pulumi from "@pulumi/pulumi";

/** Cross-bundle brand (see DeploySandbox for why `instanceof` is avoided). */
const GIT_GUARD_BRAND = Symbol.for("@infracraft/pulumi/GitGuard");

/**
 * Metadata-protection marker. Listing it in a deploy's `dependsOn` (alongside a
 * `DeploySandbox`) makes that deploy's sandbox `.git` a metadata-free stub
 * (`git init` + `git add -A`, unborn HEAD) instead of the real history — so no
 * commit SHA or author email is sent to the platform. Has no effect without a
 * `DeploySandbox` (the seam throws if used alone). Carries no required config.
 */
export class GitGuard extends pulumi.ComponentResource {
	constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
		super("infracraft:git:GitGuard", name, {}, opts);

		(this as Record<symbol, unknown>)[GIT_GUARD_BRAND] = true;

		this.registerOutputs({});
	}
}

/** Bundle-safe check for a `GitGuard` in a `dependsOn` array. */
export function isGitGuard(value: unknown): value is GitGuard {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[GIT_GUARD_BRAND] === true
	);
}
