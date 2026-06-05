import { library } from "@infracraft/config-tsdown/library";

export default library({
	entry: [
		"src/railway/index.ts",
		"src/neon/index.ts",
		"src/vercel/index.ts",
		"src/fly/index.ts",
		"src/agents/index.ts",
		"src/hash.ts",
		"src/git-guard.ts",
		"src/sandbox.ts",
	],
	minify: false,
});
