function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseStructuredJsonResult(rawText: string): unknown {
  const candidate =
    rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/)?.[1]?.trim() ??
    rawText.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed;
  } catch {
    return undefined;
  }
}

export function extractStructuredToolInput(event: unknown): unknown {
  if (!isRecord(event) || event.type !== 'assistant') {
    return undefined;
  }

  const message = event.message;
  if (!isRecord(message)) {
    return undefined;
  }

  const content = message.content;
  if (!isUnknownArray(content)) {
    return undefined;
  }

  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block)) {
      continue;
    }

    if (
      block.type === 'tool_use' &&
      block.name === 'StructuredOutput' &&
      'input' in block
    ) {
      return block.input;
    }
  }

  return undefined;
}
