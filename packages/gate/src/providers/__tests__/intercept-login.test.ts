import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { interceptNativeLogin, type LoginSpawner } from "../intercept-login";
import type { ProviderSession } from "../provider";

let dir: string;
let authFile: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-login-"));
	authFile = path.join(dir, "auth.json");
});

function target() {
	return {
		name: "Vercel",
		authFile,
		loginArgv: ["vercel", "login"],
		readNativeSession: (): ProviderSession | null => {
			const raw = fs.existsSync(authFile)
				? fs.readFileSync(authFile, "utf-8")
				: null;

			return raw ? (JSON.parse(raw) as ProviderSession) : null;
		},
	};
}

const loginSucceeds: LoginSpawner = async () => {
	fs.writeFileSync(authFile, JSON.stringify({ token: "fresh" }));

	return 0;
};

const loginFails: LoginSpawner = async () => 1;

describe("interceptNativeLogin", () => {
	it("captures the fresh session and restores the original auth file", async () => {
		fs.writeFileSync(authFile, JSON.stringify({ token: "original" }));

		const session = await interceptNativeLogin(target(), loginSucceeds);

		expect(session.token).toBe("fresh");
		expect(JSON.parse(fs.readFileSync(authFile, "utf-8")).token).toBe(
			"original",
		);
	});

	it("works when no original auth file existed", async () => {
		const session = await interceptNativeLogin(target(), loginSucceeds);

		expect(session.token).toBe("fresh");
		expect(fs.existsSync(authFile)).toBe(false);
	});

	it("restores the original file when login exits non-zero", async () => {
		fs.writeFileSync(authFile, JSON.stringify({ token: "original" }));

		await expect(interceptNativeLogin(target(), loginFails)).rejects.toThrow(
			/login failed/i,
		);
		expect(JSON.parse(fs.readFileSync(authFile, "utf-8")).token).toBe(
			"original",
		);
	});

	it("restores the original file when the spawner throws", async () => {
		fs.writeFileSync(authFile, JSON.stringify({ token: "original" }));

		const spawnerThrows: LoginSpawner = async () => {
			throw new Error("ENOENT-ish");
		};

		await expect(interceptNativeLogin(target(), spawnerThrows)).rejects.toThrow(
			"ENOENT-ish",
		);
		expect(JSON.parse(fs.readFileSync(authFile, "utf-8")).token).toBe(
			"original",
		);
	});

	it("fails when login succeeds but no session is readable", async () => {
		const noWrite: LoginSpawner = async () => 0;

		await expect(interceptNativeLogin(target(), noWrite)).rejects.toThrow(
			/could not read/i,
		);
	});
});
