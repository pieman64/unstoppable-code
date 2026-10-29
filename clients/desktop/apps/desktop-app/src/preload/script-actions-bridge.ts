import {
  SCRIPT_ACTIONS_CHANNELS,
  isRecord,
  isScriptActionsContext,
  isScriptActionsSnapshot,
  isScriptActionsAddReceipt,
  type ScriptActionsClient,
  type ScriptActionsContext,
  type ScriptActionsAddReceipt,
} from '@canopy/protocol/script-actions';
interface ScriptActionsTransport {
  invoke(channel: string, request: unknown): Promise<unknown>;
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
}
export interface ScriptActionsApi extends ScriptActionsClient {
  onChanged(listener: (context: ScriptActionsContext) => void): () => void;
  onFound(listener: (receipt: ScriptActionsAddReceipt) => void): () => void;
}
export function createScriptActionsBridge(
  transport: ScriptActionsTransport,
): ScriptActionsApi {
  // Listen for the lifetime of the preload so a fast add cannot beat React's
  // subscription. Retain only bounded, validated receipts; hosts dedupe IDs.
  const found = new Map<string, ScriptActionsAddReceipt>();
  const listeners = new Set<(receipt: ScriptActionsAddReceipt) => void>();
  transport.subscribe(SCRIPT_ACTIONS_CHANNELS.found, (value) => {
    if (!isScriptActionsAddReceipt(value)) return;
    found.set(value.operationId, value);
    if (found.size > 100) {
      const first = found.keys().next().value;
      if (first !== undefined) found.delete(first);
    }
    for (const listener of Array.from(listeners)) listener(value);
  });
  const invoke = async <T>(
    channel: string,
    request: unknown,
    guard: (value: unknown) => value is T,
  ): Promise<T> => {
    const raw = await transport.invoke(channel, request);
    if (
      isRecord(raw) &&
      raw.ok === false &&
      isRecord(raw.error) &&
      typeof raw.error.code === 'string' &&
      typeof raw.error.message === 'string'
    )
      throw Object.assign(new Error(raw.error.message), {
        code: raw.error.code,
      });
    if (!isRecord(raw) || raw.ok !== true || !guard(raw.value))
      throw new Error('Invalid script action response.');
    return raw.value;
  };
  return {
    list: (request) =>
      invoke(SCRIPT_ACTIONS_CHANNELS.list, request, isScriptActionsSnapshot),
    rescan: (request) =>
      invoke(SCRIPT_ACTIONS_CHANNELS.rescan, request, isScriptActionsSnapshot),
    review: (request) =>
      invoke(SCRIPT_ACTIONS_CHANNELS.review, request, isScriptActionsSnapshot),
    setShortcut: (request) =>
      invoke(
        SCRIPT_ACTIONS_CHANNELS.setShortcut,
        request,
        isScriptActionsSnapshot,
      ),
    setPinned: (request) =>
      invoke(
        SCRIPT_ACTIONS_CHANNELS.setPinned,
        request,
        isScriptActionsSnapshot,
      ),
    enableShellAliasScan: (request) =>
      invoke(
        SCRIPT_ACTIONS_CHANNELS.enableShellAliasScan,
        request,
        isScriptActionsSnapshot,
      ),
    receipt: (request) =>
      invoke(
        SCRIPT_ACTIONS_CHANNELS.receipt,
        request,
        (value): value is ScriptActionsAddReceipt | null =>
          value === null || isScriptActionsAddReceipt(value),
      ),
    onChanged: (listener) =>
      transport.subscribe(SCRIPT_ACTIONS_CHANNELS.changed, (value) => {
        if (isScriptActionsContext(value)) listener(value);
      }),
    onFound: (listener) => {
      listeners.add(listener);
      for (const receipt of Array.from(found.values())) listener(receipt);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
