import crypto from 'crypto';
import os from 'os';

/**
 * Stable identity for the current worker process.
 */
export class WorkerIdentity {
  private static currentIdentity?: WorkerIdentity;

  public static current(): WorkerIdentity {
    if (!this.currentIdentity) {
      this.currentIdentity = new WorkerIdentity(
        `worker-${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`,
      );
    }

    return this.currentIdentity;
  }

  constructor(public readonly id: string) {}

  public toString(): string {
    return this.id;
  }
}
