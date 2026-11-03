import type { SenderRole } from '@protea/protocol';
import type { OwnerIdentity } from '../config/types.js';

/** Maps (source plugin, senderKey) to the owner. The mapping itself is never exposed to plugins. */
export class OwnerRegistry {
  constructor(private identities: readonly OwnerIdentity[]) {}

  update(identities: readonly OwnerIdentity[]): void {
    this.identities = identities;
  }

  hasAny(): boolean {
    return this.identities.length > 0;
  }

  resolve(source: string, senderKey: string | undefined): SenderRole | undefined {
    if (senderKey === undefined) return undefined;
    const match = this.identities.some((i) => i.plugin === source && (i.senderKey === '*' || i.senderKey === senderKey));
    return match ? 'owner' : 'unknown';
  }
}
