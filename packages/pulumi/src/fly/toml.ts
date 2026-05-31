/**
 * fly.toml deploy strategy. Enum keys are UPPERCASE per convention; values are
 * Fly's required lowercase wire literals (external format — cannot be uppercased).
 * Note: 'canary' requires more than one machine; falls back to 'rolling' when
 * max-per-region is 1. Default is 'rolling'.
 */
export enum FlyDeployStrategy {
	ROLLING = "rolling",
	IMMEDIATE = "immediate",
	CANARY = "canary",
	BLUEGREEN = "bluegreen",
}

/** Machine restart policy. Default is 'on-failure'. */
export enum FlyRestartPolicy {
	ALWAYS = "always",
	ON_FAILURE = "on-failure",
	NEVER = "never",
}

/**
 * Idle-machine auto-stop behavior. 'off' is equivalent to boolean false,
 * 'stop' is equivalent to boolean true, but 'suspend' cannot be expressed
 * as a boolean. Default is 'off'.
 */
export enum FlyAutoStopMachines {
	OFF = "off",
	STOP = "stop",
	SUSPEND = "suspend",
}

/**
 * Concurrency limit unit. 'connections' is the default. For HTTP apps,
 * 'requests' is recommended because the proxy can pool connections.
 */
export enum FlyConcurrencyType {
	CONNECTIONS = "connections",
	REQUESTS = "requests",
}

/** Raw service protocol. When 'udp', handlers must be left unset. */
export enum FlyServiceProtocol {
	TCP = "tcp",
	UDP = "udp",
}

/** Port handler. Only valid for TCP services; omit entirely for UDP services. */
export enum FlyPortHandler {
	HTTP = "http",
	TLS = "tls",
	PG_TLS = "pg_tls",
	PROXY_PROTO = "proxy_proto",
	EDGE_HTTP = "edge_http",
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
 * Authoritative list of Fly region codes (IATA).
 * Consumers may use this array for validation or UI rendering.
 * Source: https://fly.io/docs/reference/regions/
 */
export const FLY_REGIONS = [
	// Americas
	"bos",
	"dfw",
	"ewr",
	"gig",
	"gru",
	"iad",
	"lax",
	"mia",
	"ord",
	"scl",
	"sea",
	"sjc",
	"yul",
	"yyz",
	// Europe
	"ams",
	"arn",
	"cdg",
	"fra",
	"lhr",
	"mad",
	"waw",
	// Asia-Pacific
	"bom",
	"hkg",
	"maa",
	"nrt",
	"sin",
	"syd",
	// Africa
	"jnb",
] as const;

/**
 * Fly region code (IATA). Derived from {@link FLY_REGIONS} — single source of truth.
 * When Fly adds a new region, update {@link FLY_REGIONS} and release a new version.
 */
export type FlyRegion = (typeof FLY_REGIONS)[number];

/**
 * Authoritative list of Fly machine size presets.
 * Consumers may use this array for validation or UI rendering.
 * Source: https://fly.io/docs/about/pricing/#compute
 */
export const FLY_VM_SIZES = [
	// Shared CPU
	"shared-cpu-1x",
	"shared-cpu-2x",
	"shared-cpu-4x",
	"shared-cpu-6x",
	"shared-cpu-8x",
	// Performance CPU
	"performance-1x",
	"performance-2x",
	"performance-4x",
	"performance-6x",
	"performance-8x",
	"performance-10x",
	"performance-12x",
	"performance-14x",
	"performance-16x",
	// GPU
	"a10",
	"a100-40gb",
	"a100-80gb",
	"l40s",
] as const;

/**
 * Fly machine size preset. Derived from {@link FLY_VM_SIZES} — single source of truth.
 * When Fly adds a new size, update {@link FLY_VM_SIZES} and release a new version.
 * Pass the raw string directly — e.g. "shared-cpu-1x".
 */
export type FlyVmSize = (typeof FLY_VM_SIZES)[number];

/**
 * Number of CPUs for a [[vm]] entry. Valid values depend on the chosen
 * cpu_kind — not all counts are available for both shared and performance
 * CPU kinds. The union covers the full documented permitted set.
 */
export type FlyCpuCount = 1 | 2 | 4 | 8 | 16;

/** A single health check. */
export interface FlyCheck {
	type?: FlyCheckType;
	port?: number;
	method?: string;
	path?: string;
	/**
	 * How often to run the check. Go duration format — e.g. "15s", "1m", "500ms".
	 * Compound forms like "1m30s" are also valid.
	 */
	interval: string;
	/**
	 * Maximum time to wait for the check to complete. Go duration format — e.g. "10s".
	 * Compound forms like "1m30s" are also valid.
	 */
	timeout: string;
	/**
	 * Grace period before checks begin after machine start. Go duration format — e.g. "30s".
	 * Compound forms like "1m30s" are also valid.
	 */
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
	/**
	 * Memory allocation. Accepts a bare integer (interpreted as MB, e.g. 1024)
	 * or a string with units (e.g. "512mb", "2gb"). Valid values are
	 * hardware-tier-dependent; see https://fly.io/docs/about/pricing/.
	 */
	memory?: string | number;
	cpuKind?: FlyCpuKind;
	/** Number of CPUs. Valid values depend on the chosen `cpuKind`. */
	cpus?: FlyCpuCount;
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

	if (check.type !== undefined) {
		lines.push(`    type = ${quote(check.type)}`);
	}

	if (check.port !== undefined) {
		lines.push(`    port = ${check.port}`);
	}

	if (check.method !== undefined) {
		lines.push(`    method = ${quote(check.method)}`);
	}

	if (check.path !== undefined) {
		lines.push(`    path = ${quote(check.path)}`);
	}

	lines.push(`    interval = ${quote(check.interval)}`);
	lines.push(`    timeout = ${quote(check.timeout)}`);

	if (check.gracePeriod !== undefined) {
		lines.push(`    grace_period = ${quote(check.gracePeriod)}`);
	}
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

		if (config.build.dockerfile !== undefined) {
			lines.push(`  dockerfile = ${quote(config.build.dockerfile)}`);
		}

		if (config.build.image !== undefined) {
			lines.push(`  image = ${quote(config.build.image)}`);
		}
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

		if (service.forceHttps !== undefined) {
			lines.push(`  force_https = ${service.forceHttps}`);
		}

		if (service.autoStopMachines !== undefined) {
			lines.push(`  auto_stop_machines = ${quote(service.autoStopMachines)}`);
		}

		if (service.autoStartMachines !== undefined) {
			lines.push(`  auto_start_machines = ${service.autoStartMachines}`);
		}

		if (service.minMachinesRunning !== undefined) {
			lines.push(`  min_machines_running = ${service.minMachinesRunning}`);
		}

		if (service.processes !== undefined) {
			lines.push(`  processes = ${array(service.processes)}`);
		}

		if (service.concurrency) {
			pushConcurrency(
				lines,
				"  [http_service.concurrency]",
				service.concurrency,
			);
		}

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

			if (service.autoStopMachines !== undefined) {
				lines.push(`  auto_stop_machines = ${quote(service.autoStopMachines)}`);
			}

			if (service.autoStartMachines !== undefined) {
				lines.push(`  auto_start_machines = ${service.autoStartMachines}`);
			}

			if (service.minMachinesRunning !== undefined) {
				lines.push(`  min_machines_running = ${service.minMachinesRunning}`);
			}

			if (service.processes !== undefined) {
				lines.push(`  processes = ${array(service.processes)}`);
			}

			for (const port of service.ports) {
				lines.push("", "  [[services.ports]]");
				lines.push(`    port = ${port.port}`);

				if (port.handlers !== undefined) {
					lines.push(`    handlers = ${array(port.handlers)}`);
				}
			}

			if (service.concurrency) {
				pushConcurrency(lines, "  [services.concurrency]", service.concurrency);
			}

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

			if (mount.processes !== undefined) {
				lines.push(`  processes = ${array(mount.processes)}`);
			}

			if (mount.initialSize !== undefined) {
				lines.push(`  initial_size = ${quote(mount.initialSize)}`);
			}
		}
	}

	if (config.vm) {
		for (const vm of config.vm) {
			lines.push("", "[[vm]]");

			if (vm.size !== undefined) {
				lines.push(`  size = ${quote(vm.size)}`);
			}

			if (vm.memory !== undefined) {
				lines.push(
					typeof vm.memory === "number"
						? `  memory = ${vm.memory}`
						: `  memory = ${quote(vm.memory)}`,
				);
			}

			if (vm.cpuKind !== undefined) {
				lines.push(`  cpu_kind = ${quote(vm.cpuKind)}`);
			}

			if (vm.cpus !== undefined) {
				lines.push(`  cpus = ${vm.cpus}`);
			}

			if (vm.processes !== undefined) {
				lines.push(`  processes = ${array(vm.processes)}`);
			}
		}
	}

	if (config.deploy) {
		lines.push("", "[deploy]");

		if (config.deploy.strategy !== undefined) {
			lines.push(`  strategy = ${quote(config.deploy.strategy)}`);
		}

		if (config.deploy.releaseCommand !== undefined) {
			lines.push(`  release_command = ${quote(config.deploy.releaseCommand)}`);
		}
	}

	if (config.restart) {
		lines.push("", "[[restart]]");

		if (config.restart.policy !== undefined) {
			lines.push(`  policy = ${quote(config.restart.policy)}`);
		}

		if (config.restart.retries !== undefined) {
			lines.push(`  retries = ${config.restart.retries}`);
		}

		if (config.restart.processes !== undefined) {
			lines.push(`  processes = ${array(config.restart.processes)}`);
		}
	}

	if (config.checks) {
		for (const [checkName, check] of Object.entries(config.checks)) {
			pushCheck(lines, `[checks.${checkName}]`, check);
		}
	}

	return `${lines.join("\n")}\n`;
}
