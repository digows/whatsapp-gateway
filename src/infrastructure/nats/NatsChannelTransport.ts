import {
  ChannelDeliveryResultEvent,
  ChannelIncomingMessageEvent,
  ChannelOutgoingMessageCommand,
  ChannelProviderId,
  ChannelSessionAddress,
  ChannelSessionStatusEvent,
  ChannelWorkerCommand,
  IChannelWorkerTransport,
} from '@jarvix/ts-channel-provider';
import { Codec, JSONCodec, Subscription } from 'nats';
import { NatsConnection } from './NatsConnection.js';

type WorkerCommandHandler = (command: ChannelWorkerCommand) => Promise<void>;
type OutgoingHandler = (command: ChannelOutgoingMessageCommand) => Promise<void>;

/**
 * NATS implementation of the shared channel transport contract.
 * Subjects are versioned to keep wire evolution explicit from day one.
 */
export class NatsChannelTransport implements IChannelWorkerTransport {
  private readonly workerCommandCodec = JSONCodec<ChannelWorkerCommand>();
  private readonly incomingCodec = JSONCodec<ChannelIncomingMessageEvent>();
  private readonly outgoingCodec = JSONCodec<ChannelOutgoingMessageCommand>();
  private readonly deliveryCodec = JSONCodec<ChannelDeliveryResultEvent>();
  private readonly sessionStatusCodec = JSONCodec<ChannelSessionStatusEvent>();

  private workerSubscription?: Subscription;
  private readonly outgoingSubscriptions = new Map<string, Subscription>();

  constructor(private readonly providerId: ChannelProviderId) {}

  public async connect(): Promise<void> {
    await NatsConnection.getClient();
  }

  public async disconnect(): Promise<void> {
    this.workerSubscription?.unsubscribe();
    this.workerSubscription = undefined;

    for (const subscription of this.outgoingSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.outgoingSubscriptions.clear();
    await NatsConnection.close();
  }

  public async subscribeWorkerCommands(
    workerId: string,
    handler: WorkerCommandHandler,
  ): Promise<void> {
    const client = await NatsConnection.getClient();

    this.workerSubscription?.unsubscribe();
    const subscription = client.subscribe(this.getWorkerControlSubject(workerId));
    this.workerSubscription = subscription;

    void this.consume(subscription, this.workerCommandCodec, handler, '[NATS] Failed to process worker command:');
  }

  public async subscribeOutgoing(
    session: ChannelSessionAddress,
    handler: OutgoingHandler,
  ): Promise<void> {
    const client = await NatsConnection.getClient();
    const sessionKey = this.getSessionKey(session);

    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    const subscription = client.subscribe(this.getSessionSubject(session, 'outgoing'));
    this.outgoingSubscriptions.set(sessionKey, subscription);

    void this.consume(subscription, this.outgoingCodec, handler, '[NATS] Failed to process outbound command:');
  }

  public async disconnectSession(session: ChannelSessionAddress): Promise<void> {
    const sessionKey = this.getSessionKey(session);
    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    this.outgoingSubscriptions.delete(sessionKey);
  }

  public async publishIncoming(event: ChannelIncomingMessageEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      this.getSessionSubject(event.session, 'incoming'),
      this.incomingCodec.encode(event),
    );
  }

  public async publishDelivery(event: ChannelDeliveryResultEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      this.getSessionSubject(event.session, 'delivery'),
      this.deliveryCodec.encode(event),
    );
  }

  public async publishSessionStatus(event: ChannelSessionStatusEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      this.getSessionSubject(event.session, 'status'),
      this.sessionStatusCodec.encode(event),
    );
  }

  private getWorkerControlSubject(workerId: string): string {
    return `jarvix.v1.channel.${this.providerId}.worker.${workerId}.control`;
  }

  private getSessionSubject(
    session: ChannelSessionAddress,
    eventType: 'incoming' | 'outgoing' | 'delivery' | 'status',
  ): string {
    return `jarvix.v1.channel.${this.providerId}.session.${session.workspaceId}.${session.sessionId}.${eventType}`;
  }

  private getSessionKey(session: ChannelSessionAddress): string {
    return `${session.provider}:${session.workspaceId}:${session.sessionId}`;
  }

  private async consume<T>(
    subscription: Subscription,
    codec: Codec<T>,
    handler: (payload: T) => Promise<void>,
    errorMessage: string,
  ): Promise<void> {
    for await (const message of subscription) {
      try {
        const payload = codec.decode(message.data);
        await handler(payload);
      } catch (error) {
        console.error(errorMessage, error);
      }
    }
  }
}
