import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { findMemoryCitationFilesAttributes } from '@canopy/agent-transcript';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { readPreferencesFile } from '../../lib/preferences-store';

const CITATION_COMPLIANCE_OPERATION_NAME =
  'canopy.local_memory_citation_compliance';

interface ParsedCitationText {
  fileKeys: string[];
  hasCitation: boolean;
}

export interface CompletedTurnMemorySignals {
  citationFileKeys: string[];
  hasCitation: boolean;
  memoryInjected: boolean;
}

export interface LocalMemoryCitationComplianceCounter {
  auditEntryId: string;
  provider: AgentProviderType;
  memoryInjected: boolean;
  hasCitation: boolean;
}

export interface TrackCompletedTurnLocalMemoryCitationsOptions {
  auditEntryId: string;
  provider: AgentProviderType;
  transcriptLines: string[];
}

export interface LocalMemoryCitationTrackingDependencies {
  isLocalMemoryEnabled: () => Promise<boolean>;
  emitComplianceCounter: (
    counter: LocalMemoryCitationComplianceCounter,
  ) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scope-relative keys accepted from a model-emitted citation tag. */
export function isValidMemoryCitationFileKey(fileKey: string): boolean {
  const hasControlCharacter = Array.from(fileKey).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    fileKey.length === 0 ||
    fileKey.includes('..') ||
    fileKey.includes('\\') ||
    fileKey.startsWith('/') ||
    hasControlCharacter
  ) {
    return false;
  }

  if (fileKey === 'MEMORY.md') {
    return true;
  }

  const segments = fileKey.split('/');
  if (segments.length !== 2) {
    return false;
  }
  const [directory, filename] = segments;
  return (
    (directory === 'topics' || directory === 'inbox') &&
    typeof filename === 'string' &&
    filename.length > '.md'.length &&
    filename.endsWith('.md')
  );
}

/**
 * Compliance parse of one text item. The tag matching itself lives in
 * `@canopy/agent-transcript` (`findMemoryCitationFilesAttributes`), which is
 * the single source of truth for citation tag syntax: display stripping
 * removes a superset (any bounded `<memory_citation ...>` tag) while this
 * parser deliberately counts only the strict self-closing `files="..."` form,
 * because compliance measures correct-format emission.
 */
function parseCitationText(text: string): ParsedCitationText {
  const fileKeys = new Set<string>();
  const filesAttributes = findMemoryCitationFilesAttributes(text);
  for (const filesAttribute of filesAttributes) {
    for (const candidate of filesAttribute.split(',')) {
      const fileKey = candidate.trim();
      if (isValidMemoryCitationFileKey(fileKey)) {
        fileKeys.add(fileKey);
      }
    }
  }

  return {
    fileKeys: Array.from(fileKeys),
    hasCitation: filesAttributes.length > 0,
  };
}

/**
 * Parse and de-duplicate valid file keys from every complete citation tag.
 *
 * Under the CAN-1975 compliance gate this (and the `citationFileKeys` signal
 * it feeds) is deliberately unconsumed scaffolding: compliance only records
 * the boolean injected/cited pair. Do NOT wire the parsed file keys into
 * `recordUsage` (or any retention/pruning input) until provider citation
 * compliance has been measured and judged reliable.
 */
export function parseMemoryCitationFileKeys(text: string): string[] {
  return parseCitationText(text).fileKeys;
}

function assistantTextFromTranscriptRecord(
  record: Record<string, unknown>,
): string[] {
  if (record.type === 'assistant') {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.flatMap((block): string[] => {
      if (!isRecord(block) || block.type !== 'text') {
        return [];
      }
      return typeof block.text === 'string' ? [block.text] : [];
    });
  }

  if (record.type === 'codex' && isRecord(record.event)) {
    return assistantTextFromTranscriptRecord(record.event);
  }

  if (record.type === 'result' && typeof record.result === 'string') {
    return [record.result];
  }

  if (
    (record.type === 'item.started' ||
      record.type === 'item.updated' ||
      record.type === 'item.completed') &&
    isRecord(record.item) &&
    (record.item.type === 'agent_message' || record.item.type === 'plan') &&
    typeof record.item.text === 'string'
  ) {
    return [record.item.text];
  }

  // `claude_terminal_projected_messages` records are deliberately not read:
  // they are written only by the pipeline step runner (whose audit entries
  // never reach this tracker) and their text already had citation tags
  // stripped at projection time. Terminal chat turns feed raw Claude JSONL
  // events into the transcript, which the `assistant` branch above covers.

  return [];
}

/**
 * Read the raw observability JSONL for one completed turn. This deliberately
 * runs before display parsing strips citation tags.
 */
export function parseCompletedTurnMemorySignals(
  transcriptLines: string[],
): CompletedTurnMemorySignals {
  const citationFileKeys = new Set<string>();
  let hasCitation = false;
  let memoryInjected = false;

  for (const line of transcriptLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    if (
      parsed.type === 'canopy_user_prompt' &&
      typeof parsed.submitted_text === 'string' &&
      parsed.submitted_text.includes('<local_memory>')
    ) {
      memoryInjected = true;
    }

    for (const text of assistantTextFromTranscriptRecord(parsed)) {
      const citation = parseCitationText(text);
      hasCitation = hasCitation || citation.hasCitation;
      for (const fileKey of citation.fileKeys) {
        citationFileKeys.add(fileKey);
      }
    }
  }

  return {
    citationFileKeys: Array.from(citationFileKeys),
    hasCitation,
    memoryInjected,
  };
}

/**
 * Cheap preference gate shared with the observability scheduler: local memory
 * defaults off, so callers check this before paying for a transcript read.
 * `trackCompletedTurnLocalMemoryCitations` re-checks it via its dependencies.
 */
export async function isLocalMemoryCitationTrackingEnabled(): Promise<boolean> {
  const preferences = await readPreferencesFile();
  return preferences.localMemoryEnabled;
}

/** One successful operation per eligible turn acts as a provider-grouped counter. */
export function emitLocalMemoryCitationComplianceCounter(
  counter: LocalMemoryCitationComplianceCounter,
): void {
  try {
    const operationKey = createDesktopInstrumentationOperationKey(
      `local-memory-citation:${counter.auditEntryId}`,
    );
    const context = {
      provider: counter.provider,
      memory_injected: counter.memoryInjected,
      citation_present: counter.hasCitation,
    };
    startDesktopOperation(CITATION_COMPLIANCE_OPERATION_NAME, {
      operationKey,
      context,
    });
    succeedDesktopOperation(CITATION_COMPLIANCE_OPERATION_NAME, {
      operationKey,
      context,
    });
  } catch {
    // Citation compliance telemetry is best-effort.
  }
}

const DEFAULT_DEPENDENCIES: LocalMemoryCitationTrackingDependencies = {
  isLocalMemoryEnabled: isLocalMemoryCitationTrackingEnabled,
  emitComplianceCounter: emitLocalMemoryCitationComplianceCounter,
};

/**
 * Process the observability transcript associated with a completed chat turn.
 * Every failure is contained so citation measurement cannot affect the turn.
 */
export async function trackCompletedTurnLocalMemoryCitations(
  options: TrackCompletedTurnLocalMemoryCitationsOptions,
  dependencies: LocalMemoryCitationTrackingDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  try {
    if (!(await dependencies.isLocalMemoryEnabled())) {
      return;
    }

    const signals = parseCompletedTurnMemorySignals(options.transcriptLines);
    try {
      dependencies.emitComplianceCounter({
        auditEntryId: options.auditEntryId,
        provider: options.provider,
        memoryInjected: signals.memoryInjected,
        hasCitation: signals.hasCitation,
      });
    } catch {
      // Metrics must not block citation processing.
    }
  } catch {
    // Citation processing is observability-only and never affects the turn.
  }
}
