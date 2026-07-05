import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertHostBinaries } from "../preflight";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

/** Makes the mocked `command -v` succeed only for the listed binaries. */
function stubHostPath(available: string[]): void {
	spawnSyncMock.mockImplementation((_shell: string, args: string[]) => {
		const binary = args[args.length - 1];

		return { status: available.includes(binary) ? 0 : 1 };
	});
}

describe("assertHostBinaries", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
	});

	it("returns silently when every binary resolves", () => {
		stubHostPath(["git", "rsync", "awk", "mktemp"]);

		expect(() =>
			assertHostBinaries(["git", "rsync", "awk", "mktemp"]),
		).not.toThrow();

		expect(spawnSyncMock).toHaveBeenCalledTimes(4);
	});

	it("probes via `command -v` with the binary as a positional parameter (never shell-interpolated)", () => {
		stubHostPath(["git"]);

		assertHostBinaries(["git"]);

		const [shell, args] = spawnSyncMock.mock.calls[0];
		expect(shell).toBe("/bin/sh");
		expect(args[0]).toBe("-c");
		expect(args[1]).toContain("command -v");
		expect(args[1]).not.toContain("git"); // program text carries no binary name
		expect(args[args.length - 1]).toBe("git");
	});

	it("throws ONE error listing ALL missing binaries", () => {
		stubHostPath(["git"]);

		expect(() => assertHostBinaries(["git", "rsync", "fly"])).toThrow(
			/rsync[\s\S]*fly/,
		);
	});

	it("includes a friendly install hint for each known binary", () => {
		stubHostPath([]);

		expect(() => assertHostBinaries(["fly", "railway", "vercel"])).toThrow(
			/fly\.io\/install\.sh[\s\S]*@railway\/cli[\s\S]*npm install -g vercel/,
		);
	});

	it("lists an unknown binary plainly, without inventing a hint", () => {
		stubHostPath([]);

		let message = "";

		try {
			assertHostBinaries(["frobnicate"]);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("- frobnicate");
		expect(message).not.toContain("frobnicate:");
	});
});
