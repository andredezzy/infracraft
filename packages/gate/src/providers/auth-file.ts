import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Reads a file as UTF-8, or null when it does not exist. */
export function readTextFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

/**
 * Crash-safe write for native CLI auth files: write a sibling temp file, then
 * rename over the target. A crash mid-switch can never leave the native CLI
 * with a truncated auth file. Mode 0600 — these files hold tokens.
 */
export function atomicWriteFile(filePath: string, content: string): void {
	const dir = path.dirname(filePath);

	mkdirSync(dir, { recursive: true });

	const tempPath = path.join(dir, `.${path.basename(filePath)}.gate-tmp`);

	writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
	renameSync(tempPath, filePath);
}
