import { flyProvider } from "./fly";
import type { GateProvider } from "./provider";
import { railwayProvider } from "./railway";
import { vercelProvider } from "./vercel";

/** Registration order = `gate --help` order. New provider: one import + one entry. */
export const PROVIDERS: GateProvider[] = [
	vercelProvider,
	railwayProvider,
	flyProvider,
];
