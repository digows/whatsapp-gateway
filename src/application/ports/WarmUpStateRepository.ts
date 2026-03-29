import { AntiBanWarmUpState } from '../../domain/entities/antiban/AntiBanWarmUpState.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';

export interface WarmUpStateRepository {
  load(session: SessionReference): Promise<AntiBanWarmUpState | null>;
  save(session: SessionReference, state: AntiBanWarmUpState): Promise<void>;
}
