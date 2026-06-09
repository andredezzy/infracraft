import { SandboxMode } from "@infracraft/sandbox";
import { describe, expect, it } from "vitest";

import type { GateProvider } from "../../providers/provider";
import {
	buildDeployScript,
	type DeploySpawner,
	runDeploy,
	shellEscape,
} from "../runner";

const provider = {
	binary: "vercel",
	deployUrlPattern: /https:\/\/[^\s]+\.vercel\.app[^\s]*/,
	deployCli: ({
		token,
		passthroughArgs,
	}: {
		token: string;
		passthroughArgs: string[];
	}) => ({
		argv: ["vercel", "deploy", "--token", token, ...passthroughArgs],
		env: { EXTRA: "1" },
	}),
} as unknown as GateProvider;

function linesToStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

describe("shellEscape", () => {
	it("single-quotes and escapes embedded quotes", () => {
		expect(shellEscape("plain")).toBe("'plain'");
		expect(shellEscape("it's")).toBe("'it'\\''s'");
	});
});

describe("buildDeployScript", () => {
	it("NONE mode returns null (direct spawn, no sandbox script)", () => {
		expect(
			buildDeployScript({ argv: ["vercel"], env: {} }, SandboxMode.NONE, "app"),
		).toBeNull();
	});

	it("STUB mode wraps the CLI in a sandbox script, keeping env out of the script", () => {
		const script = buildDeployScript(
			{ argv: ["vercel", "deploy"], env: { FLY_API_TOKEN: "t" } },
			SandboxMode.STUB,
			"my-app",
		);

		expect(script).toContain("git init -q");
		expect(script).toContain("'vercel' 'deploy'");
		expect(script).not.toContain("FLY_API_TOKEN");
	});

	it("ORIGINAL mode produces a sandbox script without the stub git", () => {
		const script = buildDeployScript(
			{ argv: ["vercel", "deploy"], env: {} },
			SandboxMode.ORIGINAL,
			"my-app",
		);

		expect(script).toContain("mktemp");
		expect(script).not.toContain("git init -q");
	});
});

describe("runDeploy", () => {
	it("streams stdout, captures the deploy URL, returns the exit code", async () => {
		const lines = [
			"Building...\n",
			"https://my-app-abc.vercel.app\n",
			"Done\n",
		];

		const spawner: DeploySpawner = () => ({
			stdout: linesToStream(lines),
			exited: Promise.resolve(0),
		});

		const result = await runDeploy({
			provider,
			token: "tok",
			passthroughArgs: [],
			mode: SandboxMode.NONE,
			spawner,
		});

		expect(result.exitCode).toBe(0);
		expect(result.url).toBe("https://my-app-abc.vercel.app");
	});

	it("propagates a non-zero exit code without throwing", async () => {
		const spawner: DeploySpawner = () => ({
			stdout: linesToStream([]),
			exited: Promise.resolve(2),
		});

		const result = await runDeploy({
			provider,
			token: "tok",
			passthroughArgs: [],
			mode: SandboxMode.NONE,
			spawner,
		});

		expect(result.exitCode).toBe(2);
		expect(result.url).toBeUndefined();
	});

	it("passes argv + merged env to the spawner in NONE mode", async () => {
		let seenArgv: string[] = [];
		let seenEnv: Record<string, string | undefined> = {};

		const spawner: DeploySpawner = (argv, env) => {
			seenArgv = argv;
			seenEnv = env;

			return { stdout: linesToStream([]), exited: Promise.resolve(0) };
		};

		await runDeploy({
			provider,
			token: "tok",
			passthroughArgs: ["--prod"],
			mode: SandboxMode.NONE,
			spawner,
		});

		expect(seenArgv).toEqual(["vercel", "deploy", "--token", "tok", "--prod"]);
		expect(seenEnv.EXTRA).toBe("1");
	});

	it("runs /bin/sh -c <script> with command env in STUB mode", async () => {
		let seenArgv: string[] = [];
		let seenEnv: Record<string, string | undefined> = {};

		const spawner: DeploySpawner = (argv, env) => {
			seenArgv = argv;
			seenEnv = env;

			return { stdout: linesToStream([]), exited: Promise.resolve(0) };
		};

		await runDeploy({
			provider,
			token: "tok",
			passthroughArgs: [],
			mode: SandboxMode.STUB,
			spawner,
		});

		expect(seenArgv[0]).toBe("/bin/sh");
		expect(seenArgv[1]).toBe("-c");
		expect(seenArgv[2]).toContain("git init -q");
		// env vars must not be inlined in the script string (would be visible in ps)
		expect(seenArgv[2]).not.toContain("EXTRA=");
		expect(seenEnv.EXTRA).toBe("1");
	});

	it("reassembles a line split across two chunks", async () => {
		const spawner: DeploySpawner = () => ({
			stdout: linesToStream(["https://my-app-abc.", "vercel.app\nDone\n"]),
			exited: Promise.resolve(0),
		});

		const result = await runDeploy({
			provider,
			token: "tok",
			passthroughArgs: [],
			mode: SandboxMode.NONE,
			spawner,
		});

		expect(result.url).toBe("https://my-app-abc.vercel.app");
	});

	it("turns a spawner ENOENT into a friendly install message", async () => {
		const spawner: DeploySpawner = () => {
			const error = new Error("spawn vercel ENOENT") as NodeJS.ErrnoException;
			error.code = "ENOENT";

			throw error;
		};

		await expect(
			runDeploy({
				provider,
				token: "tok",
				passthroughArgs: [],
				mode: SandboxMode.NONE,
				spawner,
			}),
		).rejects.toThrow(/vercel CLI not found/);
	});
});
