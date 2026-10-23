import { BufferJSON, proto, type WAMessage, type WAMessageKey } from "baileys";

interface CachedMessage
{
  readonly serializedMessage: string;
  readonly expiresAt: number;
  readonly serializedEnvelope?: string;
}

// This is a bounded retry cache, not a second durable message store. The gateway retains durable event originals separately.
export class BaileysMessageCache
{
  private readonly messages = new Map<string, CachedMessage>();

  constructor(private readonly capacity = 512, private readonly retentionMs = 3600000)
  {}

  remember(key: WAMessageKey, message: proto.IMessage | null | undefined, now = Date.now()): void
  {
    if (!key.id || !key.remoteJid || !message) return;
    const identity = JSON.stringify([key.remoteJid, key.id]);
    this.messages.delete(identity);
    this.messages.set(identity, {
      serializedMessage: JSON.stringify(message, BufferJSON.replacer),
      expiresAt: now + this.retentionMs,
    });
    for (const [identity, cached] of this.messages)
    {
      if (cached.expiresAt <= now || this.messages.size > this.capacity) this.messages.delete(identity);
    }
  }

  rememberMessage(message: WAMessage, now = Date.now()): void
  {
    this.remember(message.key, message.message, now);
    const identity = JSON.stringify([message.key.remoteJid, message.key.id]);
    const cached = this.messages.get(identity);
    if (cached !== undefined)
    {
      const envelope = { ...cached, serializedEnvelope: JSON.stringify(message, BufferJSON.replacer) };
      this.messages.set(identity, envelope);
      if (message.key.remoteJidAlt)
      {
        this.messages.set(JSON.stringify([message.key.remoteJidAlt, message.key.id]), envelope);
      }
      while (this.messages.size > this.capacity)
      {
        const oldest = this.messages.keys().next().value;
        if (oldest === undefined) break;
        this.messages.delete(oldest);
      }
    }
  }

  readMessage(key: WAMessageKey, now = Date.now()): WAMessage | undefined
  {
    const cached = this.lookup(key, now);
    if (cached?.serializedEnvelope === undefined) return undefined;
    const value: unknown = JSON.parse(cached.serializedEnvelope, BufferJSON.reviver);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const message = proto.WebMessageInfo.fromObject(value);
    if (!message.key) return undefined;
    const rawKey = "key" in value ? value.key : undefined;
    if (typeof rawKey !== "object" || rawKey === null) return undefined;
    const restoredKey = Object.assign(message.key, {
      ...("remoteJidAlt" in rawKey && typeof rawKey.remoteJidAlt === "string"
        ? { remoteJidAlt: rawKey.remoteJidAlt }
        : {}),
      ...("participantAlt" in rawKey && typeof rawKey.participantAlt === "string"
        ? { participantAlt: rawKey.participantAlt }
        : {}),
    });
    return Object.assign(message, { key: restoredKey });
  }

  read(key: WAMessageKey, now = Date.now()): proto.IMessage | undefined
  {
    const cached = this.lookup(key, now);
    if (cached === undefined) return undefined;
    const value: unknown = JSON.parse(cached.serializedMessage, BufferJSON.reviver);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return proto.Message.fromObject(value);
  }

  private lookup(key: WAMessageKey, now: number): CachedMessage | undefined
  {
    const identity = JSON.stringify([key.remoteJid, key.id]);
    const cached = this.messages.get(identity);
    if (cached === undefined) return undefined;
    if (cached.expiresAt <= now)
    {
      this.messages.delete(identity);
      return undefined;
    }
    return cached;
  }
}
