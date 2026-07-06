// Strips devDependencies from a package.json at pack time, restoring it after.
//
// Packages that BUNDLE their workspace dependencies (e.g. @infracraft/pulumi and
// @infracraft/gate inline @infracraft/sandbox via tsdown) still need those
// workspace packages declared as devDependencies so the monorepo can resolve and
// build them. But a devDependency published to the registry (a) ships an invalid
// `workspace:*` specifier and (b) makes the workspace package count as
// "depended upon", which blocks it from ever being unpublished. Consumers never
// install a dependency's devDependencies, so the published artifact is strictly
// better without them.
//
// Usage (wired into package scripts):
//   prepack:  node ../../scripts/strip-dev-deps-on-pack.mjs
//   postpack: node ../../scripts/strip-dev-deps-on-pack.mjs --restore

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const BACKUP = "package.json.packbak";
const restore = process.argv.includes("--restore");

if (restore) {
	if (existsSync(BACKUP)) {
		renameSync(BACKUP, "package.json");
	}
} else {
	const original = readFileSync("package.json", "utf8");
	writeFileSync(BACKUP, original);

	const pkg = JSON.parse(original);
	delete pkg.devDependencies;
	writeFileSync("package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
}
