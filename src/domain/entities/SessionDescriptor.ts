import { SessionAddress } from '../../shared/contracts/gateway.js';

/**
 * Canonical identifier for a hosted WhatsApp session.
 */
export class SessionDescriptor implements SessionAddress {
  constructor(
    public readonly provider: string,
    public readonly workspaceId: number,
    public readonly sessionId: string,
  ) {}

  public toKey(): string {
    return `${this.provider}:${this.workspaceId}:${this.sessionId}`;
  }

  public toLogLabel(): string {
    return `${this.provider} session ${this.sessionId} (WS: ${this.workspaceId})`;
  }
}
