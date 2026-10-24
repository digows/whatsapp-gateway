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
