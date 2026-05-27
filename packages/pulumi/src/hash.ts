import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_IGNORE = new Set([
	"node_modules",
	"dist",
	".turbo",
	".next",
	".git",
	".vercel",
]);

interface HashOptions {
	ignore?: Set<string>;
}

export function hashDirectory(dirPath: string, options?: HashOptions): string {
	const ignore = options?.ignore ?? DEFAULT_IGNORE;
	const hash = crypto.createHash("sha256");

	function walk(currentPath: string) {
		const entries = fs.readdirSync(currentPath, { withFileTypes: true });

		for (const entry of entries.sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (ignore.has(entry.name)) {
				continue;
			}

			const fullPath = path.join(currentPath, entry.name);

			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				hash.update(entry.name);
				hash.update(fs.readFileSync(fullPath));
			}
		}
	}

	walk(dirPath);

	return hash.digest("hex");
}
