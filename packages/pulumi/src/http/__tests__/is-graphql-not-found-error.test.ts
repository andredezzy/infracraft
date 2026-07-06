import { describe, expect, it } from "vitest";

import { isGraphqlNotFoundError } from "../is-graphql-not-found-error";

describe("isGraphqlNotFoundError", () => {
	it("matches a 'not found' error message", () => {
		expect(isGraphqlNotFoundError(new Error("Token not found"))).toBe(true);
	});

	it("matches a 'could not find' error message, case-insensitively", () => {
		expect(
			isGraphqlNotFoundError(new Error("Could Not Find volume abc123")),
		).toBe(true);
	});

	it("does not match an unrelated error message", () => {
		expect(isGraphqlNotFoundError(new Error("forbidden"))).toBe(false);
	});

	it("does not match a non-Error value", () => {
		expect(isGraphqlNotFoundError("not found")).toBe(false);
		expect(isGraphqlNotFoundError(undefined)).toBe(false);
	});
});
