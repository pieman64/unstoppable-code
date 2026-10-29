import { CANOPY_INJECTED_TOOL_REGISTRY } from './canopy-injected-tools';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholder(value: string): string {
  const encoded = value.includes(';base64,')
    ? (value.split(';base64,')[1] ?? '')
    : value;
  const bytes = Math.floor((encoded.length * 3) / 4);
  return `Preview screenshot, ${bytes} bytes, not stored`;
}

/**
 * Replace each image entry with a text placeholder in the provider's own
 * text-item shape: Codex reads only `inputText` items, Claude and Cursor
 * `text`.
 */
function removeImages(
  value: unknown,
  textType: 'text' | 'inputText' = 'text',
): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown): unknown => removeImages(item, textType));
  if (!record(value)) return value;
  const source = record(value.source) ? value.source : undefined;
  if (
    (value.type === 'image' ||
      value.type === 'inputImage' ||
      value.type === 'input_image') &&
    (typeof value.data === 'string' ||
      typeof value.imageUrl === 'string' ||
      typeof value.image_url === 'string' ||
      typeof source?.data === 'string')
  ) {
    const encoded =
      typeof value.data === 'string'
        ? value.data
        : typeof value.imageUrl === 'string'
          ? value.imageUrl
          : typeof value.image_url === 'string'
            ? value.image_url
            : source?.data;
    return {
      type: textType,
      text: placeholder(typeof encoded === 'string' ? encoded : ''),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      removeImages(item, textType),
    ]),
  );
}

const CLAUDE_STRUCTURED_RESULT_KEYS = ['tool_use_result', 'toolUseResult'];

function projectClaude(
  value: Record<string, unknown>,
  tracker: PreviewVisualTracker,
): unknown {
  const message = record(value.message) ? value.message : value;
  if (!Array.isArray(message.content)) return value;
  if (value.type === 'assistant') {
    for (const block of message.content) {
      if (
        record(block) &&
        block.type === 'tool_use' &&
        block.name ===
          CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.claudeToolName &&
        typeof block.id === 'string'
      )
        tracker.claudeToolIds.add(block.id);
    }
    return value;
  }
  if (value.type !== 'user') return value;
  let changed = false;
  const content = message.content.map((block: unknown): unknown => {
    if (
      !record(block) ||
      block.type !== 'tool_result' ||
      typeof block.tool_use_id !== 'string' ||
      !tracker.claudeToolIds.has(block.tool_use_id)
    )
      return block;
    changed = true;
    return { ...block, content: removeImages(block.content) };
  });
  if (!changed) return value;
  const projected: Record<string, unknown> =
    message === value
      ? { ...value, content }
      : { ...value, message: { ...message, content } };
  // Claude repeats a tool's result, images included, in a structured copy
  // beside the message: `tool_use_result` live, `toolUseResult` in its log.
  for (const key of CLAUDE_STRUCTURED_RESULT_KEYS) {
    if (key in projected) projected[key] = removeImages(projected[key]);
  }
  return projected;
}

/** Per-turn identity state. Create once before provider events are admitted. */
export interface PreviewVisualTracker {
  claudeToolIds: Set<string>;
}

export function createPreviewVisualTracker(): PreviewVisualTracker {
  return { claudeToolIds: new Set<string>() };
}

/** Remove screenshots at the first shared event seam, before any delivery. */
export function projectPreviewVisualResult(
  event: unknown,
  tracker: PreviewVisualTracker,
): unknown {
  if (!record(event)) return event;
  // The Codex app-server client delivers each notification in an envelope.
  if (event.type === 'codex' && record(event.event)) {
    const inner = projectPreviewVisualResult(event.event, tracker);
    return inner === event.event ? event : { ...event, event: inner };
  }
  if (event.type === 'assistant' || event.type === 'user')
    return projectClaude(event, tracker);
  if (
    record(event.item) &&
    event.item.type === 'dynamic_tool_call' &&
    event.item.tool ===
      CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName
  ) {
    return {
      ...event,
      item: {
        ...event.item,
        ...('content_items' in event.item
          ? {
              content_items: removeImages(
                event.item.content_items,
                'inputText',
              ),
            }
          : {}),
        ...('contentItems' in event.item
          ? {
              contentItems: removeImages(event.item.contentItems, 'inputText'),
            }
          : {}),
        ...('output' in event.item
          ? { output: removeImages(event.item.output, 'inputText') }
          : {}),
      },
    };
  }
  // The Cursor session attaches this host-authored list after the ACP
  // invocation hook has verified providerIdentifier and toolName.
  if (
    event.type === 'canopy_assistant_patch' &&
    event.provider === 'cursor' &&
    'canopyTrustedPreviewToolIds' in event &&
    Array.isArray(event.patches)
  ) {
    const trusted = Array.isArray(event.canopyTrustedPreviewToolIds)
      ? event.canopyTrustedPreviewToolIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : [];
    const safeEvent = { ...event };
    delete safeEvent.canopyTrustedPreviewToolIds;
    if (trusted.length === 0) return safeEvent;
    return {
      ...safeEvent,
      patches: event.patches.map((patch: unknown): unknown => {
        if (
          !record(patch) ||
          !record(patch.block) ||
          patch.block.type !== 'tool_result' ||
          typeof patch.block.toolUseId !== 'string' ||
          !trusted.includes(patch.block.toolUseId) ||
          typeof patch.block.output !== 'string'
        )
          return patch;
        try {
          return {
            ...patch,
            block: {
              ...patch.block,
              output: JSON.stringify(
                removeImages(JSON.parse(patch.block.output)),
              ),
            },
          };
        } catch {
          return patch;
        }
      }),
    };
  }
  return event;
}
