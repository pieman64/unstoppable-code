import type { DisplayBlock, DisplayMessage } from '../types/message-display';

const visualPresence = new WeakMap<DisplayMessage, boolean>();
const visualProjections = new WeakMap<DisplayMessage, DisplayMessage>();

function blockHasVisual(block: DisplayBlock): boolean {
  return (
    'result' in block &&
    block.result?.visualRef !== undefined &&
    block.result.isError === false
  );
}

/** Cached by message identity to avoid rescanning collapsed-turn hot rows. */
export function displayMessageHasVisual(message: DisplayMessage): boolean {
  const cached = visualPresence.get(message);
  if (cached !== undefined) return cached;
  const hasVisual = message.blocks.some(blockHasVisual);
  visualPresence.set(message, hasVisual);
  return hasVisual;
}

/** Keep only owning visual result blocks, without rendering their tool rows. */
export function visualOnlyDisplayMessage(
  message: DisplayMessage,
): DisplayMessage {
  const cached = visualProjections.get(message);
  if (cached !== undefined) return cached;
  const projection: DisplayMessage = {
    ...message,
    blocks: message.blocks.filter(blockHasVisual),
  };
  visualProjections.set(message, projection);
  return projection;
}
