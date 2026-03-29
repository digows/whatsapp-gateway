import { AntiBanWarmUpState } from '../entities/AntiBanWarmUpState.js';
import { SessionDescriptor } from '../entities/SessionDescriptor.js';

export interface IAntiBanWarmUpStateRepository {
  load(session: SessionDescriptor): Promise<AntiBanWarmUpState | null>;
  save(session: SessionDescriptor, state: AntiBanWarmUpState): Promise<void>;
}
