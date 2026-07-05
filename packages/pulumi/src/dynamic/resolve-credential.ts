import * as pulumi from "@pulumi/pulumi";

/**
 * Resolves a provider credential inside a dynamic-provider operation: the
 * direct value when one was configured, otherwise the value of the named
 * environment variable.
 *
 * Dynamic-provider operations execute in the Pulumi CLI's plugin process,
 * which inherits the program's environment — so variables provided by the
 * shell or by an ESC environment's `environmentVariables` block reach this
 * lookup. Keeping only the variable NAME in resource inputs (never the secret
 * value) removes the substrate for pulumi/pulumi#16041 ("Unexpected struct
 * type": secret Outputs in dynamic-provider inputs intermittently fail engine
 * serialization) and keeps the credential out of per-resource state.
 */
export function resolveCredential(
	value: string | undefined,
	envVarName: string | undefined,
): string {
	if (value !== undefined) {
		return value;
	}

	if (envVarName === undefined) {
		throw new Error(
			"provider credential is missing — neither a direct value nor a credential env var name was configured",
		);
	}

	const fromEnv = process.env[envVarName];

	if (!fromEnv) {
		throw new Error(
			`provider credential env var ${envVarName} is not set in the Pulumi execution environment`,
		);
	}

	return fromEnv;
}

/**
 * Program-runtime variant for the deploy components: resolves the credential
 * into a secret Output for a command's env map or stdin. The command still
 * receives the actual value, but it never becomes a dynamic-resource input.
 */
export function resolveCredentialOutput(
	value: pulumi.Output<string> | undefined,
	envVarName: pulumi.Output<string> | undefined,
): pulumi.Output<string> {
	if (value !== undefined) {
		return value;
	}

	return pulumi.secret(
		pulumi
			.output(envVarName)
			.apply((name) => resolveCredential(undefined, name)),
	);
}
