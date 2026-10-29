// Byte breakdown of captured OpenAI Responses requests (HTTP bodies and
// WebSocket `response.create` frames). Pure: reads capture records only.
//
// A record carries `json` only when the complete bytes parsed. For a
// `previous_response_id` delta the input holds only new items; the effective
// prompt is reconstructed approximately from the referenced record (the model
// output items between them are not in the capture, so they are flagged).

const enc = new TextEncoder();
const bytesOf = (value) =>
  enc.encode(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .length;

/** Text of one input item (for classification only). */
export function itemText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (typeof item.output === 'string') return item.output;
  if (typeof item.arguments === 'string') return item.arguments;
  if (Array.isArray(item.content))
    return item.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  if (typeof item.content === 'string') return item.content;
  return JSON.stringify(item);
}

/**
 * Classify one input item.
 * @param {unknown} item
 * @param {{ agentsTokens?: string[] }} [options] canary tokens that mark the global AGENTS item
 */
export function classifyInputItem(item, options = {}) {
  const type = item?.type ?? (item?.role ? 'message' : 'unknown');
  if (
    type === 'function_call_output' ||
    type === 'custom_tool_call_output' ||
    /_output$/.test(String(type))
  )
    return 'tool_output';
  if (type === 'function_call' || type === 'custom_tool_call')
    return 'tool_call';
  if (type === 'reasoning') return 'reasoning';
  const text = itemText(item);
  if (item?.role === 'assistant') return 'assistant';
  if (item?.role === 'developer' || item?.role === 'system') return 'developer';
  if (item?.role === 'user') {
    if (/\[Canopy-C[A-Za-z0-9_-]+\]/.test(text)) return 'user_prompt';
    if (
      /AGENTS\.md instructions/i.test(text) ||
      (options.agentsTokens ?? []).some(
        (token) => token && text.includes(token),
      )
    )
      return 'global_agents';
    return 'user_other';
  }
  return 'other';
}

/** Tool names in a request's `tools`, flattening namespaces as `ns.name`. */
export function toolSurface(json) {
  const names = [];
  const declarations = [
    ...(Array.isArray(json?.tools) ? json.tools : []),
    ...(Array.isArray(json?.input) ? json.input : []).flatMap((item) =>
      item?.type === 'additional_tools' && Array.isArray(item.tools)
        ? item.tools
        : [],
    ),
  ];
  for (const tool of declarations) {
    if (Array.isArray(tool?.tools)) {
      for (const inner of tool.tools)
        names.push(`${tool.name ?? tool.type}.${inner?.name ?? inner?.type}`);
    } else names.push(tool?.name ?? tool?.type ?? 'unknown');
  }
  return names;
}

/** True for a record that is a Responses generation request (not a prewarm). */
export function isGenerationRecord(record) {
  return (
    record?.surface === 'openai-responses' &&
    (record.kind === 'ws-message' ||
      (record.kind === 'http' && record.method === 'POST')) &&
    (record.prompt === 'full' || record.prompt === 'delta')
  );
}

/**
 * Summarize one generation record.
 *
 * @param {object} record capture record
 * @param {{ agentsTokens?: string[] }} [options]
 */
export function summarizeResponsesRequest(record, options = {}) {
  const json = record?.json;
  const base = {
    seq: record?.seq ?? null,
    kind: record?.kind ?? null,
    totalBytes: record?.byteLength ?? 0,
    complete: Boolean(record?.complete),
  };
  if (!json || typeof json !== 'object')
    return {
      ...base,
      parsed: false,
      reason: `parse=${record?.parse ?? 'missing'}`,
    };
  const input = Array.isArray(json.input) ? json.input : [];
  const instructionsBytes =
    typeof json.instructions === 'string' ? bytesOf(json.instructions) : 0;
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const toolsBytes = tools.length ? bytesOf(tools) : 0;
  const classBytes = {};
  const items = input.map((item, index) => {
    const cls = classifyInputItem(item, options);
    const bytes = bytesOf(item);
    classBytes[cls] = (classBytes[cls] ?? 0) + bytes;
    return {
      index,
      type: item?.type ?? (item?.role ? 'message' : 'unknown'),
      role: item?.role ?? null,
      class: cls,
      bytes,
    };
  });
  const inputBytes = input.length ? bytesOf(input) : 0;
  const global = items.filter((item) => item.class === 'global_agents');
  return {
    ...base,
    parsed: true,
    transport: record.kind === 'ws-message' ? 'websocket' : 'http',
    wireType: typeof json.type === 'string' ? json.type : null,
    model: json.model ?? null,
    previousResponseId: json.previous_response_id ?? null,
    isDelta:
      typeof json.previous_response_id === 'string' &&
      json.previous_response_id.length > 0,
    instructionsBytes,
    toolsBytes,
    toolCount: toolSurface(json).length,
    // Supplemental count; these bytes remain in inputBytes, never added twice.
    inputToolSchemaBytes: items
      .filter((item) => item.type === 'additional_tools')
      .reduce((total, item) => total + item.bytes, 0),
    toolNames: toolSurface(json),
    inputBytes,
    inputItemCount: input.length,
    classBytes,
    items,
    globalAgents: {
      present: global.length > 0,
      items: global.length,
      bytes: global.reduce((sum, item) => sum + item.bytes, 0),
    },
    // Everything not instructions/tools/input: wire framing, model settings, reasoning/text controls.
    otherFieldBytes: Math.max(
      0,
      base.totalBytes - instructionsBytes - toolsBytes - inputBytes,
    ),
  };
}

/**
 * Attach an effective (resolved) request size. Full requests are their own
 * effective size. A delta resolves to the previous effective size plus its new
 * input, flagged `approximate` (the referenced response's output items are not
 * in the capture); an unresolved delta has `effectiveBytes: null`.
 *
 * @param {ReturnType<typeof summarizeResponsesRequest>[]} summaries in seq order
 * @param {Map<number, number|null>} previousSeqBySeq seq -> record.previousSeq
 */
export function withEffectiveBytes(summaries, previousSeqBySeq = new Map()) {
  const bySeq = new Map();
  return summaries.map((summary) => {
    let effectiveBytes;
    let effective;
    if (!summary.parsed) {
      effective = 'unparsed';
      effectiveBytes = null;
    } else if (!summary.isDelta) {
      effective = 'exact';
      effectiveBytes = summary.totalBytes;
    } else {
      const previous = bySeq.get(previousSeqBySeq.get(summary.seq) ?? -1);
      if (previous && previous.effectiveBytes !== null) {
        effective = 'approximate-delta-reconstruction';
        effectiveBytes = previous.effectiveBytes + summary.inputBytes;
      } else {
        effective = 'unresolved-delta';
        effectiveBytes = null;
      }
    }
    const out = { ...summary, effective, effectiveBytes };
    bySeq.set(summary.seq, out);
    return out;
  });
}

/** Bytes added by each request relative to the previous one (growth series). */
export function growthSeries(summaries) {
  return summaries.map((summary, index) => {
    const previous = index > 0 ? summaries[index - 1] : null;
    const bytes = summary.effectiveBytes;
    return {
      seq: summary.seq,
      step: index,
      effectiveBytes: bytes,
      addedBytes:
        previous && bytes !== null && previous.effectiveBytes !== null
          ? bytes - previous.effectiveBytes
          : null,
      toolOutputBytes: summary.classBytes?.tool_output ?? 0,
      effective: summary.effective,
    };
  });
}
