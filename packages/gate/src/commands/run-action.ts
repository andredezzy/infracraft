import * as p from "@clack/prompts";

/**
 * Runs a command action, rendering a thrown Error as a clean CLI error line
 * instead of a raw stack-trace dump. Exit code 1 signals failure without
 * masking a more specific code the action may have set.
 */
export async function runAction(action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		p.log.error((error as Error).message);
		process.exitCode = 1;
	}
}
