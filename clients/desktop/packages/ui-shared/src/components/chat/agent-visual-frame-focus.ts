/**
 * What the host remembers about typing and focus across every visual in a
 * window, so one frame's remount does not forget it.
 */

/** Keys that type nothing; pressing one says nothing about where typing goes. */
export const AGENT_VISUAL_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
]);

interface PointerPosition {
  x: number;
  y: number;
}
interface HostPointerRecord {
  /** The last move the host saw, and where the pointer was before it. */
  event: Event | null;
  at: PointerPosition | null;
  before: PointerPosition | null;
}

const hostKeys = new WeakMap<Document, { at: number }>();
const hostPointers = new WeakMap<Document, HostPointerRecord>();
const visualsNeedingClick = new Set<string>();
const needsClickListeners = new Set<() => void>();

function hostKeyRecord(ownerDocument: Document): { at: number } {
  const existing = hostKeys.get(ownerDocument);
  if (existing) return existing;
  const record = { at: 0 };
  // A key pressed while a frame holds focus goes to that frame and is not
  // seen here, so this is typing in the app itself.
  ownerDocument.addEventListener(
    'keydown',
    (event): void => {
      if (!AGENT_VISUAL_MODIFIER_KEYS.has(event.key)) record.at = Date.now();
    },
    true,
  );
  hostKeys.set(ownerDocument, record);
  return record;
}

/** Start noting when the user types in this document. Safe to repeat. */
export function watchHostTyping(ownerDocument: Document): void {
  hostKeyRecord(ownerDocument);
}

/** When the user last typed in this document, or 0. */
export function lastHostTypingAt(ownerDocument: Document): number {
  return hostKeyRecord(ownerDocument).at;
}

function hostPointerRecord(ownerDocument: Document): HostPointerRecord {
  const existing = hostPointers.get(ownerDocument);
  if (existing) return existing;
  const record: HostPointerRecord = { event: null, at: null, before: null };
  // Capture runs before the visual's own handler, so it can read where the
  // pointer was before the move it is handling.
  ownerDocument.addEventListener(
    'pointermove',
    (event): void => {
      if (event.pointerType === 'touch') return;
      record.event = event;
      record.before = record.at;
      record.at = { x: event.clientX, y: event.clientY };
    },
    true,
  );
  hostPointers.set(ownerDocument, record);
  return record;
}

/** Start noting where the pointer moves in this document. Safe to repeat. */
export function watchHostPointer(ownerDocument: Document): void {
  hostPointerRecord(ownerDocument);
}

/**
 * Where this document last saw the pointer before `event`, or null. A frame
 * holds the pointer out of the document's sight while it is over the frame.
 */
export function hostPointerBefore(
  ownerDocument: Document,
  event: Event,
): PointerPosition | null {
  const record = hostPointerRecord(ownerDocument);
  return record.event === event ? record.before : record.at;
}

/**
 * A visual that took focus with no gesture inside it. It is told apart by its
 * document, so it stays known when its frame is unmounted and shown again.
 */
export function rememberAgentVisualNeedsClick(document: string): void {
  if (visualsNeedingClick.has(document)) return;
  visualsNeedingClick.add(document);
  for (const listener of [...needsClickListeners]) listener();
}

export function agentVisualNeedsClick(document: string): boolean {
  return visualsNeedingClick.has(document);
}

/**
 * Tells every mounted copy of a visual, such as the one in the transcript and
 * the one in the Chat visuals panel, when one of them was refused.
 */
export function subscribeAgentVisualNeedsClick(
  listener: () => void,
): () => void {
  needsClickListeners.add(listener);
  return (): void => {
    needsClickListeners.delete(listener);
  };
}

/** Test-only: forget typing, the pointer, and refused visuals. */
export function resetAgentVisualFocusForTests(ownerDocument: Document): void {
  hostKeyRecord(ownerDocument).at = 0;
  const pointer = hostPointerRecord(ownerDocument);
  pointer.event = null;
  pointer.at = null;
  pointer.before = null;
  visualsNeedingClick.clear();
  for (const listener of [...needsClickListeners]) listener();
}
