import { createHash } from 'node:crypto';
import type { SessionEvent } from '@github/copilot-sdk';
import { isCopilotRecord } from './tool-input';
import { copilotMcpCallIdentity } from './tool-correlation';

const MAX_PENDING = 1024;
const MAX_SEEN = 16_384;
const MAX_RESULT_BYTES = 1024 * 1024;

function resultDigest(text: string): string | undefined {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES)
    return undefined;
  return createHash('sha256').update(text).digest('hex');
}

/** Only one native approval may await HTTP dispatch for an argument identity. */
export class CopilotMcpApprovals {
  private readonly pending = new Map<string, string>();
  private readonly seen = new Set<string>();

  approve(id: string, server: string, tool: string, args: unknown): boolean {
    if (!id || this.seen.has(id) || this.seen.size >= MAX_SEEN) return false;
    this.seen.add(id);
    const key = copilotMcpCallIdentity(server, tool, args);
    // Native hooks do not carry an HTTP request id. Reject ambiguity before
    // allowing either HTTP arrival order to consume another call's approval.
    if (this.pending.has(key) || this.pending.size >= MAX_PENDING) return false;
    this.pending.set(key, id);
    return true;
  }

  take(server: string, tool: string, args: unknown): string | undefined {
    const key = copilotMcpCallIdentity(server, tool, args);
    const id = this.pending.get(key);
    this.pending.delete(key);
    return id;
  }
}

interface ExpectedReceipt {
  toolUseId: string;
  digest: string;
}

/**
 * A successful HTTP write is not a native receipt. Only the pinned runtime's
 * exact root tool completion can acknowledge a host result for a reload.
 * Instances are private to one turn/account generation and close on teardown.
 */
export class CopilotToolReceipts {
  private readonly expected = new Map<string, ExpectedReceipt>();
  private readonly seen = new Set<string>();
  private closed = false;

  expect(nativeCallId: string, toolUseId: string, text: string): boolean {
    if (this.seen.size >= MAX_SEEN) this.close();
    const digest = resultDigest(text);
    if (
      this.closed ||
      !nativeCallId ||
      !toolUseId ||
      !digest ||
      this.seen.has(nativeCallId)
    )
      return false;
    if (this.expected.has(nativeCallId)) {
      // Ambiguous attribution must not acknowledge either response.
      this.expected.delete(nativeCallId);
      this.seen.add(nativeCallId);
      return false;
    }
    if (this.expected.size >= MAX_PENDING) return false;
    this.expected.set(nativeCallId, { toolUseId, digest });
    return true;
  }

  observe(event: SessionEvent): string | undefined {
    if (
      this.closed ||
      event.type !== 'tool.execution_complete' ||
      event.agentId ||
      event.data.parentToolCallId
    )
      return undefined;
    const { toolCallId, success, result } = event.data;
    if (this.seen.has(toolCallId)) return undefined;
    if (this.seen.size >= MAX_SEEN) {
      this.close();
      return undefined;
    }
    this.seen.add(toolCallId);
    const expected = this.expected.get(toolCallId);
    this.expected.delete(toolCallId);
    if (
      !expected ||
      !success ||
      !result ||
      resultDigest(result.content) !== expected.digest
    )
      return undefined;
    if (
      result.detailedContent !== undefined &&
      resultDigest(result.detailedContent) !== expected.digest
    )
      return undefined;
    const contents = result.contents;
    if (
      contents?.length !== 1 ||
      contents[0]?.type !== 'text' ||
      resultDigest(contents[0].text) !== expected.digest
    )
      return undefined;
    return expected.toolUseId;
  }

  close(): void {
    this.closed = true;
    this.expected.clear();
    this.seen.clear();
  }
}

/** Reload responses are one bounded text block. Images/errors cannot prove delivery. */
export function copilotReceiptText(result: unknown): string | undefined {
  if (
    !isCopilotRecord(result) ||
    result.isError === true ||
    !Array.isArray(result.content) ||
    result.content.length !== 1
  )
    return undefined;
  const content: unknown = result.content[0];
  return isCopilotRecord(content) &&
    content.type === 'text' &&
    typeof content.text === 'string'
    ? content.text
    : undefined;
}
