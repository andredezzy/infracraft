import { describe, expect, it, vi } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import type { PassthroughSpawner } from "../runner";
import { runPassthrough } from "../runner";

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

describe("runPassthrough", () => {
	it("spawns the provider's nativeCli argv with merged env", async () => {
		const { spawner, calls } = fakeSpawner(0);

		const result = await runPassthrough({
			provider: makeFakeProvider(),
			token: "tok",
			nativeArgs: ["env", "ls"],
			spawner,
		});

		expect(calls[0]?.argv).toEqual(["fake", "env", "ls"]);
		expect(calls[0]?.env.FAKE_TOKEN).toBe("tok");
		expect(calls[0]?.env.PATH).toBe(process.env.PATH);
		expect(result.exitCode).toBe(0);
	});

	it("propagates the native exit code", async () => {
		const { spawner } = fakeSpawner(3);

		const result = await runPassthrough({
			provider: makeFakeProvider(),
			token: "tok",
			nativeArgs: ["status"],
			spawner,
		});

		expect(result.exitCode).toBe(3);
	});

	it("turns ENOENT into a friendly install hint", async () => {
		const spawner: PassthroughSpawner = vi.fn(() => {
			const error = new Error("spawn fake ENOENT") as NodeJS.ErrnoException;
			error.code = "ENOENT";

			throw error;
		});

		await expect(
			runPassthrough({
				provider: makeFakeProvider(),
				token: "tok",
				nativeArgs: ["status"],
				spawner,
			}),
		).rejects.toThrow(/fake CLI not found/);
	});

	it("merges targetEnv over the command env", async () => {
		const { spawner, calls } = fakeSpawner(0);

		await runPassthrough({
			provider: makeFakeProvider(),
			token: "tok",
			nativeArgs: ["env", "ls"],
			targetEnv: { VERCEL_PROJECT_ID: "prj_1", FAKE_TOKEN: "override" },
			spawner,
		});

		expect(calls[0]?.env.VERCEL_PROJECT_ID).toBe("prj_1");
		expect(calls[0]?.env.FAKE_TOKEN).toBe("override");
	});
});
