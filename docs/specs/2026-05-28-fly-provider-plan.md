# Fly.io Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hand-rolled Fly.io provider to `@infracraft/pulumi` that provisions Fly apps, secrets, volumes, certificates, dedicated IPs, and deployments — following the exact context-based, three-layer pattern of the Railway/Neon/Vercel providers.

**Architecture:** Each public resource is a `pulumi.ComponentResource` wrapping an internal `pulumi.dynamic.Resource`. A `FlyProvider` ComponentResource carries credentials. Apps/secrets/volumes/certs talk to the Machines REST API (`https://api.machines.dev`) via a typed `FlyClient`; dedicated IPs use the Fly GraphQL API through `FlyClient.graphql()`; deployment is a `FlyDeploy` ComponentResource that shells out to `fly deploy` via `@pulumi/command`, fed by a typed `generateFlyToml()` config builder.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `@pulumi/pulumi` ^3, `@pulumi/command` ^1, tsdown (build), vitest (test), Biome (lint), bun@1.3.14 (package manager).

---

## Conventions (read before starting)

These are non-negotiable; every task assumes them.

- **Imports use `.js` extensions** for local files: `import type { FlyProvider } from "./provider.js"`.
- **Indentation is tabs** (Biome enforces). Code blocks below use tabs.
- **Three-layer file structure** per resource, all internal pieces unexported:
  1. exported `<Name>Inputs` (resolved, no `pulumi.Input`),
  2. internal `<Name>Outputs extends <Name>Inputs`,
  3. internal `<Name>ResourceProvider implements pulumi.dynamic.ResourceProvider`,
  4. internal `<Name>Resource extends pulumi.dynamic.Resource`,
  5. internal `<Name>Options = Omit<pulumi.ComponentResourceOptions, "provider"> & { provider: FlyProvider; app?: FlyApp }`,
  6. exported `<Name>Args` (public `pulumi.Input` args; **no** credentials/IDs — those come from `opts`),
  7. exported `class <Name> extends pulumi.ComponentResource`.
- **URN types:** `infracraft:fly:<Name>` (e.g. `infracraft:fly:App`).
- **Output remapping to `.id`:** the public ComponentResource exposes the platform ID as `.id`. Non-ID outputs keep descriptive names (`version`, `configured`, `dnsRequirements`).
- **`index.ts` exports only** public classes + their `Args` types (and toml enums/types). Never export internal `Inputs`/`Outputs`/`*Resource`/`*ResourceProvider`.
- **Secrets** are wrapped with `pulumi.secret()` on the provider token and on any stored secret values.
- **Commit style:** `feat(fly): <what>` per task.

**Testing posture (matches the existing package):** Only the exported **client class** and **pure functions** are unit-tested (see `neon/__tests__/client.test.ts`; vercel ships resource files with no tests). So Tasks 1 (`FlyClient`) and 3 (`generateFlyToml`) get full red→green TDD. The dynamic/component resource files (Tasks 2, 4–9) are template applications whose only external I/O goes through the already-tested `FlyClient`; they gate on `bun run typecheck` + `bun run build` + `bun run lint`, exactly like the vercel resource files do.

**Run commands (all from the package directory):**

```bash
cd /Users/andrevictor/www/Andre-Dezzy/infracraft/packages/pulumi
```

- Single test file: `bun run test src/fly/__tests__/<file>.test.ts`
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Lint + format: `bun run lint`

---

## File Structure

```
packages/pulumi/src/fly/
  client.ts        FlyClient — Machines REST (get/tryGet/post/put/delete) + graphql()
  provider.ts      FlyProvider — credential holder (token + optional organization)
  app.ts           FlyApp + FlyAppResource (adopt-or-create; delete no-op; .id = name)
  secret.ts        FlySecret + FlySecretResource (bulk REST; .version output)
  volume.ts        FlyVolume + FlyVolumeResource (adopt-by-name; extend on grow; .id = vol_…)
  certificate.ts   FlyCertificate + FlyCertificateResource (ACME; hostname key)
  ip.ts            FlyIp + FlyIpResource (GraphQL allocate/release; .id = address)
  toml.ts          enums + FlyTomlConfig + generateFlyToml()
  deploy.ts        FlyDeploy (ComponentResource → fly deploy)
  index.ts         public exports
  __tests__/
    client.test.ts
    toml.test.ts
```

Modified files: `tsdown.config.ts` (entry), `package.json` (exports), root `.gitignore` (`.fly/`), `README.md` (Fly section).

---

### Task 1: FlyClient

**Files:**
- Create: `packages/pulumi/src/fly/client.ts`
- Test: `packages/pulumi/src/fly/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pulumi/src/fly/__tests__/client.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlyClient } from "../client";

describe("FlyClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GET to the Machines API with a bearer token", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ name: "my-app" })),
		});

		const client = new FlyClient("test-token");
		const result = await client.get<{ name: string }>("/v1/apps/my-app");

		expect(result.name).toBe("my-app");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("https://api.machines.dev/v1/apps/my-app");
		expect(call[1].headers.Authorization).toBe("Bearer test-token");
	});

	it("tryGet returns null on 404 and throws on other errors", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("nope") })
			.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") });

		const client = new FlyClient("test-token");

		await expect(client.tryGet("/v1/apps/missing")).resolves.toBeNull();
		await expect(client.tryGet("/v1/apps/broken")).rejects.toThrow("500");
	});

	it("sends POST with a JSON body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 201,
			text: () => Promise.resolve(JSON.stringify({ id: "z4k69" })),
		});

		const client = new FlyClient("test-token");
		const result = await client.post<{ id: string }>("/v1/apps", {
			app_name: "x",
			org_slug: "personal",
		});

		expect(result.id).toBe("z4k69");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("POST");
		expect(JSON.parse(call[1].body)).toEqual({ app_name: "x", org_slug: "personal" });
	});

	it("sends PUT with a JSON body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ needs_restart: false })),
		});

		const client = new FlyClient("test-token");
		const result = await client.put<{ needs_restart: boolean }>(
			"/v1/apps/x/volumes/vol_123/extend",
			{ size_gb: 20 },
		);

		expect(result.needs_restart).toBe(false);

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("PUT");
		expect(JSON.parse(call[1].body)).toEqual({ size_gb: 20 });
	});

	it("returns undefined for empty bodies (202/204)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			text: () => Promise.resolve(""),
		});

		const client = new FlyClient("test-token");
		await expect(client.delete("/v1/apps/x/certificates/h")).resolves.toBeUndefined();
	});

	it("throws on non-2xx REST responses", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 422,
			text: () => Promise.resolve("Unprocessable"),
		});

		const client = new FlyClient("test-token");
		await expect(client.post("/v1/apps", {})).rejects.toThrow("422");
	});

	it("graphql posts to the GraphQL endpoint and unwraps data", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ data: { app: { name: "a" } } })),
		});

		const client = new FlyClient("test-token");
		const data = await client.graphql<{ app: { name: string } }>("query { app { name } }", {});

		expect(data.app.name).toBe("a");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("https://api.fly.io/graphql");
		expect(JSON.parse(call[1].body).query).toContain("app");
	});

	it("graphql throws when the response contains errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ errors: [{ message: "bad query" }] })),
		});

		const client = new FlyClient("test-token");
		await expect(client.graphql("query {}", {})).rejects.toThrow("bad query");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/fly/__tests__/client.test.ts`
Expected: FAIL — `Cannot find module '../client'`.

- [ ] **Step 3: Write the implementation**

Create `packages/pulumi/src/fly/client.ts`:

```typescript
const FLY_MACHINES_API_URL = "https://api.machines.dev";
const FLY_GRAPHQL_API_URL = "https://api.fly.io/graphql";

/** Shape of a Fly GraphQL response envelope. */
interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

/**
 * Typed client for the Fly.io Machines REST API and the Fly GraphQL API.
 *
 * REST calls target `https://api.machines.dev`; `graphql()` targets
 * `https://api.fly.io/graphql`. Both authenticate with the same bearer token.
 *
 * @example
 * ```typescript
 * const client = new FlyClient(token);
 * const app = await client.tryGet<{ name: string }>("/v1/apps/my-app");
 * ```
 */
export class FlyClient {
	/** Fly API token used for both REST and GraphQL auth. */
	private readonly token: string;

	/**
	 * @param token Fly API token (e.g. from `fly tokens create deploy`)
	 */
	constructor(token: string) {
		this.token = token;
	}

	/**
	 * GET a Machines API resource.
	 * @throws {Error} On any non-2xx status (including 404).
	 */
	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	/**
	 * GET a Machines API resource, returning `null` on 404.
	 * Used by adopt-or-create resources to detect existence.
	 * @throws {Error} On non-2xx statuses other than 404.
	 */
	async tryGet<T>(path: string): Promise<T | null> {
		const response = await fetch(`${FLY_MACHINES_API_URL}${path}`, {
			method: "GET",
			headers: this.headers(),
		});

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			throw new Error(
				`Fly API error (${response.status}): ${await response.text()}`,
			);
		}

		const text = await response.text();

		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** POST to a Machines API resource. */
	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	/** PUT to a Machines API resource. */
	async put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	/**
	 * DELETE a Machines API resource. Returns the parsed body when present
	 * (some Fly deletes return the deleted object), or `undefined` for
	 * empty 202/204 responses.
	 */
	async delete<T = void>(path: string): Promise<T> {
		return this.request<T>("DELETE", path);
	}

	/**
	 * Execute a Fly GraphQL query/mutation.
	 * @throws {Error} On transport errors or a non-empty `errors` array.
	 */
	async graphql<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		const response = await fetch(FLY_GRAPHQL_API_URL, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			throw new Error(
				`Fly GraphQL error (${response.status}): ${await response.text()}`,
			);
		}

		const text = await response.text();
		const json = (text ? JSON.parse(text) : {}) as GraphQLResponse<T>;

		if (json.errors && json.errors.length > 0) {
			throw new Error(
				`Fly GraphQL error: ${json.errors.map((error) => error.message).join("; ")}`,
			);
		}

		return json.data as T;
	}

	private headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`,
		};
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const response = await fetch(`${FLY_MACHINES_API_URL}${path}`, {
			method,
			headers: this.headers(),
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			throw new Error(
				`Fly API error (${response.status}): ${await response.text()}`,
			);
		}

		const text = await response.text();

		return (text ? JSON.parse(text) : undefined) as T;
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/fly/__tests__/client.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/fly/client.ts src/fly/__tests__/client.test.ts
git commit -m "feat(fly): add FlyClient for Machines REST + GraphQL"
```

---

### Task 2: FlyProvider

**Files:**
- Create: `packages/pulumi/src/fly/provider.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/provider.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

/** Args for FlyProvider. */
export interface FlyProviderArgs {
	/** Fly API token (e.g. from `fly tokens create deploy`). */
	token: pulumi.Input<string>;

	/**
	 * Default Fly organization slug used when creating new apps.
	 * Can be overridden per-app via `FlyAppArgs.organization`.
	 */
	organization?: pulumi.Input<string>;
}

/**
 * Holds Fly authentication context. Passed to every Fly resource via the
 * `provider` field of its options object.
 *
 * @example
 * ```typescript
 * const provider = new FlyProvider("fly", {
 *   token: config.requireSecret("flyToken"),
 *   organization: "personal",
 * });
 * ```
 */
export class FlyProvider extends pulumi.ComponentResource {
	/** Fly API token (secret). */
	public readonly token: pulumi.Output<string>;

	/** Default organization slug for app creation, or `undefined`. */
	public readonly organization: pulumi.Output<string | undefined>;

	constructor(
		name: string,
		args: FlyProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:fly:Provider", name, {}, opts);

		this.token = pulumi.secret(pulumi.output(args.token));
		this.organization = pulumi.output(args.organization);

		this.registerOutputs({
			token: this.token,
			organization: this.organization,
		});
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/fly/provider.ts
git commit -m "feat(fly): add FlyProvider credential holder"
```

---

### Task 3: fly.toml config + generateFlyToml

**Files:**
- Create: `packages/pulumi/src/fly/toml.ts`
- Test: `packages/pulumi/src/fly/__tests__/toml.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pulumi/src/fly/__tests__/toml.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
	FlyAutoStopMachines,
	FlyConcurrencyType,
	FlyCpuKind,
	FlyDeployStrategy,
	FlyRestartPolicy,
	generateFlyToml,
	type FlyTomlConfig,
} from "../toml";

describe("generateFlyToml", () => {
	it("emits a minimal config", () => {
		const toml = generateFlyToml({ app: "rby-api", primaryRegion: "iad" });

		expect(toml).toContain('app = "rby-api"');
		expect(toml).toContain('primary_region = "iad"');
	});

	it("emits build, env and processes sections", () => {
		const config: FlyTomlConfig = {
			app: "rby-api",
			primaryRegion: "iad",
			build: { dockerfile: "apps/api/Dockerfile" },
			env: { PORT: "3333", NODE_ENV: "production" },
			processes: { app: "node dist/index.js" },
		};

		const toml = generateFlyToml(config);

		expect(toml).toContain("[build]");
		expect(toml).toContain('dockerfile = "apps/api/Dockerfile"');
		expect(toml).toContain("[env]");
		expect(toml).toContain('PORT = "3333"');
		expect(toml).toContain("[processes]");
		expect(toml).toContain('app = "node dist/index.js"');
	});

	it("emits http_service with concurrency and checks", () => {
		const config: FlyTomlConfig = {
			app: "rby-api",
			primaryRegion: "iad",
			httpService: {
				internalPort: 3333,
				forceHttps: true,
				autoStopMachines: FlyAutoStopMachines.OFF,
				autoStartMachines: true,
				minMachinesRunning: 1,
				concurrency: { type: FlyConcurrencyType.REQUESTS, softLimit: 200, hardLimit: 250 },
				checks: [
					{ method: "GET", path: "/health", interval: "30s", timeout: "10s", gracePeriod: "120s" },
				],
			},
		};

		const toml = generateFlyToml(config);

		expect(toml).toContain("[http_service]");
		expect(toml).toContain("internal_port = 3333");
		expect(toml).toContain("force_https = true");
		expect(toml).toContain('auto_stop_machines = "off"');
		expect(toml).toContain("auto_start_machines = true");
		expect(toml).toContain("min_machines_running = 1");
		expect(toml).toContain("[http_service.concurrency]");
		expect(toml).toContain('type = "requests"');
		expect(toml).toContain("soft_limit = 200");
		expect(toml).toContain("hard_limit = 250");
		expect(toml).toContain("[[http_service.checks]]");
		expect(toml).toContain('method = "GET"');
		expect(toml).toContain('path = "/health"');
	});

	it("emits mounts, vm (without count), deploy and restart", () => {
		const config: FlyTomlConfig = {
			app: "rby-redis",
			primaryRegion: "iad",
			mounts: [{ source: "redis_data", destination: "/data", processes: ["app"] }],
			vm: [{ size: "shared-cpu-1x", memory: "256mb", cpuKind: FlyCpuKind.SHARED, cpus: 1 }],
			deploy: { strategy: FlyDeployStrategy.BLUEGREEN, releaseCommand: "node scripts/migrate.js" },
			restart: { policy: FlyRestartPolicy.ON_FAILURE, retries: 5 },
		};

		const toml = generateFlyToml(config);

		expect(toml).toContain("[[mounts]]");
		expect(toml).toContain('source = "redis_data"');
		expect(toml).toContain('destination = "/data"');
		expect(toml).toContain('processes = ["app"]');
		expect(toml).toContain("[[vm]]");
		expect(toml).toContain('size = "shared-cpu-1x"');
		expect(toml).toContain('memory = "256mb"');
		expect(toml).toContain('cpu_kind = "shared"');
		expect(toml).toContain("cpus = 1");
		expect(toml).not.toContain("count =");
		expect(toml).toContain("[deploy]");
		expect(toml).toContain('strategy = "bluegreen"');
		expect(toml).toContain('release_command = "node scripts/migrate.js"');
		expect(toml).toContain("[[restart]]");
		expect(toml).toContain('policy = "on-failure"');
		expect(toml).toContain("retries = 5");
	});

	it("escapes double quotes in string values", () => {
		const toml = generateFlyToml({
			app: "x",
			primaryRegion: "iad",
			processes: { app: 'sh -c "echo hi"' },
		});

		expect(toml).toContain('app = "sh -c \\"echo hi\\""');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/fly/__tests__/toml.test.ts`
Expected: FAIL — `Cannot find module '../toml'`.

- [ ] **Step 3: Write the implementation**

Create `packages/pulumi/src/fly/toml.ts`:

```typescript
/**
 * fly.toml deploy strategy. Enum keys are UPPERCASE per convention; values are
 * Fly's required lowercase wire literals (external format — cannot be uppercased).
 */
export enum FlyDeployStrategy {
	ROLLING = "rolling",
	IMMEDIATE = "immediate",
	CANARY = "canary",
	BLUEGREEN = "bluegreen",
}

/** Machine restart policy. */
export enum FlyRestartPolicy {
	ALWAYS = "always",
	ON_FAILURE = "on-failure",
	NEVER = "never",
}

/** Idle-machine auto-stop behavior. */
export enum FlyAutoStopMachines {
	OFF = "off",
	STOP = "stop",
	SUSPEND = "suspend",
}

/** Concurrency limit unit. */
export enum FlyConcurrencyType {
	CONNECTIONS = "connections",
	REQUESTS = "requests",
}

/** Raw service protocol. */
export enum FlyServiceProtocol {
	TCP = "tcp",
	UDP = "udp",
}

/** Port handler. */
export enum FlyPortHandler {
	HTTP = "http",
	TLS = "tls",
	PROXY_PROTO = "proxy_proto",
}

/** VM CPU kind. */
export enum FlyCpuKind {
	SHARED = "shared",
	PERFORMANCE = "performance",
}

/** Health-check type. */
export enum FlyCheckType {
	HTTP = "http",
	TCP = "tcp",
}

/**
 * Fly region (IATA code). Common values are suggested for autocomplete; any
 * string is accepted because Fly adds regions over time (semi-open set).
 */
export type FlyRegion =
	| "iad"
	| "ord"
	| "lax"
	| "sea"
	| "lhr"
	| "fra"
	| "ams"
	| "cdg"
	| "syd"
	| "nrt"
	| "sin"
	| "gru"
	// biome-ignore lint/complexity/noBannedTypes: open union preserves literal autocomplete while accepting any region string
	| (string & {});

/** Fly machine size preset. Semi-open set — any string is accepted. */
export type FlyVmSize =
	| "shared-cpu-1x"
	| "shared-cpu-2x"
	| "shared-cpu-4x"
	| "shared-cpu-8x"
	| "performance-1x"
	| "performance-2x"
	| "performance-4x"
	| "performance-8x"
	// biome-ignore lint/complexity/noBannedTypes: open union preserves literal autocomplete while accepting any size string
	| (string & {});

/** A single health check. */
export interface FlyCheck {
	type?: FlyCheckType;
	port?: number;
	method?: string;
	path?: string;
	interval: string;
	timeout: string;
	gracePeriod?: string;
}

/** Concurrency configuration for a service. */
export interface FlyConcurrency {
	type: FlyConcurrencyType;
	softLimit: number;
	hardLimit: number;
}

/** `[build]` section. */
export interface FlyBuildConfig {
	dockerfile?: string;
	image?: string;
}

/** `[http_service]` section. */
export interface FlyHttpService {
	internalPort: number;
	forceHttps?: boolean;
	autoStopMachines?: FlyAutoStopMachines;
	autoStartMachines?: boolean;
	minMachinesRunning?: number;
	processes?: string[];
	concurrency?: FlyConcurrency;
	checks?: FlyCheck[];
}

/** A `[[services.ports]]` entry. */
export interface FlyServicePort {
	port: number;
	handlers?: FlyPortHandler[];
}

/** A `[[services]]` entry. */
export interface FlyService {
	internalPort: number;
	protocol: FlyServiceProtocol;
	autoStopMachines?: FlyAutoStopMachines;
	autoStartMachines?: boolean;
	minMachinesRunning?: number;
	processes?: string[];
	ports: FlyServicePort[];
	concurrency?: FlyConcurrency;
	checks?: FlyCheck[];
}

/** A `[[mounts]]` entry. */
export interface FlyMount {
	source: string;
	destination: string;
	processes?: string[];
	initialSize?: string;
}

/** A `[[vm]]` entry. `count` is intentionally absent — machine count is set via `fly scale`. */
export interface FlyVm {
	size?: FlyVmSize;
	memory?: string;
	cpuKind?: FlyCpuKind;
	cpus?: number;
	processes?: string[];
}

/** `[deploy]` section. */
export interface FlyDeployConfig {
	strategy?: FlyDeployStrategy;
	releaseCommand?: string;
}

/** A `[[restart]]` entry. */
export interface FlyRestartConfig {
	policy?: FlyRestartPolicy;
	retries?: number;
	processes?: string[];
}

/**
 * Typed fly.toml configuration. All fields are plain values (NOT `pulumi.Input`)
 * because `generateFlyToml()` runs synchronously to write the toml file — resolve
 * any `Output` before constructing this object.
 */
export interface FlyTomlConfig {
	app: string;
	primaryRegion: FlyRegion;
	build?: FlyBuildConfig;
	env?: Record<string, string>;
	processes?: Record<string, string>;
	httpService?: FlyHttpService;
	services?: FlyService[];
	mounts?: FlyMount[];
	vm?: FlyVm[];
	deploy?: FlyDeployConfig;
	restart?: FlyRestartConfig;
	checks?: Record<string, FlyCheck>;
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function array(values: string[]): string {
	return `[${values.map((value) => quote(value)).join(", ")}]`;
}

function pushCheck(lines: string[], header: string, check: FlyCheck): void {
	lines.push("", header);

	if (check.type !== undefined) lines.push(`    type = ${quote(check.type)}`);
	if (check.port !== undefined) lines.push(`    port = ${check.port}`);
	if (check.method !== undefined) lines.push(`    method = ${quote(check.method)}`);
	if (check.path !== undefined) lines.push(`    path = ${quote(check.path)}`);

	lines.push(`    interval = ${quote(check.interval)}`);
	lines.push(`    timeout = ${quote(check.timeout)}`);

	if (check.gracePeriod !== undefined)
		lines.push(`    grace_period = ${quote(check.gracePeriod)}`);
}

function pushConcurrency(
	lines: string[],
	header: string,
	concurrency: FlyConcurrency,
): void {
	lines.push("", header);
	lines.push(`    type = ${quote(concurrency.type)}`);
	lines.push(`    soft_limit = ${concurrency.softLimit}`);
	lines.push(`    hard_limit = ${concurrency.hardLimit}`);
}

/**
 * Serializes a {@link FlyTomlConfig} into fly.toml text.
 *
 * Field names are camelCase on the TypeScript side and emitted as Fly's
 * snake_case toml keys. Output is deterministic (stable section ordering) so it
 * can be used directly as a `FlyDeploy` redeploy trigger.
 */
export function generateFlyToml(config: FlyTomlConfig): string {
	const lines: string[] = [];

	lines.push(`app = ${quote(config.app)}`);
	lines.push(`primary_region = ${quote(config.primaryRegion)}`);

	if (config.build) {
		lines.push("", "[build]");
		if (config.build.dockerfile !== undefined)
			lines.push(`  dockerfile = ${quote(config.build.dockerfile)}`);
		if (config.build.image !== undefined)
			lines.push(`  image = ${quote(config.build.image)}`);
	}

	if (config.env) {
		lines.push("", "[env]");
		for (const [key, value] of Object.entries(config.env)) {
			lines.push(`  ${key} = ${quote(value)}`);
		}
	}

	if (config.processes) {
		lines.push("", "[processes]");
		for (const [key, value] of Object.entries(config.processes)) {
			lines.push(`  ${key} = ${quote(value)}`);
		}
	}

	if (config.httpService) {
		const service = config.httpService;

		lines.push("", "[http_service]");
		lines.push(`  internal_port = ${service.internalPort}`);

		if (service.forceHttps !== undefined)
			lines.push(`  force_https = ${service.forceHttps}`);
		if (service.autoStopMachines !== undefined)
			lines.push(`  auto_stop_machines = ${quote(service.autoStopMachines)}`);
		if (service.autoStartMachines !== undefined)
			lines.push(`  auto_start_machines = ${service.autoStartMachines}`);
		if (service.minMachinesRunning !== undefined)
			lines.push(`  min_machines_running = ${service.minMachinesRunning}`);
		if (service.processes !== undefined)
			lines.push(`  processes = ${array(service.processes)}`);

		if (service.concurrency)
			pushConcurrency(lines, "  [http_service.concurrency]", service.concurrency);

		if (service.checks) {
			for (const check of service.checks) {
				pushCheck(lines, "  [[http_service.checks]]", check);
			}
		}
	}

	if (config.services) {
		for (const service of config.services) {
			lines.push("", "[[services]]");
			lines.push(`  internal_port = ${service.internalPort}`);
			lines.push(`  protocol = ${quote(service.protocol)}`);

			if (service.autoStopMachines !== undefined)
				lines.push(`  auto_stop_machines = ${quote(service.autoStopMachines)}`);
			if (service.autoStartMachines !== undefined)
				lines.push(`  auto_start_machines = ${service.autoStartMachines}`);
			if (service.minMachinesRunning !== undefined)
				lines.push(`  min_machines_running = ${service.minMachinesRunning}`);
			if (service.processes !== undefined)
				lines.push(`  processes = ${array(service.processes)}`);

			for (const port of service.ports) {
				lines.push("", "  [[services.ports]]");
				lines.push(`    port = ${port.port}`);
				if (port.handlers !== undefined)
					lines.push(`    handlers = ${array(port.handlers)}`);
			}

			if (service.concurrency)
				pushConcurrency(lines, "  [services.concurrency]", service.concurrency);

			if (service.checks) {
				for (const check of service.checks) {
					pushCheck(lines, "  [[services.checks]]", check);
				}
			}
		}
	}

	if (config.mounts) {
		for (const mount of config.mounts) {
			lines.push("", "[[mounts]]");
			lines.push(`  source = ${quote(mount.source)}`);
			lines.push(`  destination = ${quote(mount.destination)}`);
			if (mount.processes !== undefined)
				lines.push(`  processes = ${array(mount.processes)}`);
			if (mount.initialSize !== undefined)
				lines.push(`  initial_size = ${quote(mount.initialSize)}`);
		}
	}

	if (config.vm) {
		for (const vm of config.vm) {
			lines.push("", "[[vm]]");
			if (vm.size !== undefined) lines.push(`  size = ${quote(vm.size)}`);
			if (vm.memory !== undefined) lines.push(`  memory = ${quote(vm.memory)}`);
			if (vm.cpuKind !== undefined) lines.push(`  cpu_kind = ${quote(vm.cpuKind)}`);
			if (vm.cpus !== undefined) lines.push(`  cpus = ${vm.cpus}`);
			if (vm.processes !== undefined)
				lines.push(`  processes = ${array(vm.processes)}`);
		}
	}

	if (config.deploy) {
		lines.push("", "[deploy]");
		if (config.deploy.strategy !== undefined)
			lines.push(`  strategy = ${quote(config.deploy.strategy)}`);
		if (config.deploy.releaseCommand !== undefined)
			lines.push(`  release_command = ${quote(config.deploy.releaseCommand)}`);
	}

	if (config.restart) {
		lines.push("", "[[restart]]");
		if (config.restart.policy !== undefined)
			lines.push(`  policy = ${quote(config.restart.policy)}`);
		if (config.restart.retries !== undefined)
			lines.push(`  retries = ${config.restart.retries}`);
		if (config.restart.processes !== undefined)
			lines.push(`  processes = ${array(config.restart.processes)}`);
	}

	if (config.checks) {
		for (const [checkName, check] of Object.entries(config.checks)) {
			pushCheck(lines, `[checks.${checkName}]`, check);
		}
	}

	return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/fly/__tests__/toml.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS, no errors/warnings. The `(string & {})` unions carry a `biome-ignore lint/complexity/noBannedTypes` suppression. If lint still warns, the installed Biome prints the exact rule id — correct the suppression's rule path to match and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/fly/toml.ts src/fly/__tests__/toml.test.ts
git commit -m "feat(fly): add typed fly.toml config and generateFlyToml"
```

---

### Task 4: FlyApp

**Files:**
- Create: `packages/pulumi/src/fly/app.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/app.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

import { FlyClient } from "./client.js";
import type { FlyProvider } from "./provider.js";

/** Resolved inputs for the Fly app dynamic provider. */
export interface FlyAppInputs {
	/** Fly API token. */
	token: string;

	/** App name (globally unique). Used as the resource identifier. */
	name: string;

	/** Org slug used only when creating a new app. */
	organization?: string;
}

/** Persisted state for the Fly app. */
interface FlyAppOutputs extends FlyAppInputs {
	/** App identifier — equals the app name (all child paths key off the name). */
	appId: string;
}

/** Get-app response (only the fields we read). */
interface FlyAppResponse {
	id: string;
	name: string;
}

/**
 * Dynamic provider implementing adopt-or-create for Fly apps.
 *
 * `create()` does `GET /v1/apps/{name}`; if found it adopts, otherwise it
 * `POST /v1/apps`. `delete()` is a no-op — deleting a Fly app destroys
 * everything in it, so (like Railway/Neon/Vercel top-level resources) Pulumi
 * does not delete apps.
 */
class FlyAppResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlyAppInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);
		const existing = await client.tryGet<FlyAppResponse>(`/v1/apps/${inputs.name}`);

		if (existing) {
			pulumi.log.info(`Adopting existing Fly app "${inputs.name}"`);
		} else {
			if (!inputs.organization) {
				throw new Error(
					`FlyApp "${inputs.name}": an organization is required to create a new app — set it on FlyProvider or FlyApp args`,
				);
			}

			pulumi.log.info(`Fly app "${inputs.name}" not found — creating...`);

			await client.post("/v1/apps", {
				app_name: inputs.name,
				org_slug: inputs.organization,
			});
		}

		const outs: FlyAppOutputs = { ...inputs, appId: inputs.name };

		return { id: inputs.name, outs };
	}

	async read(
		id: string,
		props: FlyAppOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);
		const app = await client.tryGet<FlyAppResponse>(`/v1/apps/${id}`);

		if (!app) {
			throw new Error(`Fly app "${id}" not found during refresh`);
		}

		return { id, props: { ...props, name: app.name, appId: app.name } };
	}

	async update(
		id: string,
		_olds: FlyAppOutputs,
		news: FlyAppInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		return { outs: { ...news, appId: id } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Fly app deletion skipped — apps are not deleted by Pulumi (would destroy all contained resources)",
		);
	}

	async diff(
		_id: string,
		olds: FlyAppOutputs,
		news: FlyAppInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) replaces.push("name");
		if (olds.organization !== news.organization) replaces.push("organization");

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyAppResource extends pulumi.dynamic.Resource {
	public declare readonly appId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			name: pulumi.Input<string>;
			organization?: pulumi.Input<string | undefined>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyAppResourceProvider(),
			name,
			{ ...args, appId: undefined },
			opts,
		);
	}
}

/** Options type for FlyApp — replaces Pulumi's native `provider` field. */
type FlyAppOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;
};

/** Args for FlyApp. */
export interface FlyAppArgs {
	/** App name (globally unique). Used for adoption lookup and as `.id`. */
	name: pulumi.Input<string>;

	/**
	 * Org slug for app creation. Overrides `FlyProvider.organization`.
	 * Ignored when the app already exists (adoption).
	 */
	organization?: pulumi.Input<string>;
}

/**
 * Manages a Fly app with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const app = new FlyApp("api", { name: "rby-api" }, { provider });
 * ```
 */
export class FlyApp extends pulumi.ComponentResource {
	/** App identifier (equals the app name). */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyAppArgs, opts: FlyAppOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:fly:App", name, {}, pulumiOpts);

		const resource = new FlyAppResource(
			`${name}-resource`,
			{
				token: provider.token,
				name: args.name,
				organization: args.organization ?? provider.organization,
			},
			{ parent: this },
		);

		this.id = resource.appId;

		this.registerOutputs({ id: this.id });
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/fly/app.ts
git commit -m "feat(fly): add FlyApp adopt-or-create resource"
```

---

### Task 5: FlySecret

**Files:**
- Create: `packages/pulumi/src/fly/secret.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/secret.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app.js";
import { FlyClient } from "./client.js";
import type { FlyProvider } from "./provider.js";

/** Resolved inputs for the Fly secret dynamic provider. */
export interface FlySecretInputs {
	/** Fly API token. */
	token: string;

	/** App name the secrets belong to. */
	appName: string;

	/** Secret key/value pairs to set on the app. */
	secrets: Record<string, string>;
}

/** Persisted state for Fly secrets. */
interface FlySecretOutputs extends FlySecretInputs {
	/** Fly secrets version (uint64, stored as string). Changes on every mutation. */
	version: string;
}

/** Response shape of the bulk secrets endpoint. */
interface UpdateSecretsResponse {
	version: number;
}

/**
 * POSTs a `values` map to `/v1/apps/{app}/secrets`. Keys with `null` values are
 * deleted; keys with string values are set. Returns the new version as a string.
 */
async function applySecrets(
	client: FlyClient,
	appName: string,
	values: Record<string, string | null>,
): Promise<string> {
	const response = await client.post<UpdateSecretsResponse>(
		`/v1/apps/${appName}/secrets`,
		{ values },
	);

	return String(response.version);
}

/**
 * Dynamic provider for Fly app secrets via the Machines REST bulk endpoint.
 *
 * Secret values are stored in state (required to diff them) and wrapped with
 * `pulumi.secret()` by the public resource so they are encrypted at rest.
 * Setting secrets only takes effect on the next machine restart — wire
 * `FlySecret.version` into `FlyDeploy.triggers` to force a redeploy on change.
 */
class FlySecretResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlySecretInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);
		const version = await applySecrets(client, inputs.appName, inputs.secrets);

		const outs: FlySecretOutputs = { ...inputs, version };

		return { id: `${inputs.appName}-secrets`, outs };
	}

	async read(
		id: string,
		props: FlySecretOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// Values are write-only (the API returns digests, not plaintext), so we
		// keep the desired state as the source of truth on refresh.
		return { id, props };
	}

	async update(
		_id: string,
		olds: FlySecretOutputs,
		news: FlySecretInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new FlyClient(news.token);

		const values: Record<string, string | null> = { ...news.secrets };

		for (const key of Object.keys(olds.secrets)) {
			if (!(key in news.secrets)) {
				values[key] = null;
			}
		}

		const version = await applySecrets(client, news.appName, values);

		return { outs: { ...news, version } };
	}

	async delete(_id: string, props: FlySecretOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		const values: Record<string, string | null> = {};

		for (const key of Object.keys(props.secrets)) {
			values[key] = null;
		}

		await applySecrets(client, props.appName, values);
	}

	async diff(
		_id: string,
		olds: FlySecretOutputs,
		news: FlySecretInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) replaces.push("appName");

		const oldKeys = Object.keys(olds.secrets).sort().join(",");
		const newKeys = Object.keys(news.secrets).sort().join(",");

		const valuesChanged = Object.entries(news.secrets).some(
			([key, value]) => olds.secrets[key] !== value,
		);

		return {
			changes: replaces.length > 0 || oldKeys !== newKeys || valuesChanged,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlySecretResource extends pulumi.dynamic.Resource {
	public declare readonly version: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			secrets: pulumi.Input<Record<string, string>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlySecretResourceProvider(),
			name,
			{ ...args, version: undefined },
			opts,
		);
	}
}

/** Options type for FlySecret. */
type FlySecretOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the secrets belong to. */
	app: FlyApp;
};

/** Args for FlySecret. */
export interface FlySecretArgs {
	/** Secret key/value pairs to set on the app. */
	secrets: pulumi.Input<Record<string, string>>;
}

/**
 * Manages an app's Fly secrets as a single resource.
 *
 * Exposes `.version`, which changes only when the secret set changes — feed it
 * into `FlyDeploy.triggers` so a redeploy fires when secrets change.
 *
 * @example
 * ```typescript
 * const secrets = new FlySecret("api-secrets", {
 *   secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
 * }, { provider, app });
 * ```
 */
export class FlySecret extends pulumi.ComponentResource {
	/** Fly secrets version. Changes only when the secret set changes. */
	public readonly version: pulumi.Output<string>;

	constructor(name: string, args: FlySecretArgs, opts: FlySecretOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Secret", name, {}, pulumiOpts);

		const resource = new FlySecretResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				secrets: pulumi.secret(args.secrets),
			},
			{ parent: this },
		);

		this.version = resource.version;

		this.registerOutputs({ version: this.version });
	}
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/fly/secret.ts
git commit -m "feat(fly): add FlySecret resource via Machines REST secrets API"
```

---

### Task 6: FlyVolume

**Files:**
- Create: `packages/pulumi/src/fly/volume.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/volume.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app.js";
import { FlyClient } from "./client.js";
import type { FlyProvider } from "./provider.js";

/** Resolved inputs for the Fly volume dynamic provider. */
export interface FlyVolumeInputs {
	/** Fly API token. */
	token: string;

	/** App name the volume belongs to. */
	appName: string;

	/** Volume name (used for adoption lookup). */
	name: string;

	/** Region (IATA code). */
	region: string;

	/** Volume size in GB. */
	sizeGb: number;
}

/** Persisted state for the Fly volume. */
interface FlyVolumeOutputs extends FlyVolumeInputs {
	/** Fly-assigned volume ID (`vol_…`). */
	volumeId: string;
}

/** Volume response (only the fields we read). */
interface FlyVolumeResponse {
	id: string;
	name: string;
	state: string;
	size_gb: number;
	region: string;
}

/**
 * Dynamic provider for Fly volumes. `create()` lists volumes and adopts one
 * matching the name (volume names are not unique, so it adopts the first
 * non-destroyed match); otherwise it creates a new encrypted volume. Growing
 * `sizeGb` extends in place; shrinking is not supported by Fly.
 */
class FlyVolumeResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlyVolumeInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);

		const volumes = await client.get<FlyVolumeResponse[]>(
			`/v1/apps/${inputs.appName}/volumes`,
		);

		const existing = volumes.find(
			(volume) => volume.name === inputs.name && volume.state !== "destroyed",
		);

		let volumeId: string;

		if (existing) {
			pulumi.log.info(
				`Adopting existing Fly volume "${inputs.name}" (${existing.id})`,
			);

			volumeId = existing.id;
		} else {
			const created = await client.post<FlyVolumeResponse>(
				`/v1/apps/${inputs.appName}/volumes`,
				{
					name: inputs.name,
					region: inputs.region,
					size_gb: inputs.sizeGb,
					encrypted: true,
				},
			);

			volumeId = created.id;
		}

		const outs: FlyVolumeOutputs = { ...inputs, volumeId };

		return { id: volumeId, outs };
	}

	async read(
		id: string,
		props: FlyVolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);

		const volume = await client.tryGet<FlyVolumeResponse>(
			`/v1/apps/${props.appName}/volumes/${id}`,
		);

		if (!volume) {
			throw new Error(`Fly volume "${id}" not found during refresh`);
		}

		return {
			id,
			props: { ...props, name: volume.name, region: volume.region, sizeGb: volume.size_gb },
		};
	}

	async update(
		id: string,
		olds: FlyVolumeOutputs,
		news: FlyVolumeInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		if (news.sizeGb > olds.sizeGb) {
			const client = new FlyClient(news.token);

			await client.put(`/v1/apps/${news.appName}/volumes/${id}/extend`, {
				size_gb: news.sizeGb,
			});
		}

		return { outs: { ...news, volumeId: id } };
	}

	async delete(id: string, props: FlyVolumeOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		await client.delete(`/v1/apps/${props.appName}/volumes/${id}`);
	}

	async diff(
		_id: string,
		olds: FlyVolumeOutputs,
		news: FlyVolumeInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) replaces.push("appName");
		if (olds.name !== news.name) replaces.push("name");
		if (olds.region !== news.region) replaces.push("region");
		if (news.sizeGb < olds.sizeGb) replaces.push("sizeGb");

		const sizeGrew = news.sizeGb > olds.sizeGb;

		return {
			changes: replaces.length > 0 || sizeGrew,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyVolumeResource extends pulumi.dynamic.Resource {
	public declare readonly volumeId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			name: pulumi.Input<string>;
			region: pulumi.Input<string>;
			sizeGb: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyVolumeResourceProvider(),
			name,
			{ ...args, volumeId: undefined },
			opts,
		);
	}
}

/** Options type for FlyVolume. */
type FlyVolumeOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the volume belongs to. */
	app: FlyApp;
};

/** Args for FlyVolume. */
export interface FlyVolumeArgs {
	/** Volume name. */
	name: pulumi.Input<string>;

	/** Region (IATA code, e.g. `"iad"`). */
	region: pulumi.Input<string>;

	/** Volume size in GB. Can be grown (extended) but not shrunk. */
	sizeGb: pulumi.Input<number>;
}

/**
 * Manages a Fly volume with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const volume = new FlyVolume("api-data", {
 *   name: "data",
 *   region: "iad",
 *   sizeGb: 10,
 * }, { provider, app });
 * ```
 */
export class FlyVolume extends pulumi.ComponentResource {
	/** Fly-assigned volume ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyVolumeArgs, opts: FlyVolumeOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Volume", name, {}, pulumiOpts);

		const resource = new FlyVolumeResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				...args,
			},
			{ parent: this },
		);

		this.id = resource.volumeId;

		this.registerOutputs({ id: this.id });
	}
}
```

(`FlyRegion` is a union type, not an enum, so consumers pass the region string directly, e.g. `region: "iad"`.)

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/fly/volume.ts
git commit -m "feat(fly): add FlyVolume adopt-or-create resource with extend-on-grow"
```

---

### Task 7: FlyCertificate

**Files:**
- Create: `packages/pulumi/src/fly/certificate.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/certificate.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app.js";
import { FlyClient } from "./client.js";
import type { FlyProvider } from "./provider.js";

/** DNS records the consumer must create for certificate validation. */
export interface FlyDnsRequirements {
	/** ACME challenge CNAME record. */
	acme_challenge?: { name: string; target: string };

	/** `_fly-ownership` TXT record. */
	ownership?: { name: string; app_value: string };

	/** CNAME target for the hostname itself. */
	cname?: string;
}

/** Resolved inputs for the Fly certificate dynamic provider. */
export interface FlyCertificateInputs {
	/** Fly API token. */
	token: string;

	/** App name the certificate belongs to. */
	appName: string;

	/** Hostname to issue an ACME certificate for. Used as the resource key. */
	hostname: string;
}

/** Persisted state for the Fly certificate. */
interface FlyCertificateOutputs extends FlyCertificateInputs {
	/** Whether the certificate is fully provisioned (DNS correct). */
	configured: boolean;

	/** DNS records required for validation. */
	dnsRequirements: FlyDnsRequirements;
}

/** Certificate response (only the fields we read). */
interface FlyCertificateResponse {
	hostname: string;
	configured: boolean;
	dns_requirements?: FlyDnsRequirements;
}

/**
 * Dynamic provider for Fly ACME (Let's Encrypt) certificates. `create()` checks
 * for an existing cert by hostname and adopts it, otherwise it requests one via
 * `POST /v1/apps/{app}/certificates/acme`. The Machines API returns no `id` —
 * the hostname is the resource key.
 */
class FlyCertificateResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: FlyCertificateInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);
		const path = `/v1/apps/${inputs.appName}/certificates/${encodeURIComponent(inputs.hostname)}`;

		let cert = await client.tryGet<FlyCertificateResponse>(path);

		if (cert) {
			pulumi.log.info(`Adopting existing Fly certificate "${inputs.hostname}"`);
		} else {
			cert = await client.post<FlyCertificateResponse>(
				`/v1/apps/${inputs.appName}/certificates/acme`,
				{ hostname: inputs.hostname },
			);
		}

		const outs: FlyCertificateOutputs = {
			...inputs,
			configured: cert.configured ?? false,
			dnsRequirements: cert.dns_requirements ?? {},
		};

		return { id: inputs.hostname, outs };
	}

	async read(
		id: string,
		props: FlyCertificateOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);

		const cert = await client.tryGet<FlyCertificateResponse>(
			`/v1/apps/${props.appName}/certificates/${encodeURIComponent(id)}`,
		);

		if (!cert) {
			throw new Error(`Fly certificate "${id}" not found during refresh`);
		}

		return {
			id,
			props: {
				...props,
				configured: cert.configured ?? false,
				dnsRequirements: cert.dns_requirements ?? {},
			},
		};
	}

	async update(
		_id: string,
		_olds: FlyCertificateOutputs,
		news: FlyCertificateInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		// Hostname/app changes force replacement (see diff); nothing else is updatable.
		return {
			outs: { ...news, configured: false, dnsRequirements: {} },
		};
	}

	async delete(id: string, props: FlyCertificateOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		await client.delete(
			`/v1/apps/${props.appName}/certificates/${encodeURIComponent(id)}`,
		);
	}

	async diff(
		_id: string,
		olds: FlyCertificateOutputs,
		news: FlyCertificateInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) replaces.push("appName");
		if (olds.hostname !== news.hostname) replaces.push("hostname");

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyCertificateResource extends pulumi.dynamic.Resource {
	public declare readonly configured: pulumi.Output<boolean>;
	public declare readonly dnsRequirements: pulumi.Output<FlyDnsRequirements>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			hostname: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyCertificateResourceProvider(),
			name,
			{ ...args, configured: undefined, dnsRequirements: undefined },
			opts,
		);
	}
}

/** Options type for FlyCertificate. */
type FlyCertificateOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the certificate belongs to. */
	app: FlyApp;
};

/** Args for FlyCertificate. */
export interface FlyCertificateArgs {
	/** Hostname to issue an ACME certificate for (e.g. `"api.example.com"`). */
	hostname: pulumi.Input<string>;
}

/**
 * Manages a Fly ACME certificate for a custom hostname.
 *
 * Exposes `.configured` and `.dnsRequirements` so the consumer can wire up the
 * required DNS records.
 *
 * @example
 * ```typescript
 * const cert = new FlyCertificate("api-cert", {
 *   hostname: "api.example.com",
 * }, { provider, app });
 * ```
 */
export class FlyCertificate extends pulumi.ComponentResource {
	/** Certificate identifier (equals the hostname). */
	public readonly id: pulumi.Output<string>;

	/** Whether the certificate is fully provisioned. */
	public readonly configured: pulumi.Output<boolean>;

	/** DNS records required for validation. */
	public readonly dnsRequirements: pulumi.Output<FlyDnsRequirements>;

	constructor(
		name: string,
		args: FlyCertificateArgs,
		opts: FlyCertificateOptions,
	) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Certificate", name, {}, pulumiOpts);

		const resource = new FlyCertificateResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				hostname: args.hostname,
			},
			{ parent: this },
		);

		this.id = pulumi.output(args.hostname);
		this.configured = resource.configured;
		this.dnsRequirements = resource.dnsRequirements;

		this.registerOutputs({
			id: this.id,
			configured: this.configured,
			dnsRequirements: this.dnsRequirements,
		});
	}
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/fly/certificate.ts
git commit -m "feat(fly): add FlyCertificate ACME resource"
```

---

### Task 8: FlyIp

**Files:**
- Create: `packages/pulumi/src/fly/ip.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/ip.ts`:

```typescript
import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app.js";
import { FlyClient } from "./client.js";
import type { FlyProvider } from "./provider.js";

/**
 * Fly IP address type. Enum keys UPPERCASE; values are Fly's GraphQL enum
 * literals (lowercase wire format).
 */
export enum FlyIpType {
	V4 = "v4",
	V6 = "v6",
	SHARED_V4 = "shared_v4",
	PRIVATE_V6 = "private_v6",
}

/** Resolved inputs for the Fly IP dynamic provider. */
export interface FlyIpInputs {
	/** Fly API token. */
	token: string;

	/** App name (used as GraphQL appId). */
	appName: string;

	/** IP address type. */
	type: FlyIpType;

	/** Region (IATA code); omit for global. */
	region?: string;
}

/** Persisted state for the Fly IP. */
interface FlyIpOutputs extends FlyIpInputs {
	/** Allocated IP address (also the `.id`). */
	address: string;

	/** GraphQL node ID, when present (absent for `shared_v4`). */
	ipAddressId?: string;
}

const LIST_IPS = `
	query ($appName: String!) {
		app(name: $appName) {
			sharedIpAddress
			ipAddresses {
				nodes { id address type region }
			}
		}
	}
`;

const ALLOCATE_IP = `
	mutation ($input: AllocateIPAddressInput!) {
		allocateIpAddress(input: $input) {
			ipAddress { id address type region }
			app { sharedIpAddress }
		}
	}
`;

const RELEASE_IP = `
	mutation ($input: ReleaseIPAddressInput!) {
		releaseIpAddress(input: $input) { clientMutationId }
	}
`;

interface IpNode {
	id: string;
	address: string;
	type: string;
	region: string | null;
}

interface ListIpsResult {
	app: {
		sharedIpAddress: string | null;
		ipAddresses: { nodes: IpNode[] };
	};
}

interface AllocateResult {
	allocateIpAddress: {
		ipAddress: IpNode | null;
		app: { sharedIpAddress: string | null };
	};
}

/**
 * Dynamic provider for Fly dedicated/shared IP allocation via the Fly GraphQL
 * API. `create()` queries existing IPs and adopts a matching one, otherwise it
 * allocates. `shared_v4` allocations return a null `ipAddress` in the payload —
 * the address is read from `app.sharedIpAddress`.
 */
class FlyIpResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlyIpInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);

		const existing = await this.findExisting(client, inputs);

		if (existing) {
			pulumi.log.info(
				`Adopting existing Fly ${inputs.type} IP "${existing.address}"`,
			);

			return {
				id: existing.address,
				outs: { ...inputs, address: existing.address, ipAddressId: existing.ipAddressId },
			};
		}

		const result = await client.graphql<AllocateResult>(ALLOCATE_IP, {
			input: {
				appId: inputs.appName,
				type: inputs.type,
				region: inputs.region,
			},
		});

		const node = result.allocateIpAddress.ipAddress;

		const address =
			inputs.type === FlyIpType.SHARED_V4
				? (result.allocateIpAddress.app.sharedIpAddress ?? "")
				: (node?.address ?? "");

		if (!address) {
			throw new Error(
				`Fly IP allocation for app "${inputs.appName}" (${inputs.type}) returned no address`,
			);
		}

		return {
			id: address,
			outs: { ...inputs, address, ipAddressId: node?.id },
		};
	}

	async read(
		id: string,
		props: FlyIpOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		return { id, props };
	}

	async delete(_id: string, props: FlyIpOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		const input: Record<string, string> = { appId: props.appName };

		if (props.ipAddressId) {
			input.ipAddressId = props.ipAddressId;
		} else {
			input.ip = props.address;
		}

		await client.graphql(RELEASE_IP, { input });
	}

	async diff(
		_id: string,
		olds: FlyIpOutputs,
		news: FlyIpInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) replaces.push("appName");
		if (olds.type !== news.type) replaces.push("type");
		if (olds.region !== news.region) replaces.push("region");

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}

	private async findExisting(
		client: FlyClient,
		inputs: FlyIpInputs,
	): Promise<{ address: string; ipAddressId?: string } | null> {
		const result = await client.graphql<ListIpsResult>(LIST_IPS, {
			appName: inputs.appName,
		});

		if (inputs.type === FlyIpType.SHARED_V4) {
			const shared = result.app.sharedIpAddress;

			return shared ? { address: shared } : null;
		}

		const match = result.app.ipAddresses.nodes.find(
			(node) =>
				node.type === inputs.type &&
				(inputs.region === undefined || node.region === inputs.region),
		);

		return match ? { address: match.address, ipAddressId: match.id } : null;
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyIpResource extends pulumi.dynamic.Resource {
	public declare readonly address: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			type: pulumi.Input<FlyIpType>;
			region?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyIpResourceProvider(),
			name,
			{ ...args, address: undefined, ipAddressId: undefined },
			opts,
		);
	}
}

/** Options type for FlyIp. */
type FlyIpOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the IP belongs to. */
	app: FlyApp;
};

/** Args for FlyIp. */
export interface FlyIpArgs {
	/** IP address type. */
	type: pulumi.Input<FlyIpType>;

	/** Region (IATA code); omit for a global address. */
	region?: pulumi.Input<string>;
}

/**
 * Allocates a Fly IP address (dedicated or shared) via the Fly GraphQL API.
 *
 * @example
 * ```typescript
 * const ip = new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app });
 * ```
 */
export class FlyIp extends pulumi.ComponentResource {
	/** Allocated IP address. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyIpArgs, opts: FlyIpOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Ip", name, {}, pulumiOpts);

		const resource = new FlyIpResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				type: args.type,
				region: args.region,
			},
			{ parent: this },
		);

		this.id = resource.address;

		this.registerOutputs({ id: this.id });
	}
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/fly/ip.ts
git commit -m "feat(fly): add FlyIp GraphQL allocate/release resource"
```

---

### Task 9: FlyDeploy

**Files:**
- Create: `packages/pulumi/src/fly/deploy.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/pulumi/src/fly/deploy.ts`:

```typescript
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app.js";
import type { FlyProvider } from "./provider.js";
import { type FlyTomlConfig, generateFlyToml } from "./toml.js";

/** Options type for FlyDeploy. */
type FlyDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App to deploy into. */
	app: FlyApp;
};

/** Args for FlyDeploy. */
export interface FlyDeployArgs {
	/** Absolute path to the repo root (working directory for `fly deploy`). */
	monorepoRoot: string;

	/**
	 * fly.toml configuration. `config.app` must equal the FlyApp name. All values
	 * are plain (not `pulumi.Input`) — resolve Outputs before constructing this.
	 */
	config: FlyTomlConfig;

	/**
	 * Values that force a redeploy when changed (e.g. a source hash from
	 * `hashDirectory()` and `FlySecret.version`). The generated toml content is
	 * appended automatically.
	 */
	triggers: pulumi.Input<pulumi.Input<string>[]>;

	/** `fly deploy --wait-timeout` in seconds (default 300). */
	waitTimeout?: number;

	/** `fly deploy --release-command-timeout` in seconds (default 600). */
	releaseCommandTimeout?: number;

	/** `fly deploy --ha` (default false). */
	highAvailability?: boolean;
}

/**
 * Deploys a Fly app via `fly deploy --remote-only`, driven by a generated
 * fly.toml. The toml is written by the deploy command itself (at execution
 * time, not during `pulumi preview`) to `<monorepoRoot>/.fly/<app>.toml`, and
 * its content is added to the redeploy triggers (so config changes redeploy).
 *
 * @example
 * ```typescript
 * new FlyDeploy("api-deploy", {
 *   monorepoRoot,
 *   config: { app: "rby-api", primaryRegion: "iad", build: { dockerfile: "apps/api/Dockerfile" } },
 *   triggers: [hashDirectory("apps/api"), secrets.version],
 * }, { provider, app, dependsOn: [secrets] });
 * ```
 */
export class FlyDeploy extends pulumi.ComponentResource {
	constructor(name: string, args: FlyDeployArgs, opts: FlyDeployOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Deploy", name, {}, pulumiOpts);

		const tomlContent = generateFlyToml(args.config);
		const configPath = `.fly/${args.config.app}.toml`;

		const waitTimeout = args.waitTimeout ?? 300;
		const releaseCommandTimeout = args.releaseCommandTimeout ?? 600;
		const highAvailability = args.highAvailability ?? false;

		// The toml is written by the command at execution time. The content
		// arrives via the FLY_TOML_CONTENT env var (avoiding shell escaping) so
		// no file is touched during `pulumi preview`.
		const deployCommand = [
			"mkdir -p .fly",
			`printf '%s' "$FLY_TOML_CONTENT" > ${configPath}`,
			`fly deploy --config ${configPath} --remote-only --ha=${highAvailability} --wait-timeout ${waitTimeout} --release-command-timeout ${releaseCommandTimeout}`,
		].join(" && ");

		const triggers = pulumi
			.output(args.triggers)
			.apply((values) => [...values, tomlContent]);

		new command.local.Command(
			`${name}-deploy`,
			{
				create: deployCommand,
				triggers,
				dir: args.monorepoRoot,
				environment: {
					FLY_API_TOKEN: provider.token,
					FLY_TOML_CONTENT: tomlContent,
				},
			},
			{ parent: this, dependsOn: [app] },
		);

		this.registerOutputs({});
	}
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/fly/deploy.ts
git commit -m "feat(fly): add FlyDeploy component wrapping fly deploy"
```

---

### Task 10: index.ts + registration

**Files:**
- Create: `packages/pulumi/src/fly/index.ts`
- Modify: `packages/pulumi/tsdown.config.ts`
- Modify: `packages/pulumi/package.json`
- Modify: root `/Users/andrevictor/www/Andre-Dezzy/infracraft/.gitignore`

- [ ] **Step 1: Create the index**

Create `packages/pulumi/src/fly/index.ts`:

```typescript
export { FlyProvider } from "./provider.js";
export type { FlyProviderArgs } from "./provider.js";

export { FlyApp } from "./app.js";
export type { FlyAppArgs } from "./app.js";

export { FlySecret } from "./secret.js";
export type { FlySecretArgs } from "./secret.js";

export { FlyVolume } from "./volume.js";
export type { FlyVolumeArgs } from "./volume.js";

export { FlyCertificate } from "./certificate.js";
export type { FlyCertificateArgs, FlyDnsRequirements } from "./certificate.js";

export { FlyIp, FlyIpType } from "./ip.js";
export type { FlyIpArgs } from "./ip.js";

export { FlyDeploy } from "./deploy.js";
export type { FlyDeployArgs } from "./deploy.js";

export {
	FlyAutoStopMachines,
	FlyCheckType,
	FlyConcurrencyType,
	FlyCpuKind,
	FlyDeployStrategy,
	FlyPortHandler,
	FlyRestartPolicy,
	FlyServiceProtocol,
	generateFlyToml,
} from "./toml.js";
export type {
	FlyBuildConfig,
	FlyCheck,
	FlyConcurrency,
	FlyDeployConfig,
	FlyHttpService,
	FlyMount,
	FlyRegion,
	FlyRestartConfig,
	FlyService,
	FlyServicePort,
	FlyTomlConfig,
	FlyVm,
	FlyVmSize,
} from "./toml.js";
```

- [ ] **Step 2: Register the entry point in tsdown**

In `packages/pulumi/tsdown.config.ts`, add `"src/fly/index.ts"` to the `entry` array:

```typescript
import { library } from "@infracraft/config-tsdown/library";

export default library({
	entry: [
		"src/railway/index.ts",
		"src/neon/index.ts",
		"src/vercel/index.ts",
		"src/fly/index.ts",
		"src/hash.ts",
		"src/git-guard.ts",
	],
	minify: false,
});
```

- [ ] **Step 3: Add the export map entry in package.json**

In `packages/pulumi/package.json`, add the `./fly` entry to `exports` (after `./vercel`):

```json
		"./fly": {
			"types": "./dist/fly/index.d.mts",
			"default": "./dist/fly/index.mjs"
		},
```

The `exports` block becomes:

```json
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
		"./fly": {
			"types": "./dist/fly/index.d.mts",
			"default": "./dist/fly/index.mjs"
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
```

- [ ] **Step 4: Gitignore generated fly.toml**

Append to the root `.gitignore`:

```
# Generated fly.toml files (FlyDeploy)
.fly/
```

- [ ] **Step 5: Build the package**

Run: `bun run build`
Expected: PASS — `dist/fly/index.mjs` and `dist/fly/index.d.mts` are produced.

- [ ] **Step 6: Verify the build output exists**

Run: `ls dist/fly/index.mjs dist/fly/index.d.mts`
Expected: both files listed.

- [ ] **Step 7: Typecheck + lint + full test suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/fly/index.ts tsdown.config.ts package.json ../../.gitignore
git commit -m "feat(fly): export fly entry point and register build output"
```

---

### Task 11: README + final verification

**Files:**
- Modify: `/Users/andrevictor/www/Andre-Dezzy/infracraft/README.md`

- [ ] **Step 1: Read the current README**

Run: `cat /Users/andrevictor/www/Andre-Dezzy/infracraft/README.md`
Locate the Vercel provider section to match its heading depth and formatting.

- [ ] **Step 2: Add the Fly.io section**

Add a Fly.io section immediately after the Vercel section, matching the existing formatting. Use this content (adjust heading level to match siblings):

````markdown
### Fly.io

```typescript
import {
  FlyProvider,
  FlyApp,
  FlySecret,
  FlyVolume,
  FlyCertificate,
  FlyIp,
  FlyIpType,
  FlyDeploy,
} from "@infracraft/pulumi/fly";
import { hashDirectory } from "@infracraft/pulumi/hash";

// Provider — auth context (token + optional default org)
const provider = new FlyProvider("fly", {
  token: config.requireSecret("flyToken"),
  organization: "personal",
});

// App — adopt-or-create; `.id` is the app name
const app = new FlyApp("api", { name: "rby-api" }, { provider });

// Secrets — managed via the Machines REST secrets API.
// `.version` changes only when the secret set changes.
const secrets = new FlySecret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app });

// Volume — persistent storage (grow-only)
new FlyVolume("api-data", {
  name: "data",
  region: "iad",
  sizeGb: 10,
}, { provider, app });

// Certificate — ACME cert for a custom hostname; exposes DNS requirements
const cert = new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app });

// Dedicated/shared IP (Fly GraphQL API)
new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app });

// Deploy — `fly deploy` with consumer-controlled triggers.
// The generated fly.toml content is added to the triggers automatically.
new FlyDeploy("api-deploy", {
  monorepoRoot,
  config: {
    app: "rby-api",
    primaryRegion: "iad",
    build: { dockerfile: "apps/api/Dockerfile" },
    env: { PORT: "3333", NODE_ENV: "production" },
    httpService: {
      internalPort: 3333,
      forceHttps: true,
      minMachinesRunning: 1,
      checks: [{ method: "GET", path: "/health", interval: "30s", timeout: "10s" }],
    },
    vm: [{ size: "shared-cpu-1x", memory: "512mb", cpus: 1 }],
  },
  triggers: [hashDirectory("apps/api"), secrets.version],
}, { provider, app, dependsOn: [secrets] });
```

**Requirements:** `flyctl` must be installed on the machine running `pulumi up` (used by `FlyDeploy`). Generate a token with `fly tokens create deploy`. Dedicated IP allocation uses the Fly GraphQL API; everything else uses the Machines REST API.
````

If the README has a provider/outputs table or a feature list, add Fly rows there too:
- App, Secret, Volume, Certificate, IP, Deploy resources.
- Outputs: `FlyApp.id`, `FlySecret.version`, `FlyVolume.id`, `FlyCertificate.id`/`.configured`/`.dnsRequirements`, `FlyIp.id`.

- [ ] **Step 3: Bump the package version**

In `packages/pulumi/package.json`, bump `version` from `1.2.0` to `1.3.0` (new provider = minor bump).

- [ ] **Step 4: Final full verification**

Run from the package directory:

```bash
bun run lint && bun run typecheck && bun run test && bun run build
```

Expected: all PASS, zero warnings, `dist/fly/` populated.

- [ ] **Step 5: Verify README accuracy against the shipped API**

Confirm every symbol used in the README is exported from `src/fly/index.ts` (provider, resources, `FlyIpType`, `generateFlyToml`, types). Fix any drift.

- [ ] **Step 6: Commit**

```bash
git add ../../README.md package.json
git commit -m "docs(fly): document Fly.io provider and bump to 1.3.0"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** FlyProvider (T2), FlyApp (T4), FlySecret REST + `.version` (T5), FlyVolume (T6), FlyCertificate (T7), FlyIp GraphQL (T8), FlyDeploy flyctl + typed fly.toml (T9, T3), `.fly/` temp-file fix (T9 + T10 gitignore), enum-casing decision (T3 + T8), registration (T10), README (T11). All spec sections map to a task.
- **Type consistency:** `FlyClient` methods (`get`/`tryGet`/`post`/`put`/`delete`/`graphql`) are defined in T1 and used identically in T4–T8. `FlyApp.id`, `FlySecret.version`, `FlyVolume.id`, `FlyCertificate.id`/`.configured`/`.dnsRequirements`, `FlyIp.id` are consistent between resource definitions and the index/README. `FlyTomlConfig` field names (T3) match `generateFlyToml` usage and the `FlyDeploy` example (T9).
- **Placeholder scan:** No TBD/TODO. Every code step shows complete code; every command shows expected output.
- **Known defensive handling:** duplicate-app status code (T4 treats any non-404 existing as adopt, else creates), `shared_v4` null payload (T8 reads `app.sharedIpAddress`), `releaseIpAddress` prefers `ipAddressId` then `ip` (T8).
