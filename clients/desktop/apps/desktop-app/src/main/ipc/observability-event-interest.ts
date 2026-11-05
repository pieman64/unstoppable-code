import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';

/** Whether one receiver opted out of audit-entry updates. */
export function shouldDropObservabilityEvent(
  declaration: ChatInterestDeclaration | undefined,
  message: unknown,
): boolean {
  return (
    typeof declaration === 'object' &&
    declaration !== null &&
    'observabilityEntries' in declaration &&
    declaration.observabilityEntries === false &&
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    'type' in message &&
    message.type === 'entries'
  );
}
