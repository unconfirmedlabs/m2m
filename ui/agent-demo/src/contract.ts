import type { DemoValidationPins } from '../../../scripts/demo-types.js';
import type { DemoSnapshot } from './types.js';

/** Called only with a snapshot already accepted by the shared contract. */
export function snapshotPins(snapshot: DemoSnapshot): DemoValidationPins {
  return structuredClone({
    conversation: snapshot.conversation,
    configuration_hash: snapshot.configuration_hash,
    config: snapshot.config,
    agents: { buyer: snapshot.identities.coordinator.agent, provider: snapshot.identities.provider.agent },
  });
}
