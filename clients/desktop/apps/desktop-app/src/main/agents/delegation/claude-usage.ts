import type { AgentDelegationUsage } from '@canopy/protocol/delegation';

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Per-response snapshots, including usage received before a failed SDK result. */
export class ClaudeDelegationUsage {
  private readonly messages = new Map<string, AgentDelegationUsage>();
  private streamingId?: string;

  receive(value: unknown): AgentDelegationUsage | undefined {
    const outer = record(value);
    const event = outer?.type === 'stream_event' ? record(outer.event) : outer;
    const message = record(event?.message);
    if (event?.type === 'message_start' && typeof message?.id === 'string')
      this.streamingId = message.id;
    const id =
      event?.type === 'message_delta'
        ? this.streamingId
        : typeof message?.id === 'string'
          ? message.id
          : undefined;
    const source = record(
      event?.type === 'message_delta' ? event.usage : message?.usage,
    );
    if (
      !id ||
      id.length > 256 ||
      !source ||
      (!this.messages.has(id) && this.messages.size >= 64)
    )
      return undefined;
    const usage = { ...this.messages.get(id) };
    for (const [wire, key] of [
      ['input_tokens', 'inputTokens'],
      ['output_tokens', 'outputTokens'],
      ['cache_read_input_tokens', 'cachedInputTokens'],
      ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ] as const) {
      const number = source[wire];
      if (typeof number === 'number' && Number.isFinite(number) && number >= 0)
        usage[key] = number;
    }
    this.messages.set(id, usage);
    const total: {
      -readonly [K in keyof AgentDelegationUsage]: AgentDelegationUsage[K];
    } = {};
    for (const usage of Array.from(this.messages.values())) {
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
      ] as const)
        if (usage[key] !== undefined)
          total[key] = (total[key] ?? 0) + usage[key];
    }
    return total;
  }
}
