import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resilientFetch } from "../resilient-fetch";

const response = (status: number, headers: Record<string, string> = {}) =>
	({
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
	}) as unknown as Response;

describe("resilientFetch", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("passes the init through and attaches a per-attempt timeout signal", async () => {
		mockFetch.mockResolvedValue(response(200));

		await resilientFetch("https://api.test/x", { method: "POST" });

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.test/x");
		expect(init.method).toBe("POST");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("retries a 503 and returns the eventual success", async () => {
		mockFetch
			.mockResolvedValueOnce(response(503))
			.mockResolvedValueOnce(response(200));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.runAllTimersAsync();

		await expect(promise).resolves.toMatchObject({ status: 200 });
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("waits the numeric Retry-After before retrying a 429", async () => {
		mockFetch
			.mockResolvedValueOnce(response(429, { "retry-after": "7" }))
			.mockResolvedValueOnce(response(200));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.advanceTimersByTimeAsync(6_999);

		expect(mockFetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toMatchObject({ status: 200 });
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("caps the Retry-After wait at 30 seconds", async () => {
		mockFetch
			.mockResolvedValueOnce(response(429, { "retry-after": "3600" }))
			.mockResolvedValueOnce(response(200));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.advanceTimersByTimeAsync(29_999);

		expect(mockFetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toMatchObject({ status: 200 });
	});

	it("falls back to exponential backoff on a 429 without a numeric Retry-After", async () => {
		mockFetch
			.mockResolvedValueOnce(response(429))
			.mockResolvedValueOnce(response(200));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.advanceTimersByTimeAsync(999);

		expect(mockFetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toMatchObject({ status: 200 });
	});

	it("returns a 404 without retrying", async () => {
		mockFetch.mockResolvedValue(response(404));

		const result = await resilientFetch("https://api.test/x", {});

		expect(result.status).toBe(404);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("retries when an attempt times out (abort)", async () => {
		mockFetch
			.mockRejectedValueOnce(
				new DOMException("The operation timed out", "TimeoutError"),
			)
			.mockResolvedValueOnce(response(200));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.runAllTimersAsync();

		await expect(promise).resolves.toMatchObject({ status: 200 });
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("throws the last network error once attempts are exhausted", async () => {
		mockFetch.mockRejectedValue(new TypeError("fetch failed"));

		const promise = resilientFetch("https://api.test/x", {});
		const assertion = expect(promise).rejects.toThrow("fetch failed");

		await vi.runAllTimersAsync();
		await assertion;

		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("returns the final 5xx response once attempts are exhausted", async () => {
		mockFetch.mockResolvedValue(response(502));

		const promise = resilientFetch("https://api.test/x", {});

		await vi.runAllTimersAsync();

		await expect(promise).resolves.toMatchObject({ status: 502 });
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("honors a maxAttempts override", async () => {
		mockFetch.mockResolvedValue(response(503));

		const result = await resilientFetch(
			"https://api.test/x",
			{},
			{ maxAttempts: 1 },
		);

		expect(result.status).toBe(503);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});
