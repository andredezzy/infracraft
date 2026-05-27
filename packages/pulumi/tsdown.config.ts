import { library } from "@infracraft/config-tsdown/library";

export default library({
	entry: [
		"src/railway/index.ts",
		"src/neon/index.ts",
		"src/vercel/index.ts",
		"src/hash.ts",
		"src/git-guard.ts",
	],
	minify: false,
});
