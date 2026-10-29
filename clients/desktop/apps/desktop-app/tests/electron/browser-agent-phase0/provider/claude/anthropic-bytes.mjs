// Pure helpers over captured Anthropic Messages request bodies: byte
// breakdowns, between-tool diffs, phase classification and shape digests.
// No provider, network or filesystem access.
import { createHash } from 'node:crypto';

const enc = (value) => Buffer.byteLength(JSON.stringify(value) ?? 'null');

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** True for a `POST /v1/messages` capture record (count_tokens excluded). */
export function isMessagesRecord(record) {
  return record?.surface === 'anthropic-messages' && record?.method === 'POST';
}

/** Parsed JSON body of a capture record, or null. */
export function recordBody(record) {
  return record?.parse === 'ok' &&
    record.json &&
    typeof record.json === 'object'
    ? record.json
    : null;
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** Text of a tool_result `content` (string or block array). */
export function toolResultText(block) {
  return blocksOf(block?.content)
    .map((inner) => (typeof inner?.text === 'string' ? inner.text : ''))
    .join('');
}

function systemBlocks(body) {
  if (typeof body?.system === 'string')
    return [{ type: 'text', text: body.system }];
  return Array.isArray(body?.system) ? body.system : [];
}

/** Concatenated system text. */
export function systemText(body) {
  return systemBlocks(body)
    .map((block) => block?.text ?? '')
    .join('\n');
}

/**
 * Byte breakdown of one request. Sizes are the UTF-8 length of each part
 * re-serialized as JSON, so they sum to the wire size minus `framingBytes`.
 */
export function breakdownRequest(body, totalBytes) {
  const topLevel = {};
  for (const [key, value] of Object.entries(body ?? {}))
    topLevel[key] = enc(value);
  const system = systemBlocks(body);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const byRole = {};
  const messageBlocks = [];
  let toolResultBytes = 0;
  let toolResultCount = 0;
  let textBlockBytes = 0;
  let toolUseBytes = 0;
  messages.forEach((message, index) => {
    const role = message?.role ?? 'unknown';
    byRole[role] ??= { count: 0, bytes: 0 };
    byRole[role].count += 1;
    byRole[role].bytes += enc(message);
    for (const block of blocksOf(message?.content)) {
      const bytes = enc(block);
      const entry = {
        messageIndex: index,
        role,
        type: block?.type ?? 'unknown',
        bytes,
      };
      if (block?.type === 'tool_result') {
        toolResultBytes += bytes;
        toolResultCount += 1;
        entry.contentBytes = enc(block.content);
      } else if (block?.type === 'text') {
        textBlockBytes += bytes;
        entry.chars = (block.text ?? '').length;
        entry.systemReminder = /<system-reminder>/i.test(block.text ?? '');
      } else if (block?.type === 'tool_use') {
        toolUseBytes += bytes;
        entry.toolName = block.name;
      }
      messageBlocks.push(entry);
    }
  });
  const partSum = Object.values(topLevel).reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  return {
    totalBytes,
    model: typeof body?.model === 'string' ? body.model : null,
    stream: body?.stream === true,
    maxTokens: body?.max_tokens ?? null,
    topLevelBytes: topLevel,
    framingBytes: Math.max(0, totalBytes - partSum),
    system: {
      blockCount: system.length,
      bytes: enc(body?.system ?? null),
      chars: systemText(body).length,
      blocks: system.map((block) => ({
        type: block?.type ?? 'unknown',
        bytes: enc(block),
        chars: (block?.text ?? '').length,
      })),
    },
    tools: {
      count: tools.length,
      bytes: enc(tools),
      names: tools.map((tool) => tool?.name),
      perToolBytes: Object.fromEntries(
        tools.map((tool) => [tool?.name, enc(tool)]),
      ),
    },
    messages: {
      count: messages.length,
      bytes: enc(messages),
      byRole,
      toolResultCount,
      toolResultBytes,
      toolUseBytes,
      textBlockBytes,
      blocks: messageBlocks,
    },
  };
}

/** Growth series: bytes and deltas across consecutive requests of one loop. */
export function growthSeries(breakdowns) {
  return breakdowns.map((entry, index) => ({
    request: index + 1,
    totalBytes: entry.totalBytes,
    deltaBytes:
      index === 0 ? null : entry.totalBytes - breakdowns[index - 1].totalBytes,
    messageCount: entry.messages.count,
    toolResultBytes: entry.messages.toolResultBytes,
    systemBytes: entry.system.bytes,
    toolsBytes: entry.tools.bytes,
  }));
}

/** Names of the tools advertised in a request body. */
export function advertisedToolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : [])
    .map((tool) => tool?.name)
    .filter(Boolean);
}

/**
 * Phase per capture record, by arrival order (seq):
 *  - up to and including the first /v1/messages POST: before-inference
 *  - after it, up to the result message: after-tools
 *  - after the result message: completion
 * `resultSeq` is the largest seq already captured when the result message was
 * read (null when there was no result). With no /v1/messages POST at all,
 * every record is before-inference.
 */
export function classifyRecordsByPhase(records, { resultSeq = null } = {}) {
  const messageSeqs = records
    .filter(isMessagesRecord)
    .map((record) => record.seq);
  const firstMessages =
    messageSeqs.length > 0 ? Math.min(...messageSeqs) : Infinity;
  const out = new Map();
  for (const record of records) {
    let phase;
    if (record.seq <= firstMessages) phase = 'before-inference';
    else if (resultSeq !== null && record.seq > resultSeq) phase = 'completion';
    else phase = 'after-tools';
    out.set(record.seq, phase);
  }
  return out;
}

/** Records of one phase. */
export function recordsInPhase(records, phases, phase) {
  return records.filter((record) => phases.get(record.seq) === phase);
}

function stripCache(value) {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value))
      if (key !== 'cache_control') out[key] = stripCache(inner);
    return out;
  }
  return value;
}

function canariesIn(text, canaries) {
  return Object.entries(canaries ?? {})
    .filter(([, token]) => text.includes(token))
    .map(([id]) => id);
}

/**
 * Between-tool attachment pass: for consecutive requests of one loop, what
 * did the harness add besides the [assistant tool_use, user tool_result] pair?
 */
export function betweenToolDiff(prevBody, nextBody, canaries = {}) {
  const prev = Array.isArray(prevBody?.messages) ? prevBody.messages : [];
  const next = Array.isArray(nextBody?.messages) ? nextBody.messages : [];
  const prefixStable =
    JSON.stringify(stripCache(prev)) ===
    JSON.stringify(stripCache(next.slice(0, prev.length)));
  const added = next.slice(prev.length);
  const extras = [];
  const summary = added.map((message, offset) => {
    const role = message?.role ?? 'unknown';
    const blocks = blocksOf(message?.content);
    const described = blocks.map((block) => {
      const text =
        block?.type === 'tool_result'
          ? toolResultText(block)
          : (block?.text ?? '');
      const entry = {
        type: block?.type ?? 'unknown',
        bytes: enc(block),
        canaries: canariesIn(JSON.stringify(block), canaries),
      };
      if (block?.type === 'tool_use') entry.toolName = block.name;
      if (block?.type === 'tool_result') {
        entry.resultBlocks = blocksOf(block.content).length;
        entry.isError = block.is_error === true;
        entry.systemReminderInside = /<system-reminder>/i.test(text);
      }
      if (block?.type === 'text')
        entry.systemReminder = /<system-reminder>/i.test(text);
      return { ...entry, text };
    });
    const messageIndex = prev.length + offset;
    const isAssistantPair =
      role === 'assistant' &&
      described.every(
        (block) =>
          block.type === 'text' ||
          block.type === 'tool_use' ||
          block.type === 'thinking',
      );
    const isResultMessage =
      role === 'user' &&
      described.length > 0 &&
      described.every((block) => block.type === 'tool_result');
    const hasResult =
      role === 'user' &&
      described.some((block) => block.type === 'tool_result');
    if (!isAssistantPair && !isResultMessage) {
      // A user message that mixes tool_result with other blocks: only the other blocks are extras.
      for (const block of described) {
        if (hasResult && block.type === 'tool_result') continue;
        extras.push({
          messageIndex,
          role,
          blockType: block.type,
          bytes: block.bytes,
          canaries: block.canaries,
          preview: block.text.slice(0, 160),
        });
      }
    }
    if (hasResult) {
      for (const block of described) {
        if (
          block.type === 'tool_result' &&
          (block.resultBlocks > 1 || block.systemReminderInside)
        )
          extras.push({
            messageIndex,
            role,
            blockType: 'tool_result-embedded',
            bytes: block.bytes,
            canaries: block.canaries,
            preview: block.text.slice(-160),
          });
      }
    }
    return {
      messageIndex,
      role,
      blocks: described.map(({ text, ...rest }) => rest),
    };
  });
  const shapeOk =
    added.length === 2 &&
    added[0]?.role === 'assistant' &&
    added[1]?.role === 'user' &&
    extras.length === 0;
  return {
    shapeOk,
    prefixStable,
    addedMessageCount: added.length,
    systemChanged:
      JSON.stringify(stripCache(prevBody?.system ?? null)) !==
      JSON.stringify(stripCache(nextBody?.system ?? null)),
    toolsChanged:
      JSON.stringify(stripCache(prevBody?.tools ?? null)) !==
      JSON.stringify(stripCache(nextBody?.tools ?? null)),
    added: summary,
    extras,
    extraBytes: extras.reduce((sum, entry) => sum + entry.bytes, 0),
    extraCanaries: [...new Set(extras.flatMap((entry) => entry.canaries))],
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX64 = /\b[0-9a-f]{64}\b/gi;

/** Normalize volatile substrings (ids, cwd) so two launches can be compared. */
export function normalizeText(text, replacements = []) {
  let out = text;
  for (const { from, to } of replacements)
    if (from) out = out.split(from).join(to);
  return out.replace(UUID, '<uuid>').replace(HEX64, '<hex64>');
}

/** Digest of a request's model-visible content, after normalization. */
export function shapeDigest(body, replacements = []) {
  const norm = (value) =>
    normalizeText(JSON.stringify(stripCache(value ?? null)), replacements);
  const system = norm(body?.system);
  const tools = norm(body?.tools);
  const messages = norm(body?.messages);
  return {
    systemSha: sha256(system),
    toolsSha: sha256(tools),
    messagesSha: sha256(messages),
    systemBytes: Buffer.byteLength(system),
    toolsBytes: Buffer.byteLength(tools),
    messagesBytes: Buffer.byteLength(messages),
    model: body?.model ?? null,
  };
}

/** Compare two request series (same script) index by index after normalization. */
export function compareRequestSeries(seriesA, seriesB) {
  const count = Math.min(seriesA.length, seriesB.length);
  const perRequest = [];
  for (let index = 0; index < count; index += 1) {
    const a = shapeDigest(seriesA[index].body, seriesA[index].replacements);
    const b = shapeDigest(seriesB[index].body, seriesB[index].replacements);
    perRequest.push({
      request: index + 1,
      systemEqual: a.systemSha === b.systemSha,
      toolsEqual: a.toolsSha === b.toolsSha,
      messagesEqual: a.messagesSha === b.messagesSha,
      bytesA: {
        system: a.systemBytes,
        tools: a.toolsBytes,
        messages: a.messagesBytes,
      },
      bytesB: {
        system: b.systemBytes,
        tools: b.toolsBytes,
        messages: b.messagesBytes,
      },
      messageByteDelta: b.messagesBytes - a.messagesBytes,
      systemByteDelta: b.systemBytes - a.systemBytes,
    });
  }
  return {
    requestCountA: seriesA.length,
    requestCountB: seriesB.length,
    compared: count,
    identical:
      seriesA.length === seriesB.length &&
      perRequest.every(
        (entry) => entry.systemEqual && entry.toolsEqual && entry.messagesEqual,
      ),
    perRequest,
  };
}

/**
 * Model-visible text the harness added to the first request around the
 * probe's own prompt: extra system text and non-prompt user text blocks.
 */
export function harnessAddedText(body, { probeSystemPrompt, probePrompt }) {
  const system = systemText(body);
  const added = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'user') continue;
    for (const block of blocksOf(message.content)) {
      if (block?.type !== 'text') continue;
      const text = block.text ?? '';
      if (text === probePrompt) continue;
      added.push({
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
        systemReminder: /<system-reminder>/i.test(text),
        preview: text.slice(0, 160),
      });
    }
  }
  return {
    systemEqualsProbePrompt: system === probeSystemPrompt,
    systemExtraChars: system.length - probeSystemPrompt.length,
    systemBlockCount: systemBlocks(body).length,
    extraUserTextBlocks: added,
    extraUserTextBytes: added.reduce((sum, block) => sum + block.bytes, 0),
  };
}

/** Distinct `model` values across messages records. */
export function modelsSeen(records) {
  const models = new Map();
  for (const record of records.filter(isMessagesRecord)) {
    const model = recordBody(record)?.model ?? '(unparsed)';
    models.set(model, (models.get(model) ?? 0) + 1);
  }
  return Object.fromEntries(models);
}
