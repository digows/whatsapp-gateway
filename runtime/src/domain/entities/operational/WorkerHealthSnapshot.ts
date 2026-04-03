/**
 * Lightweight health snapshot of the current worker process.
 * It exists so the HTTP layer can return a concrete entity instead of ad hoc payloads.
 */
export class WorkerHealthSnapshot {
  constructor(
    public readonly status: 'ok' | 'not_ready',
    public readonly providerId: string,
    public readonly workerId: string,
    public readonly started: boolean,
    public readonly hostedSessionCount: number,
    public readonly checkedAt: string,
  ) {}
}
