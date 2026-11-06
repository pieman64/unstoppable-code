import {
  CORE_TERMINAL_SETTINGS_RESOURCE,
  type CanopyInstructionHandlerMap,
  type CanopyQueryHandlerMap,
  type CoreTerminalPreset,
  type CoreTerminalProfileId,
  type CoreTerminalSettings,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { KeyedOutcomes } from './keyed-outcomes';

/** The two lists an update replaces. */
export interface TerminalSettingsValue {
  readonly disabledProfileIds: readonly CoreTerminalProfileId[];
  readonly presets: readonly CoreTerminalPreset[];
}

export type TerminalSettingsReplaceOutcome =
  | { readonly outcome: 'replaced'; readonly settings: CoreTerminalSettings }
  | { readonly outcome: 'conflict'; readonly settings: CoreTerminalSettings };

/** Where a host keeps its one terminal settings record. */
export interface TerminalSettingsStore {
  /** The committed settings. Throws `TerminalSettingsUnavailableError` when unreadable. */
  read(): Promise<CoreTerminalSettings>;
  /**
   * Replaces both lists when the committed revision equals
   * `expectedRevision`, atomically with every other writer of the record.
   * Throws `TerminalPresetIconMissingError` for an artifact it cannot
   * resolve, `TerminalSettingsUnavailableError` when the record cannot be
   * written, `TerminalSettingsOutcomeUnknownError` when the write's outcome
   * is unknown. Nothing is written when it throws before the save.
   */
  replace(
    expectedRevision: number,
    next: TerminalSettingsValue,
    signal?: AbortSignal,
  ): Promise<TerminalSettingsReplaceOutcome>;
}

export class TerminalSettingsUnavailableError extends Error {
  public readonly code = 'TERMINAL_SETTINGS_UNAVAILABLE';
  public constructor(
    message = 'Terminal settings cannot be read or written right now.',
  ) {
    super(message);
    this.name = 'TerminalSettingsUnavailableError';
  }
}

export class TerminalSettingsOutcomeUnknownError extends Error {
  public readonly code = 'TERMINAL_SETTINGS_OUTCOME_UNKNOWN';
  public constructor() {
    super('The terminal settings write may not have completed.');
    this.name = 'TerminalSettingsOutcomeUnknownError';
  }
}

export class TerminalPresetIconMissingError extends Error {
  public readonly code = 'TERMINAL_PRESET_ICON_MISSING';
  public constructor(public readonly presetId: string) {
    super('A preset icon refers to an image this host does not have.');
    this.name = 'TerminalPresetIconMissingError';
  }
}

export interface CoreTerminalSettingsHandlers {
  queries: Pick<
    CanopyQueryHandlerMap<CanopyHandlerContext>,
    'core.terminal.settings.get'
  >;
  instructions: Pick<
    CanopyInstructionHandlerMap<CanopyHandlerContext>,
    'core.terminal.settings.update'
  >;
}

function assertGlobalScope(scope: object | undefined): void {
  if (scope && Object.keys(scope).length > 0) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'This host keeps one terminal settings record.',
      retry: { kind: 'never' },
    });
  }
}

export function createCoreTerminalSettingsHandlers(
  store: TerminalSettingsStore,
): CoreTerminalSettingsHandlers {
  const outcomes = new KeyedOutcomes<CoreTerminalSettings>(
    () =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  );
  return {
    queries: {
      'core.terminal.settings.get': async (params) => {
        assertGlobalScope(params.scope);
        try {
          return await store.read();
        } catch (error) {
          if (error instanceof TerminalSettingsUnavailableError) {
            throw new CanopyOperationError({
              kind: 'unavailable',
              code: 'core.terminal.settingsUnavailable',
              message: 'Terminal settings cannot be read right now.',
              retry: { kind: 'never' },
            });
          }
          throw error;
        }
      },
    },
    instructions: {
      'core.terminal.settings.update': async (params, context) => {
        assertGlobalScope(params.scope);
        const { scope, expectedRevision, disabledProfileIds, presets } = params;
        return outcomes.run(
          context,
          { scope, expectedRevision, disabledProfileIds, presets },
          async () => {
            const ids = new Set<string>();
            for (const preset of presets) {
              if (ids.has(preset.presetId)) {
                throw new CanopyOperationError({
                  kind: 'invalid_argument',
                  code: 'core.terminal.presetDuplicate',
                  message: 'Each preset needs its own id.',
                  retry: { kind: 'never' },
                });
              }
              ids.add(preset.presetId);
            }
            const trimmed = presets.map((preset) => {
              const name = preset.name.trim();
              const command = preset.command.trim();
              if (!name || !command) {
                throw new CanopyOperationError({
                  kind: 'invalid_argument',
                  code: 'core.terminal.settingsInvalid',
                  message: !name
                    ? 'A preset needs a name.'
                    : 'A preset needs a command.',
                  retry: { kind: 'never' },
                });
              }
              if (
                preset.icon?.kind === 'image' &&
                preset.icon.lightArtifactId === null &&
                preset.icon.darkArtifactId === null
              ) {
                throw new CanopyOperationError({
                  kind: 'invalid_argument',
                  code: 'core.terminal.presetIconMissing',
                  message: 'An image icon needs a light or dark image.',
                  retry: { kind: 'never' },
                });
              }
              return { ...preset, name, command };
            });
            try {
              const outcome = await store.replace(
                expectedRevision,
                { disabledProfileIds, presets: trimmed },
                context.signal,
              );
              if (outcome.outcome === 'conflict') {
                throw new CanopyOperationError({
                  kind: 'conflict',
                  code: 'core.terminal.settingsConflict',
                  message: 'Terminal settings changed since they were read.',
                  retry: {
                    kind: 'after_refresh',
                    resource: CORE_TERMINAL_SETTINGS_RESOURCE,
                  },
                });
              }
              return outcome.settings;
            } catch (error) {
              if (context.signal.aborted && error === context.signal.reason) {
                throw new CanopyOperationError({
                  kind: 'unavailable',
                  message: 'The terminal settings update was interrupted.',
                  retry: { kind: 'same_idempotency_key' },
                });
              }
              if (error instanceof TerminalPresetIconMissingError) {
                throw new CanopyOperationError({
                  kind: 'invalid_argument',
                  code: 'core.terminal.presetIconMissing',
                  message:
                    'A preset icon refers to an image this host does not have.',
                  retry: { kind: 'never' },
                });
              }
              if (error instanceof TerminalSettingsUnavailableError) {
                throw new CanopyOperationError({
                  kind: 'unavailable',
                  message: 'Terminal settings cannot be saved right now.',
                  retry: { kind: 'never' },
                });
              }
              if (error instanceof TerminalSettingsOutcomeUnknownError) {
                throw new CanopyOperationError({
                  kind: 'unavailable',
                  message: 'The terminal settings save may not have completed.',
                  retry: { kind: 'same_idempotency_key' },
                });
              }
              throw error;
            }
          },
        );
      },
    },
  };
}
