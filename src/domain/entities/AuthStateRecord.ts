/**
 * Represents a cryptographic Signal Key or piece of the Baileys AuthState in the database.
 */
export class AuthStateRecord {
  /*-------------------------------------------------------------------
   *				 		     ATTRIBUTES
   *-------------------------------------------------------------------*/
  public workspaceId: number;
  public sessionId: string;
  public keyType: string;
  public keyId: string;
  public serializedData: string;
  public id?: number;

  /*-------------------------------------------------------------------
   * 		 					CONSTRUCTORS
   *-------------------------------------------------------------------*/
  constructor(workspaceId: number, sessionId: string, keyType: string, keyId: string, serializedData: string, id?: number) {
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.keyType = keyType;
    this.keyId = keyId;
    this.serializedData = serializedData;
    this.id = id;
  }
}
