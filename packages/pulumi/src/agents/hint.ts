import * as pulumi from "@pulumi/pulumi";

/**
 * Generic infracraft reminders, prepended to every hint. These hold for any
 * infracraft stack regardless of the consuming project.
 */
const INFRACRAFT_DEFAULTS = [
	"Adopt-or-create: re-running is safe — existing resources are adopted, missing ones created",
	"Shared resources (Railway services/projects, Neon projects) have no-op deletes — destroy never removes them",
	"Mark shared/production resources protect:true — pulumi destroy aborts on protected resources",
];

/**
 * Where {@link hint} writes its output. A closed set, so it is an enum rather
 * than a string union (matches the `SandboxMode` precedent).
 */
export enum AgentHintChannel {
	/** Prints prominently the instant the program loads, before Pulumi's own
	 * output — modeled on how the Vercel CLI surfaces agent guidance. Default. */
	STDERR = "STDERR",
	/** Routes through `pulumi.log.info` (lands in the Diagnostics section instead). */
	PULUMI_LOG = "PULUMI_LOG",
}

/** Options for {@link hint}. */
export interface AgentHintOptions {
	/** Project-specific reminders appended after the infracraft defaults. */
	project?: string[];

	/**
	 * Force the hint on or off. Defaults to auto-detecting an AI coding agent via
	 * the `CLAUDECODE` / `AI_AGENT` environment variables.
	 */
	enabled?: boolean;

	/** Where to write the hint (see {@link AgentHintChannel}). Defaults to `STDERR`. */
	channel?: AgentHintChannel;
}

/**
 * Emits a delimited `<infracraft-hint>` block of reminders for AI coding agents
 * operating this Pulumi stack — modeled on Vercel's `AGENTS.md` guidance: a
 * delimited block, an agent-directed intro, then terse directive bullets.
 *
 * No-op for humans (no agent env var) unless `enabled` is forced. Call it once at
 * the top of your Pulumi program; the infracraft defaults are always included and
 * `project` lines are appended.
 *
 * @param options Project reminders, channel, and detection override.
 * @returns Nothing; emits to the chosen channel as a side effect.
 * @example
 * ```typescript
 * import * as agents from "@infracraft/pulumi/agents";
 *
 * agents.hint({
 *   project: [
 *     "Production is protected — `unprotect <urn>` first for a deliberate change",
 *     "Feature env = imports:[staging], zero config; pulumi destroy is safe",
 *   ],
 * });
 * ```
 */
export function hint(options: AgentHintOptions = {}): void {
	const enabled =
		options.enabled ?? (!!process.env.CLAUDECODE || !!process.env.AI_AGENT);

	if (!enabled) {
		return;
	}

	const lines = [...INFRACRAFT_DEFAULTS, ...(options.project ?? [])];

	const block = [
		"<infracraft-hint>",
		"Reminders for AI agents operating this Pulumi stack:",
		...lines.map((line) => `- ${line}`),
		"</infracraft-hint>",
	].join("\n");

	if (options.channel === AgentHintChannel.PULUMI_LOG) {
		pulumi.log.info(block);
	} else {
		process.stderr.write(`${block}\n`);
	}
}
