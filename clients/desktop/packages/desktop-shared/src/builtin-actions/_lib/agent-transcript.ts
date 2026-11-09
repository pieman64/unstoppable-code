import { redactStructuredValue } from '@canopy/execution-engine/lib/redaction';
import type { AgentProviderType } from '@canopy/desktop-shared/types';

export interface TranscriptCapture {
  emitRecord(record: unknown): void;
  serialize(): string;
}

/**
 * `secretValues` is redacted into each record BEFORE `JSON.stringify`, not
 * after: a multi-line configured secret (e.g. a PEM key) an agent echoes
 * verbatim into a record's text survives JSON serialization only as an
 * escaped `\n` two-character sequence, which can never exact-match the
 * still-multi-line raw secret value a later string-based redaction pass
 * (`redactValues` over the already-serialized text) searches for — the
 * escaped-but-still-complete secret would otherwise reach both the live
 * stdout stream (redacted only at the parent process's byte-stream level,
 * which has the exact same escaping blind spot) and the durable transcript
 * file. `redactStructuredValue` walks the record's actual string/number
 * leaves and object keys directly (no JSON round-trip), so it matches the
 * secret's real, unescaped characters before escaping ever happens, and
 * cannot corrupt the record's structure the way a second substring pass over
 * already-serialized JSON text can (see `redactStructuredValue`'s own
 * docstring). This only affects the LOGGED/PERSISTED copy of a record — it
 * is a redaction of a value already captured for the transcript, never of
 * the live `prompt` string a caller separately passes to the provider SDK,
 * so the model still receives its own real, unredacted context.
 */
export function createTranscriptCapture(
  secretValues: readonly string[] = [],
): TranscriptCapture {
  const lines: string[] = [];

  return {
    emitRecord(record: unknown): void {
      const redactedRecord =
        secretValues.length === 0
          ? record
          : redactStructuredValue(record, secretValues);
      const line = JSON.stringify(redactedRecord);
      process.stdout.write(`${line}\n`);
      lines.push(line);
    },
    serialize(): string {
      return lines.length > 0 ? `${lines.join('\n')}\n` : '';
    },
  };
}

export function buildPipelinePromptRecord(options: {
  provider: AgentProviderType;
  originalText: string;
  submittedText?: string;
}): Record<string, unknown> {
  return {
    type: 'canopy_user_prompt',
    provider: options.provider,
    original_text: options.originalText,
    submitted_text: options.submittedText ?? options.originalText,
    plan_mode: false,
  };
}

export function buildPipelineSystemPromptRecord(
  provider: AgentProviderType,
  systemPrompt: string | undefined,
): Record<string, unknown> | null {
  const trimmedSystemPrompt = systemPrompt?.trim() ?? '';
  if (trimmedSystemPrompt.length === 0) {
    return null;
  }

  return {
    type: 'canopy_injected_prompt',
    kind: 'system_prompt_append',
    provider,
    application_condition: 'pipeline_step_system_prompt',
    text: trimmedSystemPrompt,
  };
}
