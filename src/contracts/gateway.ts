export type ProviderId = string;

export type SessionAddress = {
  provider: ProviderId;
  workspaceId: number;
  sessionId: string;
};

export type ChatType = 'direct' | 'group' | 'broadcast' | 'unknown';

export type IncomingMessageContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image' | 'video' | 'document';
      text?: string;
    }
  | {
      type: 'audio';
    }
  | {
      type: 'other';
    };

export type OutgoingMessageContent = {
  type: 'text' | 'image' | 'audio' | 'video' | 'document';
  text?: string;
  mediaUrl?: string;
};

export type IncomingMessage = {
  messageId: string;
  chatId: string;
  senderId: string;
  participantId?: string;
  workspaceId: number;
  sessionId: string;
  timestamp: string;
  content: IncomingMessageContent;
  context?: {
    chatType: ChatType;
    remoteJid: string;
    participantId?: string;
    senderPhone?: string;
  };
};

export type IncomingMessageEvent = {
  session: SessionAddress;
  message: IncomingMessage;
};

export type OutgoingMessageCommand = {
  commandId: string;
  session: SessionAddress;
  message: {
    recipientId: string;
    content: OutgoingMessageContent;
  };
};

export type DeliveryStatus = 'sent' | 'failed' | 'blocked';

export type DeliveryResultEvent = {
  commandId: string;
  session: SessionAddress;
  recipientId: string;
  status: DeliveryStatus;
  providerMessageId?: string;
  reason?: string;
  timestamp: string;
};

export type SessionStatus =
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'connected'
  | 'reconnecting'
  | 'logged_out';

export type SessionStatusEvent = {
  session: SessionAddress;
  workerId?: string;
  status: SessionStatus;
  reason?: string;
  timestamp: string;
};

export type WorkerCommand = {
  commandId: string;
  action: 'start_session' | 'stop_session';
  session: SessionAddress;
};

export type SessionRuntimeCallbacks = {
  onIncomingMessage: (event: IncomingMessageEvent) => Promise<void>;
  onSessionStatus: (event: SessionStatusEvent) => Promise<void>;
};

export type SessionRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: OutgoingMessageCommand): Promise<DeliveryResultEvent>;
};

export type WorkerTransport = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeWorkerCommands(
    workerId: string,
    handler: (command: WorkerCommand) => Promise<void>,
  ): Promise<void>;
  subscribeOutgoing(
    session: SessionAddress,
    handler: (command: OutgoingMessageCommand) => Promise<void>,
  ): Promise<void>;
  disconnectSession(session: SessionAddress): Promise<void>;
  publishIncoming(event: IncomingMessageEvent): Promise<void>;
  publishDelivery(event: DeliveryResultEvent): Promise<void>;
  publishSessionStatus(event: SessionStatusEvent): Promise<void>;
};

export type WorkerHeartbeatContract = {
  provider: ProviderId;
  workerId: string;
  currentSessions: number;
  maxCapacity: number;
  cpuUsageMicros: number;
  memoryUsageMb: number;
  lastPulse: number;
};
