import { library } from "@infracraft/config-tsdown/library";

export default library({
	entry: [
		"src/railway/index.ts",
		// Standalone runnable: `node dist/railway/bin/monitor-deployment.mjs` (invoked by railway.Deploy).
		"src/railway/bin/monitor-deployment.ts",
		"src/neon/index.ts",
		"src/vercel/index.ts",
		"src/fly/index.ts",
		"src/preflight/index.ts",
		"src/hash.ts",
		"src/git-guard.ts",
		"src/sandbox.ts",
	],
	minify: false,
});
