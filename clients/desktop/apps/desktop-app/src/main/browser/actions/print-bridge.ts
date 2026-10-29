import {
  decodeFrameOwnerBackendNodeId,
  isCDPRecord,
  readCDPArray,
} from '../frames/cdp-decode';
import type { RegisteredFrame } from '../frames/frame-registry';
import type { HostSend } from '../frames/host-cdp';

/**
 * Page-initiated `window.print()` interception (CAN-1570 phase 09b, spike S5):
 * a main-world wrapper installed through `Page.addScriptToEvaluateOnNewDocument`
 * on the root session and on every child session, reporting each call through
 * a `Runtime.addBinding` binding. Main decides what the call becomes: a pending
 * print request during an agent's action, the native print dialog otherwise.
 */

/** The binding the wrapper calls; removed from the page once captured. */
export const PRINT_BINDING = '__canopyPrintRequested';

/** A pending print request ends then, or sooner when its frame navigates. */
export const PRINT_REQUEST_LIFETIME_MS = 10 * 60_000;

/**
 * The isolated world where main replays Blink's own `print()` for a call
 * outside an agent's action: the page's override is not visible there.
 */
export const NATIVE_PRINT_WORLD = '__canopy_native_print';

/**
 * Blink's own `print()`, with its sandbox, throttling, and frame rules. The
 * comment marks the call for E2E stubs.
 */
export const NATIVE_PRINT_EXPRESSION = '/* canopy native print */ print()';

const MARK = '__canopyPrintIntercepted';

/**
 * Idempotent: a document that already has the wrapper keeps it, so the script
 * can also run on a session's current document after it attaches.
 */
export function printBridgeScript(): string {
  const binding = JSON.stringify(PRINT_BINDING);
  const mark = JSON.stringify(MARK);
  return `(() => {
  const root = globalThis;
  if (root.print && root.print[${mark}] === true) return;
  const ask = root[${binding}];
  if (typeof ask !== 'function') return;
  try { delete root[${binding}]; } catch {}
  const print = function print() { ask(''); };
  Object.defineProperty(print, ${mark}, { value: true });
  root.print = print;
})()`;
}

const MAX_FRAME_DEPTH = 32;

/**
 * Whether Blink would ignore this frame's `print()`: it, or a frame it sits
 * in, is an iframe sandboxed without `allow-modals`. The wrapper replaces
 * Blink's `print`, so main applies that rule itself. A frame it cannot
 * resolve counts as blocked. shortcut: reads each owner's `sandbox`
 * attribute, not a CSP `sandbox` header or flags that changed after load;
 * read Blink's frame policy if CDP exposes it.
 */
export async function printBlockedBySandbox(
  deps: {
    getFrame: (frameId: string) => RegisteredFrame | undefined;
    send: HostSend;
  },
  frameId: string,
): Promise<boolean> {
  let frame = deps.getFrame(frameId);
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    if (!frame) return true;
    if (frame.parentId === undefined) return false;
    const parent = deps.getFrame(frame.parentId);
    if (!parent) return true;
    const owner = decodeFrameOwnerBackendNodeId(
      await deps
        .send(
          'DOM.getFrameOwner',
          { frameId: frame.frameId },
          parent.sessionId || undefined,
        )
        .catch(() => undefined),
    );
    if (owner === undefined) return true;
    const described = await deps
      .send(
        'DOM.describeNode',
        { backendNodeId: owner },
        parent.sessionId || undefined,
      )
      .catch(() => undefined);
    const node =
      isCDPRecord(described) && isCDPRecord(described.node)
        ? described.node
        : undefined;
    if (!node) return true;
    const attributes = readCDPArray(node.attributes) ?? [];
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      const name = attributes[index];
      const value = attributes[index + 1];
      if (typeof name !== 'string' || name.toLowerCase() !== 'sandbox')
        continue;
      const tokens =
        typeof value === 'string' ? value.toLowerCase().split(/\s+/) : [];
      if (!tokens.includes('allow-modals')) return true;
    }
    frame = parent;
  }
  return true;
}
