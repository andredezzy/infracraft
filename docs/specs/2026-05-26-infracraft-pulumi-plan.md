# @infracraft/pulumi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `@infracraft/pulumi` — a Pulumi provider library for Railway, Neon, and Vercel with adopt-or-create semantics, deploy orchestration, and preview-safe resources.

**Architecture:** Single npm package with subpath exports (`/railway`, `/neon`, `/vercel`, `/hash`, `/git-guard`). All cloud mutations go through `dynamic.Resource` or `ComponentResource` — no pre-engine imperative code. Providers are extracted and generalized from two existing projects at `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/` and `/Users/andrevictor/www/HAT-CREW/mlm-rby/infrastructure/`.

**Tech Stack:** Bun 1.3.14, TypeScript 6.0.3, Turbo 2.9.15, Biome 2.4.15, ESLint 10.4.0, tsdown 0.22.0, Vitest 4.1.7, knip 6.14.2, @pulumi/pulumi ^3, @pulumi/command ^1

**Reference code locations:**
- Railway providers: `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/`
- Neon providers: `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/`
- Vercel providers: `/Users/andrevictor/www/HAT-CREW/mlm-rby/infrastructure/providers/vercel/`
- Helpers: `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/helpers/`
- Monorepo config reference: `/Users/andrevictor/www/HAT-CREW/nodex/` (package.json, turbo.json, biome.json, eslint.config.mjs, bunfig.toml)
- Config packages reference: `/Users/andrevictor/www/HAT-CREW/nodex/packages/config-tsdown/`, `/Users/andrevictor/www/HAT-CREW/nodex/packages/config-typescript/`
- Test config reference: `/Users/andrevictor/www/HAT-CREW/mlm-rby/packages/config-test/`

---

## Task 1: Root monorepo scaffolding

**Files:**
- Create: `package.json`
- Create: `turbo.json`
- Create: `biome.json`
- Create: `eslint.config.mjs`
- Create: `bunfig.toml`
- Create: `knip.json`
- Create: `.gitignore`

All files live at `/Users/andrevictor/www/Andre-Dezzy/infracraft/`.

- [ ] **Step 1: Create root `package.json`**

```json
{
	"name": "infracraft",
	"private": true,
	"type": "module",
	"packageManager": "bun@1.3.14",
	"workspaces": ["packages/*"],
	"scripts": {
		"build": "turbo run build",
		"dev": "turbo run dev",
		"typecheck": "turbo run typecheck",
		"test": "turbo run test",
		"lint": "eslint --fix && biome check --write --max-diagnostics 500",
		"knip": "knip",
		"postinstall": "test -n \"$CI\" || bun run build"
	},
	"devDependencies": {
		"@biomejs/biome": "2.4.15",
		"@stylistic/eslint-plugin": "5.10.0",
		"@types/bun": "1.3.14",
		"@types/node": "25.9.1",
		"@typescript-eslint/eslint-plugin": "8.60.0",
		"@typescript-eslint/parser": "8.60.0",
		"eslint": "10.4.0",
		"knip": "6.14.2",
		"tsdown": "0.22.0",
		"turbo": "2.9.15",
		"typescript": "6.0.3"
	},
	"engines": {
		"bun": ">=1.3.14",
		"node": ">=22"
	},
	"overrides": {
		"@types/node": "25.9.1"
	}
}
```

- [ ] **Step 2: Create `turbo.json`**

```json
{
	"$schema": "https://turbo.build/schema.json",
	"concurrency": "20",
	"tasks": {
		"dev": {
			"dependsOn": ["^build"],
			"persistent": true,
			"cache": false
		},
		"build": {
			"dependsOn": ["^build"],
			"inputs": ["$TURBO_DEFAULT$", ".env*"],
			"outputs": ["dist/**"]
		},
		"typecheck": {
			"dependsOn": ["^build"],
			"inputs": ["$TURBO_DEFAULT$", ".env*"]
		},
		"test": {
			"dependsOn": ["^build"]
		},
		"lint": {}
	}
}
```

- [ ] **Step 3: Create `biome.json`**

Copy from `/Users/andrevictor/www/HAT-CREW/nodex/biome.json` but update the schema version to `2.4.15`. Keep all rules identical: tab indent, double quotes, `noUnusedImports: error`, `noUnusedVariables: error`, `noExplicitAny: error`, `noConsole: warn` (allowing log/error/warn/info/debug), `useBlockStatements: error`, `noNestedTernary: error`, `useConst: error`, `useTemplate: error`, `noBarrelFile: warn` (off for `packages/*/src/index.ts`), `useSortedClasses: error`, `organizeImports: on`. Disable linting/formatting for `**/generated/**` and `**/*.generated.*`.

- [ ] **Step 4: Create `eslint.config.mjs`**

Copy from `/Users/andrevictor/www/HAT-CREW/nodex/eslint.config.mjs`. Uses flat config with `@stylistic/eslint-plugin` for `padding-line-between-statements` only. Ignores `node_modules`, `.turbo`, `dist`, `coverage`, `generated`.

- [ ] **Step 5: Create `bunfig.toml`**

```toml
[install]
exact = true
```

- [ ] **Step 6: Create `knip.json`**

```json
{
	"workspaces": {
		".": {},
		"packages/pulumi": {},
		"packages/config-tsdown": {},
		"packages/config-typescript": {},
		"packages/config-test": {}
	},
	"ignore": ["dist", ".turbo"]
}
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules
dist
build
.turbo
*.tsbuildinfo
coverage
.DS_Store
*.log
.env*.local*
```

- [ ] **Step 8: Install dependencies and verify**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun install`
Expected: Lockfile generated, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold infracraft monorepo root"
```

---

## Task 2: Config packages (typescript, tsdown, test)

**Files:**
- Create: `packages/config-typescript/package.json`
- Create: `packages/config-typescript/base.json`
- Create: `packages/config-tsdown/package.json`
- Create: `packages/config-tsdown/tsconfig.json`
- Create: `packages/config-tsdown/tsdown.config.ts`
- Create: `packages/config-tsdown/src/base.ts`
- Create: `packages/config-tsdown/src/library.ts`
- Create: `packages/config-tsdown/src/merge.ts`
- Create: `packages/config-test/package.json`
- Create: `packages/config-test/tsconfig.json`
- Create: `packages/config-test/tsdown.config.ts`
- Create: `packages/config-test/src/base.ts`
- Create: `packages/config-test/src/unit.ts`
- Create: `packages/config-test/src/setup.ts`

- [ ] **Step 1: Create `packages/config-typescript/`**

Copy from `/Users/andrevictor/www/HAT-CREW/nodex/packages/config-typescript/`. Only need `package.json` (name: `@infracraft/typescript-config`, version `0.0.0`, private) and `base.json` (target ES2022, module NodeNext, strict, composite, declaration).

- [ ] **Step 2: Create `packages/config-tsdown/`**

Copy from `/Users/andrevictor/www/HAT-CREW/nodex/packages/config-tsdown/`. Change package name to `@infracraft/config-tsdown`. Change `@nodex/typescript-config` references to `@infracraft/typescript-config`. Keep source files: `base.ts` (baseConfig + TEST_EXCLUSIONS), `library.ts` (library preset), `merge.ts` (mergeConfig utility). Update `tsdown` dependency to `0.22.0`.

- [ ] **Step 3: Create `packages/config-test/`**

Copy from `/Users/andrevictor/www/HAT-CREW/mlm-rby/packages/config-test/`. Change package name to `@infracraft/config-test`. Change `@mlm/config-test` references to `@infracraft/config-test`. Change `@mlm/typescript-config` to `@infracraft/typescript-config`. Keep source files: `base.ts` (vitest base config), `unit.ts` (unit test preset), `setup.ts` (global test setup — stub `globalThis.Bun`). Update `vitest` dependency to `4.1.7`.

- [ ] **Step 4: Install and build config packages**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun install && bun run build
```

Expected: All 3 config packages build clean. `config-typescript` has no build step. `config-tsdown` and `config-test` produce `dist/` output.

- [ ] **Step 5: Commit**

```bash
git add packages/config-typescript packages/config-tsdown packages/config-test bun.lock
git commit -m "chore: add config-typescript, config-tsdown, config-test packages"
```

---

## Task 3: @infracraft/pulumi package scaffolding

**Files:**
- Create: `packages/pulumi/package.json`
- Create: `packages/pulumi/tsconfig.json`
- Create: `packages/pulumi/tsdown.config.ts`
- Create: `packages/pulumi/vitest.config.ts`

- [ ] **Step 1: Create `packages/pulumi/package.json`**

```json
{
	"name": "@infracraft/pulumi",
	"version": "0.1.0",
	"type": "module",
	"exports": {
		"./railway": {
			"types": "./dist/railway/index.d.mts",
			"default": "./dist/railway/index.mjs"
		},
		"./neon": {
			"types": "./dist/neon/index.d.mts",
			"default": "./dist/neon/index.mjs"
		},
		"./vercel": {
			"types": "./dist/vercel/index.d.mts",
			"default": "./dist/vercel/index.mjs"
		},
		"./hash": {
			"types": "./dist/hash.d.mts",
			"default": "./dist/hash.mjs"
		},
		"./git-guard": {
			"types": "./dist/git-guard.d.mts",
			"default": "./dist/git-guard.mjs"
		}
	},
	"files": ["dist/**"],
	"scripts": {
		"build": "tsdown",
		"dev": "tsdown --watch",
		"typecheck": "tsc --noEmit",
		"test": "vitest run",
		"lint": "biome check --write"
	},
	"peerDependencies": {
		"@pulumi/pulumi": "^3",
		"@pulumi/command": "^1"
	},
	"peerDependenciesMeta": {
		"@pulumi/command": {
			"optional": true
		}
	},
	"devDependencies": {
		"@infracraft/config-tsdown": "workspace:*",
		"@infracraft/config-test": "workspace:*",
		"@infracraft/typescript-config": "workspace:*",
		"@pulumi/command": "1.2.1",
		"@pulumi/pulumi": "3.243.0",
		"@types/node": "25.9.1",
		"typescript": "6.0.3",
		"vitest": "4.1.7"
	}
}
```

- [ ] **Step 2: Create `packages/pulumi/tsconfig.json`**

```json
{
	"extends": "@infracraft/typescript-config/base.json",
	"compilerOptions": {
		"rootDir": "./src",
		"outDir": "./dist",
		"composite": false
	},
	"include": ["src/**/*.ts"],
	"exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/pulumi/tsdown.config.ts`**

```ts
import { library } from "@infracraft/config-tsdown/library";

export default library({
	entry: [
		"src/railway/index.ts",
		"src/neon/index.ts",
		"src/vercel/index.ts",
		"src/hash.ts",
		"src/git-guard.ts",
	],
});
```

- [ ] **Step 4: Create `packages/pulumi/vitest.config.ts`**

```ts
import { unit } from "@infracraft/config-test/unit";
import { defineConfig } from "vitest/config";

export default defineConfig(unit());
```

- [ ] **Step 5: Create placeholder source files so build succeeds**

Create empty barrel files so the build pipeline works while we implement:

`packages/pulumi/src/railway/index.ts`:
```ts
export {};
```

`packages/pulumi/src/neon/index.ts`:
```ts
export {};
```

`packages/pulumi/src/vercel/index.ts`:
```ts
export {};
```

`packages/pulumi/src/hash.ts`:
```ts
export {};
```

`packages/pulumi/src/git-guard.ts`:
```ts
export {};
```

- [ ] **Step 6: Install, build, and typecheck**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun install && bun run build && bun run typecheck
```

Expected: All packages build. No type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/pulumi bun.lock
git commit -m "chore: scaffold @infracraft/pulumi package with subpath exports"
```

---

## Task 4: hashDirectory implementation + tests

**Files:**
- Create: `packages/pulumi/src/hash.ts`
- Create: `packages/pulumi/src/__tests__/hash.test.ts`

**Reference:** `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/helpers/hash.ts`

- [ ] **Step 1: Write the failing tests**

`packages/pulumi/src/__tests__/hash.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashDirectory } from "../hash";

describe("hashDirectory", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("produces a deterministic 64-char hex hash", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");

		const hash1 = hashDirectory(tmpDir);
		const hash2 = hashDirectory(tmpDir);

		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("produces different hashes for different content", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-a");
		const hash1 = hashDirectory(tmpDir);

		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-b");
		const hash2 = hashDirectory(tmpDir);

		expect(hash1).not.toBe(hash2);
	});

	it("ignores node_modules and dist by default", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
		const hash1 = hashDirectory(tmpDir);

		fs.mkdirSync(path.join(tmpDir, "node_modules"));
		fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg.js"), "module");
		fs.mkdirSync(path.join(tmpDir, "dist"));
		fs.writeFileSync(path.join(tmpDir, "dist", "out.js"), "built");

		const hash2 = hashDirectory(tmpDir);

		expect(hash1).toBe(hash2);
	});

	it("accepts a custom ignore set", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
		fs.mkdirSync(path.join(tmpDir, "__tests__"));
		fs.writeFileSync(path.join(tmpDir, "__tests__", "test.ts"), "test");

		const withTests = hashDirectory(tmpDir);
		const withoutTests = hashDirectory(tmpDir, {
			ignore: new Set(["__tests__"]),
		});

		expect(withTests).not.toBe(withoutTests);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test --filter=@infracraft/pulumi`
Expected: FAIL — `hashDirectory` is not exported.

- [ ] **Step 3: Implement hashDirectory**

`packages/pulumi/src/hash.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test --filter=@infracraft/pulumi`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/hash.ts packages/pulumi/src/__tests__/hash.test.ts
git commit -m "feat: add hashDirectory with configurable ignore set"
```

---

## Task 5: gitGuard implementation + tests

**Files:**
- Create: `packages/pulumi/src/git-guard.ts`
- Create: `packages/pulumi/src/__tests__/git-guard.test.ts`

**Reference:** `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/helpers/git-guard.ts`

**Key changes from reference:**
- Guard dir renamed to `.git-infracraft-pulumi-guard`
- Added `ensureGitignore` — auto-adds guard dir to `.gitignore`
- Function renamed from `createGitGuard` to `gitGuard`

- [ ] **Step 1: Write failing tests for ensureGitignore logic**

`packages/pulumi/src/__tests__/git-guard.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GUARD_DIR, ensureGitignore } from "../git-guard";

describe("ensureGitignore", () => {
	let tmpDir: string;
	let gitignorePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-test-"));
		gitignorePath = path.join(tmpDir, ".gitignore");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .gitignore with guard dir if file does not exist", () => {
		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain(GUARD_DIR);
	});

	it("appends guard dir to existing .gitignore", () => {
		fs.writeFileSync(gitignorePath, "node_modules\ndist\n");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain("node_modules");
		expect(content).toContain(GUARD_DIR);
	});

	it("does not duplicate guard dir if already present", () => {
		fs.writeFileSync(gitignorePath, `node_modules\n${GUARD_DIR}\n`);

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		const occurrences = content.split(GUARD_DIR).length - 1;
		expect(occurrences).toBe(1);
	});

	it("adds newline before guard dir when file lacks trailing newline", () => {
		fs.writeFileSync(gitignorePath, "node_modules");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toBe(`node_modules\n${GUARD_DIR}\n`);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test --filter=@infracraft/pulumi`
Expected: FAIL — `ensureGitignore` and `GUARD_DIR` not exported.

- [ ] **Step 3: Implement git-guard.ts**

`packages/pulumi/src/git-guard.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as command from "@pulumi/command";

export const GUARD_DIR = ".git-infracraft-pulumi-guard";

interface GitGuardResult {
	hide: command.local.Command;
}

export function gitGuard(monorepoRoot: string): GitGuardResult {
	const gitPath = path.join(monorepoRoot, ".git");
	const guardPath = path.join(monorepoRoot, GUARD_DIR);
	const gitignorePath = path.join(monorepoRoot, ".gitignore");

	ensureGitignore(gitignorePath);

	function restore(): void {
		try {
			if (fs.existsSync(guardPath)) {
				if (fs.existsSync(gitPath)) {
					fs.rmSync(gitPath, { recursive: true, force: true });
				}

				fs.renameSync(guardPath, gitPath);
			}
		} catch {
			console.error(
				`[git-guard] Failed to restore .git. Run manually: rm -rf ${gitPath} && mv ${guardPath} ${gitPath}`,
			);
		}
	}

	process.on("exit", restore);
	process.on("SIGINT", () => { restore(); process.exit(0); });
	process.on("SIGTERM", () => { restore(); process.exit(0); });

	const hide = new command.local.Command("git-guard-hide", {
		create: [
			`test -d .git && test ! -d ${GUARD_DIR}`,
			`&& mv .git ${GUARD_DIR}`,
			`&& git init --quiet`,
			`&& cp ${GUARD_DIR}/index .git/index`,
			`&& echo "hidden"`,
			`|| echo "no-op"`,
		].join(" "),
		dir: monorepoRoot,
		triggers: [monorepoRoot],
	});

	return { hide };
}

export function ensureGitignore(gitignorePath: string): void {
	const content = fs.existsSync(gitignorePath)
		? fs.readFileSync(gitignorePath, "utf-8")
		: "";

	if (content.includes(GUARD_DIR)) {
		return;
	}

	const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";

	fs.appendFileSync(gitignorePath, `${newline}${GUARD_DIR}\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test --filter=@infracraft/pulumi`
Expected: All tests PASS (4 hash + 4 git-guard).

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/git-guard.ts packages/pulumi/src/__tests__/git-guard.test.ts
git commit -m "feat: add gitGuard with .gitignore management"
```

---

## Task 6: Railway client + tests

**Files:**
- Create: `packages/pulumi/src/railway/client.ts`
- Create: `packages/pulumi/src/railway/__tests__/client.test.ts`

**Reference:** `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/client.ts`

- [ ] **Step 1: Write failing tests**

`packages/pulumi/src/railway/__tests__/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RailwayClient } from "../client";

describe("RailwayClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GraphQL query with auth header and returns data", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: { me: { id: "user-1" } } }),
		});

		const client = new RailwayClient("test-token");
		const result = await client.query<{ me: { id: string } }>("{ me { id } }");

		expect(result.me.id).toBe("user-1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].headers.Authorization).toBe("Bearer test-token");
	});

	it("throws on GraphQL errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					errors: [{ message: "Project not found" }],
				}),
		});

		const client = new RailwayClient("test-token");

		await expect(client.query("{ project }")).rejects.toThrow(
			"Project not found",
		);
	});

	it("throws on non-200 HTTP status", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		});

		const client = new RailwayClient("test-token");

		await expect(client.query("{ me }")).rejects.toThrow("401");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test --filter=@infracraft/pulumi`
Expected: FAIL — `RailwayClient` not found.

- [ ] **Step 3: Implement RailwayClient**

Copy from `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/client.ts`. No changes needed — the class is already fully generic. Ensure it exports `RailwayClient`.

- [ ] **Step 4: Run tests to verify they pass**

Expected: All 3 client tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/railway/client.ts packages/pulumi/src/railway/__tests__/client.test.ts
git commit -m "feat(railway): add GraphQL client with error handling"
```

---

## Task 7: Railway providers (project, service, variable, volume, domain)

**Files:**
- Create: `packages/pulumi/src/railway/project.ts`
- Create: `packages/pulumi/src/railway/service.ts`
- Create: `packages/pulumi/src/railway/variable.ts`
- Create: `packages/pulumi/src/railway/volume.ts`
- Create: `packages/pulumi/src/railway/domain.ts`

**Reference:**
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/project.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/service.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/variable.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/volume.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/domain.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/discover.ts`

**Key changes from reference code:**

### project.ts
- Absorb project discovery logic from `discover.ts`: workspace query, project lookup by name, environment listing, project token creation.
- `RailwayProject` stays a `dynamic.Resource` but its `create()` now:
  1. Queries workspaces to find project by name (adopt) or creates it.
  2. Fetches all environments from the project.
  3. Creates/reuses a project-scoped token named `"pulumi"`.
  4. Returns `projectId`, `productionEnvironmentId`, `projectToken` as outputs.
- `read()` re-fetches project metadata, environments, and token.
- All outputs that are secrets use `pulumi.secret()`.
- Type URN: used internally by the dynamic provider, externally consumers just see `RailwayProject`.
- Remove `execSync('pulumi config set')` — the library never writes to consumer's Pulumi config.

### service.ts
- Convert from `ComponentResource` with `static async create()` to `dynamic.Resource` with standard constructor `new RailwayService(name, args, opts)`.
- Move `ensureService` logic into `RailwayServiceProvider.create()`:
  1. Query all services by project ID.
  2. Find by name → adopt. Not found → create via `serviceCreate` mutation.
  3. Apply service config (builder, startCommand, healthcheck, etc.) via `serviceInstanceUpdate`.
- `serviceId` becomes an output: `public declare readonly serviceId: pulumi.Output<string>`.
- Remove `isDryRun()` check — `dynamic.Resource.create()` is never called during preview.
- `read()` re-queries service by ID.
- `delete()` calls `serviceDelete`.
- `diff()` compares name, projectId — changes trigger replace.

### variable.ts, volume.ts, domain.ts
- Copy directly from reference. These are already fully generic.
- Ensure all args interfaces wrap properties in `pulumi.Input<T>`.
- Verify type URNs are not hardcoded (dynamic providers don't use type URNs — only ComponentResources do).

- [ ] **Step 1: Implement project.ts**

Read the reference files (`project.ts` and `discover.ts`) and merge the discovery logic into the project resource. The `create()` method should:
1. Use `RailwayClient` to query workspaces for the project by name.
2. If found, adopt it. If not, create via `projectCreate` mutation.
3. Fetch environments with `project.environments.edges` query.
4. Create/reuse a project token via `projectTokens` query + `projectTokenCreate` mutation.
5. Return `{ projectId, productionEnvironmentId, projectToken, ...inputs }`.

Export `RailwayProject` class with outputs:
```ts
public declare readonly projectId: pulumi.Output<string>;
public declare readonly productionEnvironmentId: pulumi.Output<string>;
public declare readonly projectToken: pulumi.Output<string>;
```

- [ ] **Step 2: Implement service.ts**

Read the reference `service.ts`. Restructure as a `dynamic.Resource`:
- `RailwayServiceProvider.create()`: query services, find by name or create, apply instance config, return `{ serviceId, ...inputs }`.
- `RailwayServiceProvider.read()`: re-query service by stored ID.
- `RailwayServiceProvider.delete()`: call `serviceDelete` mutation.
- `RailwayServiceProvider.diff()`: compare name, projectId, environmentId — trigger replace on change.

Export `RailwayService` with:
```ts
public declare readonly serviceId: pulumi.Output<string>;
```

- [ ] **Step 3: Copy variable.ts**

Copy from reference. Verify `RailwayVariableInputs` wraps all properties. No structural changes needed.

- [ ] **Step 4: Copy volume.ts**

Copy from reference. No structural changes needed.

- [ ] **Step 5: Copy domain.ts**

Copy from reference. No structural changes needed.

- [ ] **Step 6: Typecheck**

Run: `cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run typecheck`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/pulumi/src/railway/project.ts packages/pulumi/src/railway/service.ts packages/pulumi/src/railway/variable.ts packages/pulumi/src/railway/volume.ts packages/pulumi/src/railway/domain.ts
git commit -m "feat(railway): add project, service, variable, volume, domain providers"
```

---

## Task 8: Railway deploy + index exports

**Files:**
- Create: `packages/pulumi/src/railway/deploy.ts`
- Modify: `packages/pulumi/src/railway/index.ts`

**Reference:** `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/railway/deploy.ts`

**Key changes from reference:**
- Type URN: `infracraft:railway:Deploy`
- Constructor calls `this.registerOutputs()` at the end.
- Child resources use `{ parent: this }` and derive names from `${name}-suffix`.
- Uses `hashDirectory` from `../hash` (internal import, not from a separate package).

- [ ] **Step 1: Implement deploy.ts**

Copy from reference and apply these changes:
1. Change `super()` type URN to `"infracraft:railway:Deploy"`.
2. Add `this.registerOutputs({ deploy: this.deploy })` as last line of constructor.
3. All child `command.local.Command` resources get `{ parent: this }` and names derived from `${name}`.
4. Import `hashDirectory` from `"../hash"`.
5. Accept `ComponentResourceOptions` as third parameter.
6. Export `RailwayDeployConfig` type for consumer convenience.

- [ ] **Step 2: Write railway/index.ts exports**

`packages/pulumi/src/railway/index.ts`:

```ts
export { RailwayClient } from "./client";
export { RailwayProject } from "./project";
export type { RailwayProjectInputs } from "./project";
export { RailwayService } from "./service";
export type { RailwayServiceInputs } from "./service";
export { RailwayVariable } from "./variable";
export type { RailwayVariableInputs } from "./variable";
export { RailwayVolume } from "./volume";
export type { RailwayVolumeInputs } from "./volume";
export { RailwayDomain } from "./domain";
export type { RailwayDomainInputs } from "./domain";
export { RailwayDeploy } from "./deploy";
export type { RailwayDeployConfig } from "./deploy";
```

- [ ] **Step 3: Build and typecheck**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run build && bun run typecheck
```

Expected: Clean build with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/pulumi/src/railway/deploy.ts packages/pulumi/src/railway/index.ts
git commit -m "feat(railway): add deploy component and public exports"
```

---

## Task 9: Neon client + tests

**Files:**
- Create: `packages/pulumi/src/neon/client.ts`
- Create: `packages/pulumi/src/neon/__tests__/client.test.ts`

**Reference:** `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/client.ts`

- [ ] **Step 1: Write failing tests**

`packages/pulumi/src/neon/__tests__/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { NeonClient } from "../client";

describe("NeonClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GET request with auth header and returns parsed JSON", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ projects: [] }),
		});

		const client = new NeonClient("test-api-key");
		const result = await client.get<{ projects: unknown[] }>("/projects");

		expect(result.projects).toEqual([]);

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toContain("/projects");
		expect(call[1].headers.Authorization).toBe("Bearer test-api-key");
	});

	it("sends POST request with body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ project: { id: "proj-1" } }),
		});

		const client = new NeonClient("test-api-key");
		const result = await client.post<{ project: { id: string } }>(
			"/projects",
			{ project: { name: "test" } },
		);

		expect(result.project.id).toBe("proj-1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("POST");
		expect(JSON.parse(call[1].body)).toEqual({ project: { name: "test" } });
	});

	it("throws on non-200 HTTP status", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: () => Promise.resolve("Not found"),
		});

		const client = new NeonClient("test-api-key");

		await expect(client.get("/projects/invalid")).rejects.toThrow("404");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `NeonClient` not found.

- [ ] **Step 3: Implement NeonClient**

Copy from reference. No changes needed — fully generic.

- [ ] **Step 4: Run tests to verify they pass**

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/neon/client.ts packages/pulumi/src/neon/__tests__/client.test.ts
git commit -m "feat(neon): add REST client with error handling"
```

---

## Task 10: Neon providers + index exports

**Files:**
- Create: `packages/pulumi/src/neon/project.ts`
- Create: `packages/pulumi/src/neon/branch.ts`
- Create: `packages/pulumi/src/neon/endpoint.ts`
- Create: `packages/pulumi/src/neon/role.ts`
- Create: `packages/pulumi/src/neon/database.ts`
- Modify: `packages/pulumi/src/neon/index.ts`

**Reference:**
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/branch.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/endpoint.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/role.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/providers/neon/database.ts`
- `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/stacks/database.ts` (for `findOrCreateNeonProject` logic)

**Key changes:**

### project.ts (NEW — no reference file exists)
- New `dynamic.Resource` implementing adopt-or-create for Neon projects.
- `create()`: query `GET /projects` (optionally with `org_id`), find by name, adopt or `POST /projects`.
- Outputs: `projectId: pulumi.Output<string>`.
- `read()`: `GET /projects/{id}` to verify existence.
- `delete()`: no-op with warning (don't delete production databases).
- `diff()`: name change triggers replace.

### branch.ts, endpoint.ts, role.ts, database.ts
- Copy directly from reference. Already fully generic with adopt-or-create.

- [ ] **Step 1: Implement NeonProject**

Create `packages/pulumi/src/neon/project.ts` — a new `dynamic.Resource`. Extract the `findOrCreateNeonProject` logic from `/Users/andrevictor/www/HAT-CREW/nodex/infrastructure/stacks/database.ts` (lines 29-57) into the provider's `create()` method.

Inputs: `{ apiKey, name, orgId? }`
Outputs: `{ ...inputs, projectId }`

- [ ] **Step 2: Copy branch.ts, endpoint.ts, role.ts, database.ts**

Copy each from reference. No structural changes needed. Verify all args use `pulumi.Input<T>`.

- [ ] **Step 3: Write neon/index.ts exports**

```ts
export { NeonClient } from "./client";
export { NeonProject } from "./project";
export type { NeonProjectInputs } from "./project";
export { NeonBranch } from "./branch";
export type { NeonBranchInputs } from "./branch";
export { NeonEndpoint } from "./endpoint";
export type { NeonEndpointInputs } from "./endpoint";
export { NeonRole } from "./role";
export type { NeonRoleInputs } from "./role";
export { NeonDatabase } from "./database";
export type { NeonDatabaseInputs } from "./database";
```

- [ ] **Step 4: Build and typecheck**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run build && bun run typecheck
```

Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/neon/
git commit -m "feat(neon): add project, branch, endpoint, role, database providers"
```

---

## Task 11: Vercel providers + index exports

**Files:**
- Create: `packages/pulumi/src/vercel/variable.ts`
- Create: `packages/pulumi/src/vercel/deploy.ts`
- Modify: `packages/pulumi/src/vercel/index.ts`

**Reference:**
- `/Users/andrevictor/www/HAT-CREW/mlm-rby/infrastructure/providers/vercel/variable.ts`
- `/Users/andrevictor/www/HAT-CREW/mlm-rby/infrastructure/providers/vercel/deploy.ts`

**Key changes from reference:**

### variable.ts
- Copy from reference. Already a `dynamic.Resource` with full CRUD.
- Remove the unused `createEnvironmentVariables` helper function and `VercelTarget` enum from `deploy.ts` — they are dead code.

### deploy.ts
- Change type URN to `"infracraft:vercel:Deploy"`.
- Add `this.registerOutputs()` at end of constructor.
- Child `command.local.Command` gets `{ parent: this }` and name derived from `${name}`.
- Import `hashDirectory` from `"../hash"`.
- Remove `createEnvironmentVariables` function and `VercelTarget` enum (unused dead code).

- [ ] **Step 1: Implement variable.ts**

Copy from reference. Clean up unused code. Ensure all inputs wrapped in `pulumi.Input<T>`.

- [ ] **Step 2: Implement deploy.ts**

Copy from reference and apply changes:
1. Type URN: `"infracraft:vercel:Deploy"`.
2. `this.registerOutputs({})` at end of constructor.
3. Child command: `{ parent: this }`, name: `${name}-deploy`.
4. Import `hashDirectory` from `"../hash"`.
5. Remove `createEnvironmentVariables` and `VercelTarget` (dead code).

- [ ] **Step 3: Write vercel/index.ts exports**

```ts
export { VercelVariable } from "./variable";
export type { VercelVariableInputs } from "./variable";
export { VercelDeploy } from "./deploy";
export type { VercelDeployArgs } from "./deploy";
```

- [ ] **Step 4: Build and typecheck**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run build && bun run typecheck
```

Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/pulumi/src/vercel/
git commit -m "feat(vercel): add variable and deploy providers"
```

---

## Task 12: Final integration — lint, test, build, CI

**Files:**
- Modify: `packages/pulumi/src/railway/index.ts` (verify)
- Modify: `packages/pulumi/src/neon/index.ts` (verify)
- Modify: `packages/pulumi/src/vercel/index.ts` (verify)
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Run full lint**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run lint
```

Fix any lint errors or warnings. Zero warnings allowed.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run test
```

Expected: All tests pass (hash: 4, git-guard: 4, railway client: 3, neon client: 3 = 14 tests).

- [ ] **Step 3: Run full build**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run build
```

Expected: All packages build clean. `packages/pulumi/dist/` contains all subpath entry points.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run typecheck
```

Expected: No type errors.

- [ ] **Step 5: Run knip**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft && bun run knip
```

Expected: No unused files, deps, or exports.

- [ ] **Step 6: Create CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"

      - run: bun install --frozen-lockfile

      - run: bun run build

      - run: bun run typecheck

      - run: bun run lint

      - run: bun run test

      - run: bun run knip
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: add CI workflow and verify full pipeline"
```

- [ ] **Step 8: Verify dist structure**

Verify that `packages/pulumi/dist/` contains the expected entry points:
```
dist/
  railway/
    index.mjs
    index.d.mts
  neon/
    index.mjs
    index.d.mts
  vercel/
    index.mjs
    index.d.mts
  hash.mjs
  hash.d.mts
  git-guard.mjs
  git-guard.d.mts
```

---

## Summary

| Task | Description | Commits |
|------|-------------|---------|
| 1 | Root monorepo scaffolding | 1 |
| 2 | Config packages (typescript, tsdown, test) | 1 |
| 3 | @infracraft/pulumi package scaffolding | 1 |
| 4 | hashDirectory + tests | 1 |
| 5 | gitGuard + tests | 1 |
| 6 | Railway client + tests | 1 |
| 7 | Railway providers (project, service, variable, volume, domain) | 1 |
| 8 | Railway deploy + index exports | 1 |
| 9 | Neon client + tests | 1 |
| 10 | Neon providers + index exports | 1 |
| 11 | Vercel providers + index exports | 1 |
| 12 | Final integration — lint, test, build, CI | 1 |

**Total: 12 tasks, 12 commits, ~18 source files + 4 test files**
