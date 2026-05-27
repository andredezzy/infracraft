import crypto from "node:crypto";
import { vi } from "vitest";

vi.mock("bun", () => {
	class MockS3Client {
		write = vi.fn().mockResolvedValue(undefined);

		file = vi.fn().mockReturnValue({
			arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
			delete: vi.fn().mockResolvedValue(undefined),
			presign: vi.fn().mockReturnValue("https://mock-presigned-url.com"),
		});

		exists = vi.fn().mockResolvedValue(true);
	}

	return { S3Client: MockS3Client, $: vi.fn() };
});

const nodeSetTimeout = globalThis.setTimeout;

class MockCryptoHasher {
	private hasher: crypto.Hash | crypto.Hmac;

	constructor(algorithm: string, secret?: string) {
		this.hasher = secret
			? crypto.createHmac(algorithm, secret)
			: crypto.createHash(algorithm);
	}

	update(data: string | Buffer): this {
		this.hasher.update(data);

		return this;
	}

	digest(): Buffer;
	digest(encoding: "base64" | "hex"): string;
	digest(encoding?: "base64" | "hex"): string | Buffer {
		return encoding ? this.hasher.digest(encoding) : this.hasher.digest();
	}
}

const mockPassword = {
	hash: async (password: string): Promise<string> => {
		return `$mock$${crypto.createHash("sha256").update(password).digest("base64")}`;
	},
	verify: async (password: string, hash: string): Promise<boolean> => {
		return (
			hash ===
			`$mock$${crypto.createHash("sha256").update(password).digest("base64")}`
		);
	},
};

vi.stubGlobal("Bun", {
	env: process.env,
	version: "1.0.0-mock",
	sleep: (ms: number) => new Promise((resolve) => nodeSetTimeout(resolve, ms)),
	CryptoHasher: MockCryptoHasher,
	password: mockPassword,
});
