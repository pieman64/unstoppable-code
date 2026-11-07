import type { SessionEvent } from '@github/copilot-sdk';
import { isCopilotRecord } from './tool-input';

export function canonicalCopilotValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalCopilotValue).join(',')}]`;
  if (isCopilotRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalCopilotValue(value[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

interface ToolIdentity {
  id: string;
  server?: string;
  tool?: string;
}

export function copilotMcpCallIdentity(
  server: string,
  tool: string,
  args: unknown,
): string {
  return canonicalCopilotValue([server, tool, args]);
}

/** The SDK hook omits call ids; the preceding execution_start supplies provenance. */
export class CopilotToolCorrelation {
  private readonly pending = new Map<string, ToolIdentity[]>();
  private count = 0;
  private readonly seen = new Set<string>();

  observe(event: SessionEvent): void {
    if (event.type !== 'tool.execution_start' || event.agentId) return;
    if (this.seen.has(event.id)) return;
    if (this.seen.size >= 16_384)
      throw new Error('Too many Copilot tool events.');
    this.seen.add(event.id);
    if (++this.count > 1024) throw new Error('Too many pending Copilot tools.');
    const data = event.data;
    const key = `${data.toolName}:${canonicalCopilotValue(data.arguments ?? {})}`;
    const queue = this.pending.get(key) ?? [];
    queue.push({
      id: data.toolCallId,
      server: data.mcpConfigServerName ?? data.mcpServerName,
      tool: data.mcpToolName,
    });
    this.pending.set(key, queue);
  }

  take(name: string, args: unknown): ToolIdentity | undefined {
    const key = `${name}:${canonicalCopilotValue(args ?? {})}`;
    const queue = this.pending.get(key);
    const found = queue?.shift();
    if (found) this.count--;
    if (!queue?.length) this.pending.delete(key);
    return found;
  }
}
