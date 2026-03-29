import crypto from 'crypto';
import os from 'os';

/**
 * Stable identity for the current worker process.
 * This belongs to the technical domain because session ownership and heartbeat
 * are first-class concepts of this microservice.
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

  public static getId(): string {
    return this.current().id;
  }

  private constructor(public readonly id: string) {}

  public toString(): string {
    return this.id;
  }
}
