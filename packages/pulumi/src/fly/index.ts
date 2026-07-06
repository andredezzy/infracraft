// The typed not-found error this provider's client throws — consumers catch by instanceof.
export { ApiNotFoundError } from "../errors/api-not-found-error";
export type { FlyAppArgs } from "./app";
export { FlyApp } from "./app";
export type { FlyCertificateArgs, FlyDnsRequirements } from "./certificate";
export { FlyCertificate } from "./certificate";
export { FlyClient } from "./client";
export type { FlyDeployArgs } from "./deploy";
export { FlyDeploy } from "./deploy";
export type { FlyIpArgs } from "./ip";
export { FlyIp, FlyIpType } from "./ip";
export type { FlyProviderArgs } from "./provider";
export { FlyProvider } from "./provider";
export type { FlySecretArgs } from "./secret";
export { FlySecret } from "./secret";
export type {
	FlyBuildConfig,
	FlyCheck,
	FlyConcurrency,
	FlyCpuCount,
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
} from "./toml";
export {
	FLY_REGIONS,
	FLY_VM_SIZES,
	FlyAutoStopMachines,
	FlyCheckType,
	FlyConcurrencyType,
	FlyCpuKind,
	FlyDeployStrategy,
	FlyPortHandler,
	FlyRestartPolicy,
	FlyServiceProtocol,
	generateFlyToml,
} from "./toml";
export type { FlyVolumeArgs } from "./volume";
export { FlyVolume } from "./volume";
