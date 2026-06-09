import { prepareSandboxWorkspace } from "@infracraft/sandbox";
import * as pulumi from "@pulumi/pulumi";

export type { SandboxScriptOptions } from "@infracraft/sandbox";
export {
	buildSandboxFileFilter,
	buildSandboxScript,
	SandboxMode,
} from "@infracraft/sandbox";

/** Cross-bundle brand: `instanceof` is unreliable when the seam and the resource
 * come from different built entries, so the seam detects sandboxes by this. */
const DEPLOY_SANDBOX_BRAND = Symbol.for("@infracraft/pulumi/DeploySandbox");

/**
 * Isolation marker + workspace lifecycle. Listing it in a deploy's `dependsOn`
 * makes that deploy run in an isolated `/tmp/infracraft` copy. Carries no config;
 * the repo root is derived at runtime by the deploy command.
 */
export class DeploySandbox extends pulumi.ComponentResource {
	constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
		super("infracraft:sandbox:DeploySandbox", name, {}, opts);

		(this as Record<symbol, unknown>)[DEPLOY_SANDBOX_BRAND] = true;

		if (!pulumi.runtime.isDryRun()) {
			prepareSandboxWorkspace();
		}

		this.registerOutputs({});
	}
}

/** Bundle-safe check for a `DeploySandbox` in a `dependsOn` array. */
export function isDeploySandbox(value: unknown): value is DeploySandbox {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[DEPLOY_SANDBOX_BRAND] === true
	);
}
