export { Gateway, type GatewayConfiguration, type GatewayConnectionFactory } from "./application/gateway.ts";
export { BaileysConnection } from "./infrastructure/baileys/baileys-connection.ts";
export { PostgresGatewayStore } from "./infrastructure/postgres/gateway-store.ts";
export { S3MediaRepository } from "./infrastructure/s3/media-storage.ts";

export { AccountLease, type GatewayStore } from "./domain/gateway-store.ts";
export {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "./infrastructure/sql/storage.ts";

export {
  createMediaStorage,
  type MediaStorageConfiguration,
  type MediaStorageResources,
} from "./infrastructure/s3/configuration.ts";

export { GatewayCommandIngress, GatewayCommandWorker } from "./application/command-ingress.ts";
export { type AccountGrant, GatewayAuthorizationError, GatewayPrincipal } from "./domain/authorization.ts";
export { type ClaimedGatewayCommand, type GatewayCommandInbox } from "./domain/command-inbox.ts";
export { SqlCommandInbox } from "./infrastructure/sql/command-inbox.ts";

export { createGatewayOpenApi } from "./infrastructure/http/openapi.ts";
export {
  type GatewayHttpConfiguration,
  type GatewayHttpConfigurationInput,
  type GatewayHttpCredential,
  GatewayHttpTransport,
  type GatewayHttpWorkspace,
} from "./infrastructure/http/transport.ts";
