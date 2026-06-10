export { SandboxMode } from "@infracraft/sandbox";
export type { NativeSessionDiscovery } from "./accounts/discovery";
export {
	classifyNativeSession,
	NativeSessionStatus,
} from "./accounts/discovery";
export { findDuplicateIdentityGroups } from "./accounts/duplicates";
export type { EnsureValidSessionOptions } from "./accounts/session";
export { detectActiveAccount, ensureValidSession } from "./accounts/session";
export type { GateAccount } from "./accounts/store";
export { AccountStore } from "./accounts/store";
export {
	migrateVergateAccounts,
	readVergateAccounts,
	shouldOfferVergateMigration,
} from "./accounts/vergate-migration";
export type {
	DeployRunOptions,
	DeployRunResult,
	DeploySpawner,
	SpawnedDeploy,
} from "./deploy/runner";
export { runDeploy } from "./deploy/runner";
export type {
	PassthroughRunOptions,
	PassthroughRunResult,
	PassthroughSpawner,
	SpawnedPassthrough,
} from "./passthrough/runner";
export { runPassthrough } from "./passthrough/runner";
export { flyProvider } from "./providers/fly";
export type { LoginSpawner, LoginTarget } from "./providers/intercept-login";
export { interceptNativeLogin } from "./providers/intercept-login";
export type {
	GateProvider,
	NativeCliCommand,
	NativeCliContext,
	ProviderSession,
} from "./providers/provider";
export { Provider } from "./providers/provider";
export { railwayProvider } from "./providers/railway";
export { PROVIDERS } from "./providers/registry";
export { vercelProvider } from "./providers/vercel";
export type { CommandContext } from "./registry/command-spec";
export { InteractionMode } from "./registry/command-spec";
export type {
	GateTreeRoute,
	InvalidRoute,
	PassthroughRoute,
	RoutedCommand,
} from "./routing/route-command";
export {
	CommandRoute,
	GateAuthVerb,
	routeCommand,
} from "./routing/route-command";
export type { SplitGateFlags } from "./routing/split-gate-flags";
export { GateFlagRegion, splitGateFlags } from "./routing/split-gate-flags";
