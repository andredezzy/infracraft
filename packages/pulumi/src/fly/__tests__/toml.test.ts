import { describe, expect, it } from "vitest";

import {
	AutoStopMachines,
	ConcurrencyType,
	CpuKind,
	DeployStrategy,
	generateFlyToml,
	RestartPolicy,
	type TomlConfig,
} from "../toml";

describe("generateFlyToml", () => {
	it("emits a minimal config", () => {
		const toml = generateFlyToml({ app: "rby-api", primaryRegion: "iad" });

		expect(toml).toContain('app = "rby-api"');
		expect(toml).toContain('primary_region = "iad"');
	});

	it("emits build, env and processes sections", () => {
		const config: TomlConfig = {
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
		const config: TomlConfig = {
			app: "rby-api",
			primaryRegion: "iad",
			httpService: {
				internalPort: 3333,
				forceHttps: true,
				autoStopMachines: AutoStopMachines.OFF,
				autoStartMachines: true,
				minMachinesRunning: 1,
				concurrency: {
					type: ConcurrencyType.REQUESTS,
					softLimit: 200,
					hardLimit: 250,
				},
				checks: [
					{
						method: "GET",
						path: "/health",
						interval: "30s",
						timeout: "10s",
						gracePeriod: "120s",
					},
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
		const config: TomlConfig = {
			app: "rby-redis",
			primaryRegion: "iad",
			mounts: [
				{ source: "redis_data", destination: "/data", processes: ["app"] },
			],
			vm: [
				{
					size: "shared-cpu-1x",
					memory: "256mb",
					cpuKind: CpuKind.SHARED,
					cpus: 1,
				},
			],
			deploy: {
				strategy: DeployStrategy.BLUEGREEN,
				releaseCommand: "node scripts/migrate.js",
			},
			restart: { policy: RestartPolicy.ON_FAILURE, retries: 5 },
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

	it("accepts performance and GPU vm sizes with additional regions", () => {
		const toml = generateFlyToml({
			app: "ml-worker",
			primaryRegion: "fra",
			vm: [
				{
					size: "performance-4x",
					memory: "8192mb",
					cpuKind: CpuKind.PERFORMANCE,
					cpus: 4,
				},
			],
		});

		expect(toml).toContain('primary_region = "fra"');
		expect(toml).toContain('size = "performance-4x"');
		expect(toml).toContain('memory = "8192mb"');
		expect(toml).toContain('cpu_kind = "performance"');
		expect(toml).toContain("cpus = 4");
	});

	it("accepts a GPU vm size", () => {
		const toml = generateFlyToml({
			app: "gpu-worker",
			primaryRegion: "ord",
			vm: [{ size: "a100-80gb", memory: "16384mb", cpus: 8 }],
		});

		expect(toml).toContain('size = "a100-80gb"');
		expect(toml).toContain('memory = "16384mb"');
	});

	it("accepts numeric memory and additional region codes", () => {
		const configs = [
			{ app: "app-arn", primaryRegion: "arn" as const },
			{ app: "app-syd", primaryRegion: "syd" as const },
			{ app: "app-jnb", primaryRegion: "jnb" as const },
		] satisfies Array<{
			app: string;
			primaryRegion: import("../toml").Region;
		}>;

		for (const config of configs) {
			const toml = generateFlyToml(config);
			expect(toml).toContain(`primary_region = "${config.primaryRegion}"`);
		}

		const tomlNumericMemory = generateFlyToml({
			app: "app-mem",
			primaryRegion: "lhr",
			vm: [{ size: "shared-cpu-2x", memory: 1024, cpus: 2 }],
		});

		expect(tomlNumericMemory).toContain("memory = 1024");
	});
});
