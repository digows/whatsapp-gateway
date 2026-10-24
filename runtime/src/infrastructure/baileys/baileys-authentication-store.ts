import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";
import type { AuthenticationMutation as WhatsAppAuthenticationMutation } from "../../domain/gateway-store.ts";
export interface AuthenticationRecords
{
  readAuthentication(accountId: string, category: string, keyId: string): Promise<string | null>;
  writeAuthentication(accountId: string, mutations: readonly WhatsAppAuthenticationMutation[]): Promise<void>;
  clearAuthentication(accountId: string): Promise<void>;
}

type AuthenticationFailureHandler = (error: unknown) => void;

type SignalValues<Category extends keyof SignalDataTypeMap> = Record<string, SignalDataTypeMap[Category]>;

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKeyPair(value: unknown): boolean
{
  return isRecord(value) && value["public"] instanceof Uint8Array && value["private"] instanceof Uint8Array;
}

function isCredentials(value: unknown): value is AuthenticationCreds
{
  if (!isRecord(value) || !isRecord(value["signedPreKey"]) || !isRecord(value["accountSettings"]))
  {
    return false;
  }
  return isKeyPair(value["noiseKey"]) && isKeyPair(value["pairingEphemeralKeyPair"])
    && isKeyPair(value["signedIdentityKey"]) && isKeyPair(value["signedPreKey"]["keyPair"])
    && value["signedPreKey"]["signature"] instanceof Uint8Array
    && typeof value["signedPreKey"]["keyId"] === "number"
    && typeof value["registrationId"] === "number" && typeof value["advSecretKey"] === "string"
    && typeof value["firstUnuploadedPreKeyId"] === "number" && typeof value["nextPreKeyId"] === "number"
    && Array.isArray(value["processedHistoryMessages"]) && typeof value["accountSyncCounter"] === "number"
    && typeof value["accountSettings"]["unarchiveChats"] === "boolean"
    && typeof value["registered"] === "boolean";
}

function isSignalValue<Category extends keyof SignalDataTypeMap>(
  category: Category,
  value: unknown,
): value is SignalDataTypeMap[Category]
{
  switch (category)
  {
    case "session":
      // The pinned Baileys declaration says Uint8Array, but libsignal 6 serializes
      // SessionRecord as { version, _sessions }. Preserve that native JSON object.
      return isRecord(value) && typeof value["version"] === "string" && isRecord(value["_sessions"]);
    case "sender-key":
    case "identity-key":
      return value instanceof Uint8Array;
    case "pre-key":
      return isKeyPair(value);
    case "lid-mapping":
      return typeof value === "string";
    case "device-list":
      return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
    case "sender-key-memory":
      return isRecord(value) && Object.values(value).every((item) => typeof item === "boolean");
    case "app-state-sync-key":
      return isRecord(value) && (value["keyData"] === undefined || value["keyData"] instanceof Uint8Array);
    case "app-state-sync-version":
      return isRecord(value) && typeof value["version"] === "number"
        && Buffer.isBuffer(value["hash"]) && isRecord(value["indexValueMap"]);
    case "tctoken":
      return isRecord(value) && Buffer.isBuffer(value["token"]);
  }
}

export class BaileysAuthenticationStore
{
  private readonly cache = new Map<string, string | null>();
  private state: AuthenticationState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly accountId: string,
    private readonly repository: AuthenticationRecords,
    private readonly failed?: AuthenticationFailureHandler,
  )
  {}

  async load(): Promise<AuthenticationState>
  {
    const serialized = await this.read("credentials", "default");
    const credentials: unknown = serialized === null
      ? initAuthCreds()
      : JSON.parse(serialized, BufferJSON.reviver);
    if (!isCredentials(credentials)) throw new Error("Invalid persisted WhatsApp credentials");
    this.state = {
      creds: credentials,
      keys: {
        get: <Category extends keyof SignalDataTypeMap>(category: Category, ids: string[]) =>
          this.getKeys(category, ids),
        set: (values: SignalDataSet) => this.setKeys(values),
      },
    };
    return this.state;
  }

  async saveCredentials(): Promise<void>
  {
    if (this.state === null) throw new Error("Authentication state is not loaded");
    await this.write([{
      category: "credentials",
      keyId: "default",
      serializedValue: JSON.stringify(this.state.creds, BufferJSON.replacer),
    }]);
  }

  async flush(): Promise<void>
  {
    await this.writeQueue;
  }

  async clear(): Promise<void>
  {
    await this.flush();
    await this.repository.clearAuthentication(this.accountId);
    this.cache.clear();
    this.state = null;
  }

  private async read(category: string, keyId: string): Promise<string | null>
  {
    await this.flush();
    const cacheKey = JSON.stringify([category, keyId]);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    const serialized = await this.repository.readAuthentication(this.accountId, category, keyId);
    // A concurrent key write may have committed while the database read was in flight.
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    this.cache.set(cacheKey, serialized);
    return serialized;
  }

  private async getKeys<Category extends keyof SignalDataTypeMap>(
    category: Category,
    ids: string[],
  ): Promise<SignalValues<Category>>
  {
    const values: SignalValues<Category> = {};
    for (const keyId of ids)
    {
      const serialized = await this.read(category, keyId);
      if (serialized === null) continue;
      let value: unknown = JSON.parse(serialized, BufferJSON.reviver);
      if (category === "app-state-sync-key" && isRecord(value))
      {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      if (!isSignalValue(category, value)) throw new Error("Invalid persisted WhatsApp signal key");
      values[keyId] = value;
    }
    return values;
  }

  private async setKeys(values: SignalDataSet): Promise<void>
  {
    const mutations: WhatsAppAuthenticationMutation[] = [];
    for (const [category, keys] of Object.entries(values))
    {
      for (const [keyId, value] of Object.entries(keys))
      {
        mutations.push({
          category,
          keyId,
          serializedValue: value === null || value === undefined
            ? null
            : JSON.stringify(value, BufferJSON.replacer),
        });
      }
    }
    await this.write(mutations);
  }

  private async write(mutations: readonly WhatsAppAuthenticationMutation[]): Promise<void>
  {
    const task = this.writeQueue.then(async () =>
    {
      await this.repository.writeAuthentication(this.accountId, mutations);
      for (const mutation of mutations)
      {
        this.cache.set(JSON.stringify([mutation.category, mutation.keyId]), mutation.serializedValue);
      }
    });
    this.writeQueue = task;
    try
    {
      await task;
    }
    catch (error)
    {
      this.failed?.(error);
      throw error;
    }
  }
}
