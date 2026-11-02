import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import type { TranscriptStreamDescriptor } from '@canopy/protocol/canopy-core';
import type { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';

// shortcut: child documents index at most 16 MiB; later text is intentionally
// deferred, independently of the aggregate query-worker routing threshold.
export const CHILD_SEARCH_TEXT_BYTES = 16 * 1024 * 1024;
export const CHILD_SEARCH_EXTRACTOR_VERSION = 1;
export type ChildSearchCard = Extract<
  PersistedChatBlock,
  { type: 'delegated_agent_call' }
>;

export interface ChildSearchDocumentIdentity {
  target: TranscriptStreamDescriptor['target'];
  descriptor: TranscriptStreamDescriptor;
  fingerprint: string;
}

/** A UTF-8 budget includes every role prefix and separator. */
export class ChildSearchText {
  private readonly parts: string[] = [];
  private bytes = 0;
  public get remaining(): number {
    return CHILD_SEARCH_TEXT_BYTES - this.bytes;
  }
  public append(value: string): void {
    if (this.remaining === 0) return;
    const bytes = Buffer.from(value, 'utf8');
    let end = Math.min(bytes.length, this.remaining);
    while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80)
      end -= 1;
    if (end === 0) return;
    this.parts.push(bytes.subarray(0, end).toString('utf8'));
    this.bytes += end;
  }
  public text(): string {
    return this.parts.join('');
  }
}

async function appendField(
  output: ChildSearchText,
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  inline: string,
  reference: PersistedToolOutputReference | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (output.remaining === 0) return;
  if (!reference) {
    output.append(inline);
    return;
  }
  let offset = 0;
  while (output.remaining > 0) {
    signal?.throwIfAborted();
    const range = await artifacts.readRange(
      chatId,
      reference,
      offset,
      Math.max(4, Math.min(65_536, output.remaining)),
      signal,
    );
    output.append(range.text);
    if (range.nextOffset === undefined) return;
    offset = range.nextOffset;
    // Fewer than four bytes may remain but the next encoded character may
    // need four. Do not spin or resolve the rest of a capped field.
    if (output.remaining < 4) return;
  }
}

export async function appendChildSearchCard(
  output: ChildSearchText,
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  card: ChildSearchCard | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!card) return;
  output.append(card.description);
  if (card.finalText !== undefined || card.finalTextRef !== undefined) {
    output.append('\n');
    await appendField(
      output,
      artifacts,
      chatId,
      card.finalText ?? '',
      card.finalTextRef,
      signal,
    );
  }
}

export async function appendChildSearchRow(
  output: ChildSearchText,
  artifacts: ChatTranscriptArtifacts,
  chatId: string,
  row: PersistedChatMessage,
  signal?: AbortSignal,
): Promise<void> {
  if (row.hidden || (row.role !== 'user' && row.role !== 'assistant')) return;
  let started = false;
  for await (const block of artifacts.iterateBlocks(chatId, row, signal)) {
    signal?.throwIfAborted();
    if (output.remaining === 0) return;
    if (block.type !== 'text' && block.type !== 'tool_result') continue;
    const text = block.type === 'text' ? block.text : block.output;
    const reference =
      block.type === 'text' ? block.textRef : block.fullOutputRef;
    if (!text && !reference) continue;
    output.append(
      started ? '\n' : `\n\n${row.role === 'user' ? 'User' : 'Assistant'}: `,
    );
    started = true;
    await appendField(output, artifacts, chatId, text, reference, signal);
  }
}
