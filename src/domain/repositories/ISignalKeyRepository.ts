/**
 * Repository enforcing the Data Access pattern for Baileys Signal Keys.
 */
export interface ISignalKeyRepository {
  /**
   * Retrieves multiple keys from the underlying data store (PostgreSQL / Redis).
   */
  getKeys(workspaceId: number, sessionId: string, type: string, ids: string[]): Promise<any[]>;

  /**
   * Persists new or updated cryptographic keys.
   */
  saveKeys(workspaceId: number, sessionId: string, type: string, keys: { [id: string]: any }): Promise<void>;

  /**
   * Deletes specified keys from the datastore.
   */
  removeKeys(workspaceId: number, sessionId: string, type: string, ids: string[]): Promise<void>;

  /**
   * Deletes all keys associated with a sessionId.
   */
  removeAllKeys(workspaceId: number, sessionId: string): Promise<void>;
}
