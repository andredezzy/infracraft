import stylisticPlugin from "@stylistic/eslint-plugin";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: [
			"**/node_modules/**",
			"**/.turbo/**",
			"**/out/**",
			"**/build/**",
			"**/dist/**",
			"**/coverage/**",
			"**/generated/**",
			"**/*.generated.*",
		],
	},

	{
		files: ["**/*.{ts,tsx,js,jsx}"],

		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
			},
		},

		plugins: {
			stylistic: stylisticPlugin,
			"@typescript-eslint": tsPlugin,
		},

		rules: {
			"stylistic/padding-line-between-statements": [
				"error",
				{
					blankLine: "always",
					prev: "*",
					next: [
						"if",
						"return",
						"function",
						"interface",
						"type",
						"multiline-const",
						"multiline-let",
						"multiline-var",
						"class",
						"export",
						"try",
						"throw",
						"break",
						"continue",
						"multiline-expression",
					],
				},
				{
					blankLine: "always",
					prev: [
						"if",
						"class",
						"function",
						"interface",
						"type",
						"export",
						"try",
						"multiline-const",
						"multiline-let",
						"multiline-var",
						"multiline-expression",
					],
					next: "*",
				},
				{
					blankLine: "always",
					prev: "multiline-expression",
					next: "multiline-expression",
				},
				{ blankLine: "any", prev: "export", next: "export" },
			],
		},
	},
]);
