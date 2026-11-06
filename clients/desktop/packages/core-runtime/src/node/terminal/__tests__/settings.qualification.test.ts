import {
  CORE_TERMINAL_SETTINGS_QUERIES,
  CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
  CoreTerminalSettingsSchema,
  type CoreTerminalPreset,
  type CoreTerminalSettings,
  type CoreTerminalSettingsUpdateParams,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  createCoreTerminalSettingsHandlers,
  TerminalSettingsUnavailableError,
  TerminalSettingsOutcomeUnknownError,
  type TerminalSettingsStore,
  type TerminalSettingsValue,
  type TerminalSettingsReplaceOutcome,
} from '../settings';

const preset: CoreTerminalPreset = {
  presetId: 'a',
  name: 'Build',
  profileId: 'default',
  command: 'make',
  enabled: true,
  icon: null,
};
const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'client',
  authorityId: 'desktop',
  interfaceKind: 'test',
  grants: [],
};
const readCaller: { caller: CanopyCallerDescriptor } = {
  caller: { ...caller, grants: ['core.config.read'] },
};
function writeCaller(key = 'attempt'): {
  caller: CanopyCallerDescriptor;
  metadata: { idempotencyKey: string };
} {
  return {
    caller: { ...caller, grants: ['core.config.write'] },
    metadata: { idempotencyKey: key },
  };
}

class MemoryTerminalSettingsStore implements TerminalSettingsStore {
  settings: CoreTerminalSettings = {
    revision: 0,
    disabledProfileIds: [],
    presets: [],
  };
  calls = 0;
  readError?: Error;
  replaceError?: Error;

  read(): Promise<CoreTerminalSettings> {
    if (this.readError) return Promise.reject(this.readError);
    return Promise.resolve(this.settings);
  }

  replace(
    expectedRevision: number,
    next: TerminalSettingsValue,
  ): Promise<TerminalSettingsReplaceOutcome> {
    this.calls += 1;
    if (this.replaceError) return Promise.reject(this.replaceError);
    if (this.settings.revision !== expectedRevision)
      return Promise.resolve({ outcome: 'conflict', settings: this.settings });
    const changed =
      JSON.stringify([
        this.settings.disabledProfileIds,
        this.settings.presets,
      ]) !== JSON.stringify([next.disabledProfileIds, next.presets]);
    this.settings = {
      revision: this.settings.revision + Number(changed),
      disabledProfileIds: [...next.disabledProfileIds],
      presets: [...next.presets],
    };
    return Promise.resolve({ outcome: 'replaced', settings: this.settings });
  }
}

function fixture(): {
  store: MemoryTerminalSettingsStore;
  dispatcher: CanopyDispatcher<
    typeof CORE_TERMINAL_SETTINGS_QUERIES,
    typeof CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
    Record<never, never>
  >;
} {
  const store = new MemoryTerminalSettingsStore();
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_TERMINAL_SETTINGS_QUERIES,
      instructions: CORE_TERMINAL_SETTINGS_INSTRUCTIONS,
      streams: {},
    },
    handlers: { ...createCoreTerminalSettingsHandlers(store), streams: {} },
  });
  return { store, dispatcher };
}
function update(key = 'attempt'): CoreTerminalSettingsUpdateParams {
  return {
    scope: {},
    expectedRevision: 0,
    disabledProfileIds: ['bash'],
    presets: [preset],
    _meta: { idempotencyKey: key },
  };
}

describe('core.terminal.settings handlers (CAN-4148)', () => {
  it('reads the settings and their revision', async () => {
    const { store, dispatcher } = fixture();
    try {
      const result = await dispatcher.query(
        'core.terminal.settings.get',
        {},
        readCaller,
      );
      expect(result).toEqual(store.settings);
      expect(CoreTerminalSettingsSchema.parse(result)).toEqual(result);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('replaces settings at the expected revision and refuses a stale revision', async () => {
    const { store, dispatcher } = fixture();
    try {
      await expect(
        dispatcher.instruction(
          'core.terminal.settings.update',
          update(),
          writeCaller(),
        ),
      ).resolves.toEqual({
        revision: 1,
        disabledProfileIds: ['bash'],
        presets: [preset],
      });
      await expect(
        dispatcher.instruction(
          'core.terminal.settings.update',
          { ...update('stale'), presets: [] },
          writeCaller('stale'),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'conflict',
          code: 'core.terminal.settingsConflict',
          retry: { kind: 'after_refresh', resource: 'core.terminal.settings' },
        },
      });
      expect(store.settings.presets).toEqual([preset]);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses duplicate preset ids, blank names and image icons without an image before the store', async () => {
    const { store, dispatcher } = fixture();
    try {
      const cases: [CoreTerminalPreset[], string][] = [
        [[preset, preset], 'core.terminal.presetDuplicate'],
        [[{ ...preset, name: '  ' }], 'core.terminal.settingsInvalid'],
        [
          [
            {
              ...preset,
              icon: {
                kind: 'image',
                lightArtifactId: null,
                darkArtifactId: null,
              },
            },
          ],
          'core.terminal.presetIconMissing',
        ],
      ];
      for (const [presets, code] of cases) {
        await expect(
          dispatcher.instruction(
            'core.terminal.settings.update',
            { ...update(code), presets },
            writeCaller(code),
          ),
        ).rejects.toMatchObject({ payload: { code } });
      }
      expect(store.calls).toBe(0);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('answers a scoped request as capability_unavailable', async () => {
    const { store, dispatcher } = fixture();
    try {
      const scope = { workspaceId: 'w' };
      await expect(
        dispatcher.query('core.terminal.settings.get', { scope }, readCaller),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      await expect(
        dispatcher.instruction(
          'core.terminal.settings.update',
          { ...update(), scope },
          writeCaller(),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(store.calls).toBe(0);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('returns the kept outcome for a repeated key and refuses the key with other params', async () => {
    const { store, dispatcher } = fixture();
    try {
      const first = await dispatcher.instruction(
        'core.terminal.settings.update',
        update(),
        writeCaller(),
      );
      await expect(
        dispatcher.instruction(
          'core.terminal.settings.update',
          update(),
          writeCaller(),
        ),
      ).resolves.toEqual(first);
      expect(store.calls).toBe(1);
      const failure = dispatcher.instruction(
        'core.terminal.settings.update',
        { ...update(), presets: [] },
        writeCaller(),
      );
      await expect(failure).rejects.toMatchObject({
        payload: { kind: 'conflict' },
      });
      await expect(failure).rejects.not.toHaveProperty('payload.code');
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('reports unreadable settings and an unknown write outcome', async () => {
    const { store, dispatcher } = fixture();
    try {
      store.readError = new TerminalSettingsUnavailableError();
      await expect(
        dispatcher.query('core.terminal.settings.get', {}, readCaller),
      ).rejects.toMatchObject({
        payload: { code: 'core.terminal.settingsUnavailable' },
      });
      store.replaceError = new TerminalSettingsOutcomeUnknownError();
      await expect(
        dispatcher.instruction(
          'core.terminal.settings.update',
          update(),
          writeCaller(),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses a get or update without its grant', async () => {
    const { dispatcher } = fixture();
    try {
      await expect(
        dispatcher.query(
          'core.terminal.settings.get',
          {},
          { caller: { ...caller, grants: ['core.config.write'] } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.instruction('core.terminal.settings.update', update(), {
          ...readCaller,
          metadata: { idempotencyKey: 'attempt' },
        }),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    } finally {
      await dispatcher.shutdown();
    }
  });
});
