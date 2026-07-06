import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayDomainResourceProvider } from "../domain";

describe("RailwayDomainResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const inputs = () => ({
		token: "tok",
		projectId: "proj-123",
		serviceId: "svc-mesh",
		environmentId: "env-staging",
		customDomain: "api.example.com",
	});

	const trafficRouteCname = (requiredValue: string) => ({
		recordType: "DNS_RECORD_TYPE_CNAME",
		purpose: "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE",
		requiredValue,
	});

	const acmeChallengeTxt = () => ({
		recordType: "DNS_RECORD_TYPE_TXT",
		purpose: "DNS_RECORD_PURPOSE_ACME_DNS01_CHALLENGE",
		requiredValue: "some-verification-token",
	});

	describe("create", () => {
		it("adopts an existing custom domain and extracts its CNAME target", async () => {
			mockQuery.mockResolvedValueOnce({
				domains: {
					serviceDomains: [],
					customDomains: [
						{
							id: "dom-uuid",
							domain: "api.example.com",
							status: {
								dnsRecords: [
									acmeChallengeTxt(),
									trafficRouteCname("edge.railway-target.app"),
								],
							},
						},
					],
				},
			});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.id).toBe("api.example.com");
			expect(result.outs.cnameTarget).toBe("edge.railway-target.app");
		});

		it("extracts the CNAME target from a newly created custom domain", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				}) // find: not found
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: {
							dnsRecords: [trafficRouteCname("edge.railway-target.app")],
						},
					},
				}); // create

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.id).toBe("api.example.com");
			expect(result.outs.cnameTarget).toBe("edge.railway-target.app");
		});

		it("leaves cnameTarget undefined when no traffic-route CNAME record exists yet", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: { dnsRecords: [acmeChallengeTxt()] },
					},
				});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.cnameTarget).toBeUndefined();
		});

		it("exposes verificationTxtName/verificationTxtValue when adopting", async () => {
			mockQuery.mockResolvedValueOnce({
				domains: {
					serviceDomains: [],
					customDomains: [
						{
							id: "dom-uuid",
							domain: "api.example.com",
							status: {
								dnsRecords: [trafficRouteCname("edge.railway-target.app")],
								verificationDnsHost: "_railway-verify.api",
								verificationToken:
									"railway-verify=abc123def456aaf682947c2fb6057206831ceaa1e5906508813",
							},
						},
					],
				},
			});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.verificationTxtName).toBe("_railway-verify.api");

			expect(result.outs.verificationTxtValue).toBe(
				"railway-verify=abc123def456aaf682947c2fb6057206831ceaa1e5906508813",
			);
		});

		it("exposes verificationTxtName/verificationTxtValue when creating fresh", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: {
							dnsRecords: [trafficRouteCname("edge.railway-target.app")],
							verificationDnsHost: "_railway-verify.api",
							verificationToken:
								"railway-verify=abc123def456aaf682947c2fb6057206831ceaa1e5906508813",
						},
					},
				});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.verificationTxtName).toBe("_railway-verify.api");

			expect(result.outs.verificationTxtValue).toBe(
				"railway-verify=abc123def456aaf682947c2fb6057206831ceaa1e5906508813",
			);
		});

		it("leaves verificationTxt fields undefined when Railway reports no verification needed", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: {
							dnsRecords: [trafficRouteCname("edge.railway-target.app")],
							verificationDnsHost: null,
							verificationToken: null,
						},
					},
				});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.verificationTxtName).toBeUndefined();
			expect(result.outs.verificationTxtValue).toBeUndefined();
		});

		it("does not double-prefix a verification token Railway already prefixed", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: {
							dnsRecords: [],
							verificationDnsHost: "_railway-verify.api",
							verificationToken: "railway-verify=already-prefixed-token",
						},
					},
				});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.verificationTxtValue).toBe(
				"railway-verify=already-prefixed-token",
			);
		});

		it("prefixes a bare verification token if Railway ever returns one unprefixed", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					customDomainCreate: {
						id: "dom-new-uuid",
						domain: "api.example.com",
						status: {
							dnsRecords: [],
							verificationDnsHost: "_railway-verify.api",
							verificationToken: "bare-token-no-prefix",
						},
					},
				});

			const result = await new RailwayDomainResourceProvider().create(inputs());

			expect(result.outs.verificationTxtValue).toBe(
				"railway-verify=bare-token-no-prefix",
			);
		});

		it("does not set cnameTarget for a plain service domain (no customDomain)", async () => {
			mockQuery
				.mockResolvedValueOnce({
					domains: { serviceDomains: [], customDomains: [] },
				})
				.mockResolvedValueOnce({
					serviceDomainCreate: { id: "dom-uuid", domain: "svc.up.railway.app" },
				});

			const result = await new RailwayDomainResourceProvider().create({
				...inputs(),
				customDomain: undefined,
			});

			expect(result.outs.cnameTarget).toBeUndefined();
		});

		it("supports multiple custom domains on the same service independently", async () => {
			const bothDomains = {
				domains: {
					serviceDomains: [],
					customDomains: [
						{
							id: "dom-api-uuid",
							domain: "api.example.com",
							status: {
								dnsRecords: [trafficRouteCname("api-target.railway.app")],
							},
						},
						{
							id: "dom-www-uuid",
							domain: "www.example.com",
							status: {
								dnsRecords: [trafficRouteCname("www-target.railway.app")],
							},
						},
					],
				},
			};

			mockQuery.mockResolvedValueOnce(bothDomains); // adopt api.example.com

			const apiResult = await new RailwayDomainResourceProvider().create(
				inputs(),
			);

			expect(apiResult.id).toBe("api.example.com");
			expect(apiResult.outs.cnameTarget).toBe("api-target.railway.app");

			mockQuery.mockResolvedValueOnce(bothDomains); // adopt www.example.com

			const wwwResult = await new RailwayDomainResourceProvider().create({
				...inputs(),
				customDomain: "www.example.com",
			});

			expect(wwwResult.id).toBe("www.example.com");
			expect(wwwResult.outs.cnameTarget).toBe("www-target.railway.app");

			// Deleting one domain only targets its own domainId, never the other's.
			mockQuery.mockResolvedValueOnce({});

			await new RailwayDomainResourceProvider().delete(
				"api.example.com",
				apiResult.outs,
			);

			const [, deleteVars] = mockQuery.mock.calls.at(-1) ?? [];
			expect(deleteVars).toEqual({ id: "dom-api-uuid" });
		});
	});

	describe("delete", () => {
		const props = {
			...inputs(),
			domainId: "dom-uuid",
			fqdn: "api.example.com",
		};

		it("tolerates an already-deleted domain (not-found)", async () => {
			mockQuery.mockRejectedValueOnce(new Error("Domain not found"));

			await expect(
				new RailwayDomainResourceProvider().delete("api.example.com", props),
			).resolves.toBeUndefined();
		});

		it("rethrows a real error", async () => {
			mockQuery.mockRejectedValueOnce(new Error("forbidden"));

			await expect(
				new RailwayDomainResourceProvider().delete("api.example.com", props),
			).rejects.toThrow("forbidden");
		});
	});
});
