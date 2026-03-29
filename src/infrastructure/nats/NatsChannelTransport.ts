import {
  DeliveryResultEvent,
  IncomingMessageEvent,
  OutgoingMessageCommand,
  ProviderId,
  SessionAddress,
  SessionStatusEvent,
  WorkerCommand,
  WorkerTransport,
} from '../../contracts/gateway.js';
import { Codec, JSONCodec, Subscription } from 'nats';
import { NatsConnection } from './NatsConnection.js';

type WorkerCommandHandler = (command: WorkerCommand) => Promise<void>;
type OutgoingHandler = (command: OutgoingMessageCommand) => Promise<void>;

/**
 * NATS implementation of the shared channel transport contract.
 * Subjects are versioned to keep wire evolution explicit from day one.
 */
export class NatsChannelTransport implements WorkerTransport {
  private readonly workerCommandCodec = JSONCodec<WorkerCommand>();
  private readonly incomingCodec = JSONCodec<IncomingMessageEvent>();
  private readonly outgoingCodec = JSONCodec<OutgoingMessageCommand>();
  private readonly deliveryCodec = JSONCodec<DeliveryResultEvent>();
  private readonly sessionStatusCodec = JSONCodec<SessionStatusEvent>();

  private workerSubscription?: Subscription;
  private readonly outgoingSubscriptions = new Map<string, Subscription>();

  constructor(private readonly providerId: ProviderId) {}

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
    session: SessionAddress,
    handler: OutgoingHandler,
  ): Promise<void> {
    const client = await NatsConnection.getClient();
    const sessionKey = this.getSessionKey(session);

    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    const subscription = client.subscribe(this.getSessionSubject(session, 'outgoing'));
    this.outgoingSubscriptions.set(sessionKey, subscription);

    void this.consume(subscription, this.outgoingCodec, handler, '[NATS] Failed to process outbound command:');
  }

  public async disconnectSession(session: SessionAddress): Promise<void> {
    const sessionKey = this.getSessionKey(session);
    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    this.outgoingSubscriptions.delete(sessionKey);
  }

  public async publishIncoming(event: IncomingMessageEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      this.getSessionSubject(event.session, 'incoming'),
      this.incomingCodec.encode(event),
    );
  }

  public async publishDelivery(event: DeliveryResultEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      this.getSessionSubject(event.session, 'delivery'),
      this.deliveryCodec.encode(event),
    );
  }

  public async publishSessionStatus(event: SessionStatusEvent): Promise<void> {
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
    session: SessionAddress,
    eventType: 'incoming' | 'outgoing' | 'delivery' | 'status',
  ): string {
    return `jarvix.v1.channel.${this.providerId}.session.${session.workspaceId}.${session.sessionId}.${eventType}`;
  }

  private getSessionKey(session: SessionAddress): string {
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
