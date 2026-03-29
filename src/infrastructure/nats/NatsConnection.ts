import { connect, NatsConnection as CoreNatsConnection } from 'nats';
import { env } from '../../application/config/env.js';

export class NatsConnection {
  private static instance: CoreNatsConnection | null = null;
  private static isConnecting = false;
  private static connectionName = 'jarvix-whatsapp-provider';

  public static async connect(name = this.connectionName): Promise<CoreNatsConnection> {
    if (this.instance) {
      return this.instance;
    }

    if (this.isConnecting) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return this.connect(name);
    }

    this.connectionName = name;
    this.isConnecting = true;

    try {
      const options = this.buildConnectOptions();
      this.instance = await connect({
        servers: [options.server],
        user: options.user,
        pass: options.pass,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        name: this.connectionName,
      });

      console.log(
        `[NATS] Connected successfully to ${options.sanitizedServer} as ${this.connectionName}`,
      );

      void (async () => {
        if (!this.instance) {
          return;
        }

        for await (const status of this.instance.status()) {
          if (status.type === 'pingTimer') {
            continue;
          }
          console.log(`[NATS] Status update: ${status.type} - ${status.data}`);
        }
      })();
    } catch (error) {
      console.error('[NATS] Fatal: failed to connect to broker', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }

    return this.instance;
  }

  private static buildConnectOptions(): {
    server: string;
    sanitizedServer: string;
    user?: string;
    pass?: string;
  } {
    const rawUrl = env.NATS_URL.trim();
    const normalizedUrl = rawUrl.includes('://') ? rawUrl : `nats://${rawUrl}`;
    const parsed = new URL(normalizedUrl);
    const protocol = parsed.protocol || 'nats:';
    const host = parsed.host;

    if (!host) {
      throw new Error(`Invalid NATS_URL: "${env.NATS_URL}"`);
    }

    return {
      server: `${protocol}//${host}`,
      sanitizedServer: `${protocol}//${host}`,
      user: parsed.username || undefined,
      pass: parsed.password || undefined,
    };
  }

  public static async getClient(): Promise<CoreNatsConnection> {
    return this.instance ?? this.connect();
  }

  public static async close(): Promise<void> {
    if (!this.instance) {
      return;
    }

    const client = this.instance;
    this.instance = null;
    const closeGracefully = async () => {
      await client.drain().catch(error => {
        console.warn('[NATS] Failed to drain connection cleanly:', error);
        return client.close();
      });
    };

    await Promise.race([
      closeGracefully(),
      new Promise<void>(resolve => {
        setTimeout(() => {
          console.warn('[NATS] Drain timeout reached. Closing connection forcefully.');
          void client.close().finally(resolve);
        }, 1000).unref();
      }),
    ]);
  }
}
