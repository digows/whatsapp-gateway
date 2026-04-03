import { AntiBanWarmUpState } from '../../entities/antiban/AntiBanWarmUpState.js';
import { SessionReference } from '../../entities/operational/SessionReference.js';

/**
 * Persistence contract for warm-up progression used by the anti-ban policy.
 */
export interface WarmUpStateRepository {
  load(session: SessionReference): Promise<AntiBanWarmUpState | null>;
  save(session: SessionReference, state: AntiBanWarmUpState): Promise<void>;
}
