import { z } from 'zod';
import * as dotenv from 'dotenv';
import path from 'path';

// Load local .env if not injected natively via containers/pipelines
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  /**
   * If omitted, the application connects directly via the machine's native IP (Dev).
   */
  RESIDENTIAL_PROXY_URL: z.string().url().or(z.literal('')).optional(),

  /**
   * PostgreSQL connection string for persistent AuthState storage.
   */
  POSTGRES_URL: z.string().url().default('postgresql://localhost:5432/jarvix'),

  /**
   * PostgreSQL Schema name for this provider.
   */
  DB_SCHEMA: z.string().default('channel_provider_whatsapp_web'),

  /**
   * Redis connection string for high-speed cache and Distributed Locking.
   */
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  /**
   * NATS JetStream connection string for asynchronous message broker integration.
   */
  NATS_URL: z.string().default('nats://localhost:4222'),

  /**
   * NATS subjects used by the worker runtime.
   * Supported placeholders:
   * {provider} {workerId} {workspaceId} {sessionId}
   */
  NATS_SUBJECT_CONTROL_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.worker.{workerId}.control'),
  NATS_SUBJECT_INBOUND_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.incoming'),
  NATS_SUBJECT_OUTBOUND_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.outgoing'),
  NATS_SUBJECT_DELIVERY_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.delivery'),
  NATS_SUBJECT_STATUS_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.status'),
  NATS_SUBJECT_ACTIVATION_TEMPLATE: z.string().default('gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.activation'),

  /**
   * Redis key namespace and templates.
   * Supported placeholders:
   * {prefix} {provider} {workerId} {workspaceId} {sessionId} {type} {id} {jid}
   */
  REDIS_KEY_PREFIX: z.string().default('wa'),
  REDIS_KEY_SESSION_LOCK_TEMPLATE: z.string().default('{prefix}:{workspaceId}:lock:session:{sessionId}'),
  REDIS_KEY_SESSION_WORKER_REGISTRY_TEMPLATE: z.string().default('{prefix}:{workspaceId}:registry:workers'),
  REDIS_KEY_CLUSTER_ALIVE_TEMPLATE: z.string().default('{prefix}:cluster:alive:{workerId}'),
  REDIS_KEY_CLUSTER_HEALTH_TEMPLATE: z.string().default('{prefix}:cluster:health'),
  REDIS_KEY_AUTH_RECORD_TEMPLATE: z.string().default('{prefix}:{workspaceId}:auth:{sessionId}:{type}:{id}'),
  REDIS_KEY_AUTH_SESSION_PATTERN_TEMPLATE: z.string().default('{prefix}:{workspaceId}:auth:{sessionId}:*'),
  REDIS_KEY_LID_MAPPING_TEMPLATE: z.string().default('{prefix}:{workspaceId}:lid-mapping:{jid}'),
  REDIS_KEY_ANTI_BAN_WARMUP_TEMPLATE: z.string().default('{prefix}:{provider}:{workspaceId}:antiban:warmup:{sessionId}'),

  /**
   * Development-only bootstrap session used by src/dev.ts.
   */
  DEV_WORKSPACE_ID: z.coerce.number().default(1),
  DEV_SESSION_ID: z.string().default('local-onboarding-session'),

  /**
   * Maximum Number of concurrent WhatsApp sessions allowed per worker process.
   * Recommended: 50-100 based on Node.js single-thread limits.
   */
  MAX_CONCURRENT_SESSIONS: z.coerce.number().default(50),

  /**
   * Internal logger verbosity level.
   */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Baileys internal logger verbosity level.
   * Keep this stricter than LOG_LEVEL to avoid leaking WhatsApp protocol noise.
   */
  BAILEYS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('warn'),

  /**
   * Option to disable distributed locking for single-node local environments.
   */
  DISABLE_REDLOCK: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),

  /**
   * Session lease timing for distributed ownership.
   */
  SESSION_LOCK_TTL_MS: z.coerce.number().default(120000),
  SESSION_LOCK_HEARTBEAT_MS: z.coerce.number().default(45000),

  /**
   * Enables outbound anti-ban protections such as delay, rate limits and risk-based pausing.
   */
  ANTI_BAN_ENABLED: z.preprocess((v) => v !== 'false' && v !== false, z.boolean().default(true)),

  /**
   * Outbound delay boundaries.
   */
  ANTI_BAN_MIN_DELAY_MS: z.coerce.number().default(1500),
  ANTI_BAN_MAX_DELAY_MS: z.coerce.number().default(5000),
  ANTI_BAN_NEW_CHAT_DELAY_MS: z.coerce.number().default(3000),
  ANTI_BAN_MAX_COOLDOWN_MS: z.coerce.number().default(120000),
  ANTI_BAN_BURST_ALLOWANCE: z.coerce.number().default(3),

  /**
   * Global throughput safety rails.
   */
  ANTI_BAN_MAX_PER_MINUTE: z.coerce.number().default(8),
  ANTI_BAN_MAX_PER_HOUR: z.coerce.number().default(200),
  ANTI_BAN_MAX_PER_DAY: z.coerce.number().default(1500),

  /**
   * Duplicate text protection, warm-up and risk thresholds.
   */
  ANTI_BAN_MAX_IDENTICAL_MESSAGES: z.coerce.number().default(3),
  ANTI_BAN_ZERO_WIDTH_VARIATION_ENABLED: z.preprocess((v) => v !== 'false' && v !== false, z.boolean().default(true)),
  ANTI_BAN_PUNCTUATION_VARIATION_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  ANTI_BAN_WARMUP_ENABLED: z.preprocess((v) => v !== 'false' && v !== false, z.boolean().default(true)),
  ANTI_BAN_WARMUP_DAYS: z.coerce.number().default(7),
  ANTI_BAN_WARMUP_DAY1_LIMIT: z.coerce.number().default(60),
  ANTI_BAN_WARMUP_GROWTH_FACTOR: z.coerce.number().default(1.6),
  ANTI_BAN_WARMUP_INACTIVITY_THRESHOLD_HOURS: z.coerce.number().default(168),
  ANTI_BAN_WARMUP_MISSING_STATE_MODE: z.enum(['graduated', 'warming']).default('graduated'),
  ANTI_BAN_WARMUP_STATE_TTL_SECONDS: z.coerce.number().default(15552000),
  ANTI_BAN_HEALTH_DISCONNECT_WARNING_THRESHOLD: z.coerce.number().default(3),
  ANTI_BAN_HEALTH_DISCONNECT_CRITICAL_THRESHOLD: z.coerce.number().default(5),
  ANTI_BAN_HEALTH_FAILED_MESSAGE_THRESHOLD: z.coerce.number().default(5),
  ANTI_BAN_LOG_RISK_CHANGES: z.preprocess((v) => v !== 'false' && v !== false, z.boolean().default(true)),
  ANTI_BAN_AUTO_PAUSE_AT: z.enum(['low', 'medium', 'high', 'critical']).default('critical'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid or missing environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
