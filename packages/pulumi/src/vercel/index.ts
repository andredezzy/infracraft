// The typed not-found this provider's client throws — consumers catch by instanceof.
export { ApiNotFoundError } from "../errors/api-not-found-error";
export { VercelClient } from "./client";
export type { VercelDeployArgs } from "./deploy";
export { VercelDeploy } from "./deploy";
export type { VercelDomainArgs } from "./domain";
export { VercelDomain } from "./domain";
export type { VercelIntegrationArgs } from "./integration";
export { VercelIntegration } from "./integration";
export type { VercelMarketplaceResourceArgs } from "./marketplace-resource";
export { VercelMarketplaceResource } from "./marketplace-resource";
export type { VercelFramework, VercelProjectArgs } from "./project";
export { VERCEL_FRAMEWORKS, VercelProject } from "./project";
export type { VercelProviderArgs } from "./provider";
export { VercelProvider } from "./provider";
export type { VercelResourceConnectionArgs } from "./resource-connection";
export { VercelResourceConnection } from "./resource-connection";
