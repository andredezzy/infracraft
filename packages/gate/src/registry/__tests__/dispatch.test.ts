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

import * as p from "@clack/prompts";

import { AccountStore } from "../../accounts/store";
import { GateAuthVerb } from "../../routing/route-command";
import type { CommandRegistry } from "../command-registry";
import type { CommandSpec } from "../command-spec";
import { dispatch } from "../dispatch";

let store: AccountStore;
let stdoutChunks: string[];
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

function spyingSpec(): { spec: CommandSpec; calls: string[][] } {
	const calls: string[][] = [];

	return {
		spec: {
			description: "spy",
			usage: "",
			run: async (_context, args) => {
				calls.push(args);
			},
		},
		calls,
	};
}

function makeRegistry(spy: CommandSpec): CommandRegistry {
	const authVerbs = new Map<GateAuthVerb, CommandSpec>();

	for (const verb of Object.values(GateAuthVerb)) {
		authVerbs.set(verb, spy);
	}

	return { authVerbs, deploySpec: spy };
}

beforeEach(() => {
	vi.clearAllMocks();

	store = new AccountStore(
		fs.mkdtempSync(path.join(os.tmpdir(), "gate-dispatch-")),
	);

	stdoutChunks = [];

	stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string,
	) => {
		stdoutChunks.push(String(chunk));

		return true;
	}) as typeof process.stdout.write);
});

afterEach(() => {
	stdoutWriteSpy.mockRestore();
	process.exitCode = undefined;
});

describe("dispatch help and version", () => {
	it.each([
		[[]],
		[["--help"]],
		[["-h"]],
	])("renders root help for %j", async (rawArgs) => {
		await dispatch({ rawArgs, store });

		expect(stdoutChunks.join("")).toContain("PROVIDERS");
	});

	it("prints the version", async () => {
		await dispatch({ rawArgs: ["--version"], store });

		expect(stdoutChunks.join("")).toMatch(/\d+\.\d+\.\d+/);
	});

	it("renders provider help for a bare provider and --help", async () => {
		for (const rawArgs of [["vercel"], ["vercel", "--help"]]) {
			stdoutChunks.length = 0;

			await dispatch({ rawArgs, store });

			expect(stdoutChunks.join("")).toContain("PASSTHROUGH");
		}
	});

	it("renders auth help for bare auth and auth --help", async () => {
		for (const rawArgs of [
			["vercel", "auth"],
			["vercel", "auth", "--help"],
		]) {
			stdoutChunks.length = 0;

			await dispatch({ rawArgs, store });

			expect(stdoutChunks.join("")).toContain("account management");
		}
	});

	it("renders per-verb help for auth <verb> --help", async () => {
		await dispatch({ rawArgs: ["vercel", "auth", "switch", "--help"], store });

		expect(stdoutChunks.join("")).toContain("auth switch");
	});
});

describe("dispatch routing", () => {
	it("errors on an unknown provider", async () => {
		await dispatch({ rawArgs: ["netlify", "deploy"], store });

		expect(p.log.error).toHaveBeenCalledWith(
			expect.stringContaining("netlify"),
		);

		expect(process.exitCode).toBe(1);
	});

	it("runs the auth spec with the verb args", async () => {
		const { spec, calls } = spyingSpec();

		await dispatch({
			rawArgs: ["vercel", "auth", "switch", "work"],
			store,
			registry: makeRegistry(spec),
		});

		expect(calls).toEqual([["work"]]);
	});

	it("resolves railway's `up` to the deploy spec", async () => {
		const { spec, calls } = spyingSpec();

		await dispatch({
			rawArgs: ["railway", "up", "--detach"],
			store,
			registry: makeRegistry(spec),
		});

		expect(calls).toEqual([["--detach"]]);
	});

	it("renders an INVALID route's message on the error path", async () => {
		await dispatch({
			rawArgs: ["vercel", "-a", "work", "auth", "switch"],
			store,
		});

		expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("auth"));
		expect(process.exitCode).toBe(1);
	});

	it("hands the deploy spec the re-injected account from a leading flag", async () => {
		const { spec, calls } = spyingSpec();

		await dispatch({
			rawArgs: ["vercel", "-a", "work", "deploy", "--prod"],
			store,
			registry: makeRegistry(spec),
		});

		expect(calls).toEqual([["--prod", "--account", "work"]]);
	});
});
