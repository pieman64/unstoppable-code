import { memo, type JSX } from 'react';
import { SteerIcon } from '../../icons';

/**
 * True when a neutral Portal message carries the picked-up steering marker
 * for an input the provider consumed *inside* a running turn.
 *
 * A steer picked up after its turn already settled starts a brand new turn
 * (`data.startsTurn === true`), so it is an ordinary prompt and must not wear
 * the "Steering" title — it anchors its own turn group the same way a typed
 * message does.
 */
export function hasSteeringChatPart(parts: unknown): boolean {
  return (
    Array.isArray(parts) &&
    parts.some((part: unknown) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        Array.isArray(part) ||
        !('kind' in part) ||
        part.kind !== 'steering'
      ) {
        return false;
      }
      const data: unknown = 'data' in part ? part.data : undefined;
      return !(
        typeof data === 'object' &&
        data !== null &&
        'startsTurn' in data &&
        data.startsTurn === true
      );
    })
  );
}

/** Title row shown above a user message after a steering input is picked up. */
export const SteeringTitle = memo(function SteeringTitle(): JSX.Element {
  return (
    <span
      data-testid="steering-title"
      className="mb-1 flex items-center gap-1.5 text-3xs font-medium fg-secondary"
    >
      <SteerIcon
        data-testid="steering-title-icon"
        width={11}
        height={11}
        className="shrink-0"
      />
      <span>Steering</span>
    </span>
  );
});
