import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(value: string): unknown {
  if (value.length > 256 * 1024) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function receipt(value: unknown): string | undefined {
  if (!isRecord(value) || value.isError === true) return undefined;
  return (value.status === 'success' || value.status === 'partial_success') &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    Array.isArray(value.willEnable) &&
    value.willEnable.length > 0
    ? value.requestId
    : undefined;
}

/** Only a completed result paired with the app-owned Load tool can acknowledge. */
export function openCodeDeferredResultReceipts(
  event: unknown,
  appServer: string,
  loadIds: Set<string> = new Set(),
): string[] {
  if (
    !isRecord(event) ||
    event.type !== 'canopy_assistant_patch' ||
    !Array.isArray(event.patches) ||
    event.patches.length > 1000
  )
    return [];
  const blocks = event.patches.flatMap((patch: unknown) =>
    isRecord(patch) && isRecord(patch.block) ? [patch.block] : [],
  );
  const loadName = `mcp__${appServer}__${CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.displayName}`;
  for (const block of blocks) {
    if (
      block.type === 'tool_use' &&
      typeof block.toolUseId === 'string' &&
      isRecord(block.display) &&
      block.display.toolName === loadName &&
      loadIds.size < 128
    )
      loadIds.add(block.toolUseId);
  }
  const receipts = new Set<string>();
  for (const block of blocks) {
    if (
      block.type !== 'tool_result' ||
      typeof block.toolUseId !== 'string' ||
      !loadIds.has(block.toolUseId) ||
      typeof block.output !== 'string'
    )
      continue;
    loadIds.delete(block.toolUseId);
    if (block.isError === true) continue;
    const output = parse(block.output);
    const direct = receipt(output);
    if (direct) receipts.add(direct);
    // Pinned OpenCode 1.18.34 completedToolRawOutput wraps the MCP text.
    if (
      isRecord(output) &&
      output.isError !== true &&
      typeof output.output === 'string'
    ) {
      const native = receipt(parse(output.output));
      if (native) receipts.add(native);
    }
    // Native MCP output is either a result envelope or ACP content blocks.
    const content =
      isRecord(output) && output.isError !== true ? output.content : output;
    if (!Array.isArray(content) || content.length > 100) continue;
    for (const entry of content) {
      const item: unknown =
        isRecord(entry) && entry.type === 'content' ? entry.content : entry;
      if (
        !isRecord(item) ||
        item.type !== 'text' ||
        typeof item.text !== 'string'
      )
        continue;
      const nested = receipt(parse(item.text));
      if (nested) receipts.add(nested);
    }
  }
  return Array.from(receipts);
}
