import { SessionReference } from '../entities/operational/SessionReference.js';
import { Session } from '../entities/session/Session.js';
import { SessionRepository } from '../repositories/session/SessionRepository.js';

/**
 * Centralizes all durable mutations of the mirrored Session entity.
 * The worker host, activation flow and auth persistence should all converge here
 * instead of writing session state ad hoc.
 */
export class SessionLifecycleService {
  constructor(private readonly sessionRepository: SessionRepository) {}

  public async ensureSession(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.findOrCreateSession(reference, occurredAt);
  }

  public async beginQrCodeActivation(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.beginQrCodeActivation(occurredAt));
  }

  public async beginPairingCodeActivation(
    reference: SessionReference,
    phoneNumber: string,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.beginPairingCodeActivation(phoneNumber, occurredAt));
  }

  public async completeActivation(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.completeActivation(occurredAt));
  }

  public async failActivation(
    reference: SessionReference,
    reason: string,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.failActivation(reason, occurredAt));
  }

  public async expireActivation(
    reference: SessionReference,
    occurredAt: string,
    reason?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.expireActivation(occurredAt, reason));
  }

  public async cancelActivation(
    reference: SessionReference,
    occurredAt: string,
    reason?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.cancelActivation(occurredAt, reason));
  }

  public async markStarting(
    reference: SessionReference,
    workerId: string,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markStarting(workerId, occurredAt));
  }

  public async markConnected(
    reference: SessionReference,
    workerId: string,
    occurredAt: string,
    whatsappJid?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markConnected(workerId, occurredAt, whatsappJid));
  }

  public async markReconnecting(
    reference: SessionReference,
    workerId: string,
    occurredAt: string,
    reason?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markReconnecting(workerId, occurredAt, reason));
  }

  public async markStopping(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markStopping(occurredAt));
  }

  public async markStopped(
    reference: SessionReference,
    occurredAt: string,
    reason?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markStopped(occurredAt, reason));
  }

  public async markFailed(
    reference: SessionReference,
    occurredAt: string,
    reason: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markFailed(occurredAt, reason));
  }

  public async markLoggedOut(
    reference: SessionReference,
    occurredAt: string,
    reason?: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markLoggedOut(occurredAt, reason));
  }

  public async markPersistedCredentials(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.markPersistedCredentials(occurredAt));
  }

  public async clearPersistedCredentials(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    return this.persistSessionTransition(reference, occurredAt, session =>
      session.clearPersistedCredentials(occurredAt));
  }

  private async persistSessionTransition(
    reference: SessionReference,
    occurredAt: string,
    mutator: (session: Session) => Session,
  ): Promise<Session> {
    const currentSession = await this.findOrCreateSession(reference, occurredAt);
    const nextSession = mutator(currentSession);
    await this.sessionRepository.save(nextSession);
    return nextSession;
  }

  private async findOrCreateSession(
    reference: SessionReference,
    occurredAt: string,
  ): Promise<Session> {
    const existingSession = await this.sessionRepository.findByReference(reference);
    if (existingSession) {
      return existingSession;
    }

    const newSession = Session.create(reference, occurredAt);
    await this.sessionRepository.save(newSession);
    return newSession;
  }
}
