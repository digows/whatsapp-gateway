import { Redis } from 'ioredis';
import { env } from '../../application/config/env.js';

type RedisRole = 'data' | 'coordination';

/**
 * Dedicated Redis clients per responsibility.
 * Signal/authentication traffic can be noisy during sync, so lease/heartbeat should
 * not share the same connection.
 */
export class RedisConnection {
  private static dataClient?: Redis;
  private static coordinationClient?: Redis;

  public static getClient(): Redis {
    return this.getDataClient();
  }

  public static getDataClient(): Redis {
    if (!this.dataClient) {
      this.dataClient = this.createClient('data');
    }

    return this.dataClient;
  }

  public static getCoordinationClient(): Redis {
    if (!this.coordinationClient) {
      this.coordinationClient = this.createClient('coordination');
    }

    return this.coordinationClient;
  }

  public static async close(): Promise<void> {
    await Promise.allSettled([
      this.closeClient('data'),
      this.closeClient('coordination'),
    ]);
  }

  private static createClient(role: RedisRole): Redis {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectionName: `whatsapp-gateway:${env.CHANNEL_PROVIDER_ID}:${role}`,
    });

    client.on('error', err => {
      console.error(`[REDIS:${role}] Error connecting to Redis:`, err);
    });

    console.log(`[REDIS:${role}] Connection initialized.`);
    return client;
  }

  private static async closeClient(role: RedisRole): Promise<void> {
    const client = role === 'data' ? this.dataClient : this.coordinationClient;
    if (!client) {
      return;
    }

    if (role === 'data') {
      this.dataClient = undefined;
    } else {
      this.coordinationClient = undefined;
    }

    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
