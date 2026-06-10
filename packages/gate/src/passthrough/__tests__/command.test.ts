import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	cancel: vi.fn(),
	isCancel: vi.fn(() => false),
	confirm: vi.fn(async () => true),
	text: vi.fn(async () => "picked-label"),
	select: vi.fn(async () => "a"),
	log: {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		message: vi.fn(),
	},
}));

import { AccountStore } from "../../accounts/store";
import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import type { GateProvider, ProviderSession } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import type { CommandContext } from "../../registry/command-spec";
import { InteractionMode } from "../../registry/command-spec";
import type { PassthroughRoute } from "../../routing/route-command";
import { CommandRoute, GateAuthVerb } from "../../routing/route-command";
import { runPassthroughCommand } from "../command";
import type { PassthroughSpawner } from "../runner";

let store: AccountStore;
let native: ProviderSession | null;
let stderrLines: string[];
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let originalStderrIsTTY: boolean | undefined;

function fakeProvider(overrides: Partial<GateProvider> = {}): GateProvider {
	return makeFakeProvider({
		readNativeSession: () => native,
		writeNativeSession: vi.fn((session: ProviderSession) => {
			native = session;
		}),
		...overrides,
	});
}

function makeContext(
	provider: GateProvider,
	interaction = InteractionMode.INTERACTIVE,
): CommandContext {
	return { provider, store, interaction };
}

function passthroughRoute(
	overrides: Partial<Omit<PassthroughRoute, "route">> = {},
): PassthroughRoute {
	return {
		route: CommandRoute.PASSTHROUGH,
		nativeArgs: ["env", "ls"],
		accountLabel: undefined,
		targetName: undefined,
		movedVerbHint: undefined,
		...overrides,
	};
}

function fakeSpawner(exitCode = 0): {
	spawner: PassthroughSpawner;
	calls: { argv: string[]; env: Record<string, string | undefined> }[];
} {
	const calls: { argv: string[]; env: Record<string, string | undefined> }[] =
		[];

	const spawner: PassthroughSpawner = (argv, env) => {
		calls.push({ argv, env });

		return { exited: Promise.resolve(exitCode) };
	};

	return { spawner, calls };
}

function seed(label = "a", token = "t1", identity = "andre"): void {
	store.add({ provider: Provider.VERCEL, label, identity, session: { token } });
}

beforeEach(() => {
	vi.clearAllMocks();

	store = new AccountStore(
		fs.mkdtempSync(path.join(os.tmpdir(), "gate-passthrough-")),
	);

	native = null;
	stderrLines = [];

	originalStderrIsTTY = process.stderr.isTTY;

	Object.defineProperty(process.stderr, "isTTY", {
		value: true,
		configurable: true,
	});

	stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
		chunk: string,
	) => {
		stderrLines.push(String(chunk));

		return true;
	}) as typeof process.stderr.write);

	process.env.GATE_VERGATE_ACCOUNTS_FILE = "/nonexistent/vergate-accounts.json";
});

afterEach(() => {
	stderrWriteSpy.mockRestore();

	Object.defineProperty(process.stderr, "isTTY", {
		value: originalStderrIsTTY,
		configurable: true,
	});

	process.exitCode = undefined;
});

describe("runPassthroughCommand", () => {
	it("uses the active account by default and spawns with injection", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };
		const { spawner, calls } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute(),
			spawner,
		);

		expect(calls[0]?.argv).toEqual(["fake", "env", "ls"]);
		expect(calls[0]?.env.FAKE_TOKEN).toBe("active-tok");
	});

	it("honors an explicit account label", async () => {
		seed("a", "t1");
		seed("work", "work-tok", "worker");
		const { spawner, calls } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute({ accountLabel: "work" }),
			spawner,
		);

		expect(calls[0]?.env.FAKE_TOKEN).toBe("work-tok");
	});

	it("prints the badge + blank line to a TTY stderr", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };
		const { spawner } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute(),
			spawner,
		);

		const output = stderrLines.join("");

		expect(output).toContain("● a (andre)");
		expect(output.endsWith("\n\n")).toBe(true);
	});

	it("suppresses the badge when stderr is not a TTY", async () => {
		Object.defineProperty(process.stderr, "isTTY", {
			value: undefined,
			configurable: true,
		});

		seed("a", "active-tok");
		native = { token: "active-tok" };
		const { spawner } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute(),
			spawner,
		);

		expect(stderrLines).toEqual([]);
	});

	it("prints the moved-verb hint, with the desync warning for login", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };
		const { spawner } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute({
				nativeArgs: ["login"],
				movedVerbHint: GateAuthVerb.LOGIN,
			}),
			spawner,
		);

		const output = stderrLines.join("");

		expect(output).toContain("gate fake auth login");
		expect(output).toContain("modifies the native session");
	});

	it("prints the provider's notice when injection is skipped", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };

		const provider = fakeProvider({
			nativeCli: (context) => ({
				argv: ["fake", ...context.args],
				env: {},
				notice: "using your --token; gate account not applied",
			}),
		});

		const { spawner } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(provider),
			passthroughRoute(),
			spawner,
		);

		expect(stderrLines.join("")).toContain("using your --token");
	});

	it("propagates the native exit code", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };
		const { spawner } = fakeSpawner(7);

		await runPassthroughCommand(
			makeContext(fakeProvider()),
			passthroughRoute(),
			spawner,
		);

		expect(process.exitCode).toBe(7);
	});

	it("NON_INTERACTIVE with no resolvable account throws the hint", async () => {
		seed("a", "t1");

		await expect(
			runPassthroughCommand(
				makeContext(fakeProvider(), InteractionMode.NON_INTERACTIVE),
				passthroughRoute(),
				fakeSpawner(0).spawner,
			),
		).rejects.toThrow(/--account <label>/);
	});

	it("resolves the target and injects its env into the spawn", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };

		const resolveEnv = vi.fn(async () => ({ VERCEL_PROJECT_ID: "prj_1" }));

		const provider = fakeProvider({
			passthroughTarget: { flag: "--project", noun: "project", resolveEnv },
		});

		const { spawner, calls } = fakeSpawner(0);

		await runPassthroughCommand(
			makeContext(provider),
			passthroughRoute({ targetName: "hat-rec" }),
			spawner,
		);

		expect(resolveEnv).toHaveBeenCalledWith("active-tok", "hat-rec");
		expect(calls[0]?.env.VERCEL_PROJECT_ID).toBe("prj_1");
	});

	it("hard-fails before spawning when target resolution throws", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };

		const provider = fakeProvider({
			passthroughTarget: {
				flag: "--project",
				noun: "project",
				resolveEnv: vi.fn(async () => {
					throw new Error('Project "ghost" was not found for this account.');
				}),
			},
		});

		const { spawner, calls } = fakeSpawner(0);

		await expect(
			runPassthroughCommand(
				makeContext(provider),
				passthroughRoute({ targetName: "ghost" }),
				spawner,
			),
		).rejects.toThrow(/was not found/);

		expect(calls).toEqual([]);
	});

	it("never resolves when no target was given", async () => {
		seed("a", "active-tok");
		native = { token: "active-tok" };

		const resolveEnv = vi.fn(async () => ({}));

		const provider = fakeProvider({
			passthroughTarget: { flag: "--project", noun: "project", resolveEnv },
		});

		await runPassthroughCommand(
			makeContext(provider),
			passthroughRoute(),
			fakeSpawner(0).spawner,
		);

		expect(resolveEnv).not.toHaveBeenCalled();
	});
});
