import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { AGENT_DEFAULT_BASE_MODEL } from '@canopy/protocol/agents';
import type {
  SharedAgentDetail,
  SharedAgentDocument,
} from '@canopy/desktop-shared/types/agent-models';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';

let mockAgentModelsFilePath = '';
let mockResourceContextEnabled = false;
jest.mock('../agents/resource-lanes', () => ({
  agentResourceContextEnabled: (): boolean => mockResourceContextEnabled,
}));
const mockAssertStoredAgentContext = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRecordSharedAgentInstall = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
const mockSharedAgentIsAuthoredByCurrentAccount = jest.fn<
  Promise<boolean>,
  unknown[]
>(() => Promise.resolve(false));
jest.mock('../agents/agent-install-context', () => ({
  assertStoredAgentContext: (id: string): Promise<void> =>
    mockAssertStoredAgentContext(id),
  recordSharedAgentInstall: (...args: unknown[]): Promise<void> =>
    mockRecordSharedAgentInstall(...args),
  sharedAgentIsAuthoredByCurrentAccount: (
    ...args: unknown[]
  ): Promise<boolean> => mockSharedAgentIsAuthoredByCurrentAccount(...args),
  filterStoredAgentContexts: async <T extends { id: string }>(
    rows: T[],
  ): Promise<T[]> => {
    const allowed = await Promise.all(
      rows.map(async (row) => {
        try {
          await mockAssertStoredAgentContext(row.id);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return rows.filter((_row, index) => allowed[index]);
  },
}));

jest.mock('../lib/paths', () => ({
  getAgentModelsFilePath: (): string => mockAgentModelsFilePath,
}));

import {
  clearAgentRemoteMetadataByRemoteId,
  writeAgentRemoteMetadata,
  deleteAgentModel,
  importSharedAgent,
  importPublicAgent,
  findInstalledPublicAgent,
  listAgentModels,
  listAgentModelsForInstallBackfill,
  getAgentModel,
  saveAgentModel,
  uninstallPublicAgent,
} from '../agents/agent-model-store';

const BASE_MODEL = 'claude-agent-store-test';
const PUBLIC_SHARE_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC_CONTENT_HASH = 'public-content-hash';

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

describe('agent-model-store', () => {
  let tempDir: string;

  beforeAll(() => {
    initClaudeModels([{ id: BASE_MODEL, label: 'Claude Agent Store Test' }]);
  });

  beforeEach(async () => {
    mockResourceContextEnabled = false;
    mockAssertStoredAgentContext.mockReset().mockResolvedValue(undefined);
    mockRecordSharedAgentInstall.mockReset().mockResolvedValue(undefined);
    mockSharedAgentIsAuthoredByCurrentAccount
      .mockReset()
      .mockResolvedValue(false);
    jest.mocked(recordSharedItemInstall).mockReset();
    jest.mocked(recordSharedItemUninstall).mockReset();
    tempDir = await mkdtemp(join(tmpdir(), 'canopy-agent-model-store-'));
    mockAgentModelsFilePath = join(tempDir, 'agent-models.json');
  });

  it.each(['inventory', 'direct id', 'edit', 'delete'])(
    'rechecks installed agent %s',
    async (operation) => {
      const agent = await saveAgentModel({
        name: 'Org agent',
        baseModel: BASE_MODEL,
        instructions: 'private',
        pluginSelections: emptySelections(),
      });
      mockAssertStoredAgentContext.mockRejectedValue(
        new Error('Agent unavailable (context-mismatch)'),
      );
      if (operation === 'inventory')
        await expect(listAgentModels()).resolves.toEqual([]);
      if (operation === 'direct id')
        await expect(getAgentModel(agent.id)).rejects.toThrow(
          'context-mismatch',
        );
      if (operation === 'edit')
        await expect(
          saveAgentModel({ ...agent, name: 'Renamed' }),
        ).rejects.toThrow('context-mismatch');
      if (operation === 'delete')
        await expect(deleteAgentModel(agent.id)).rejects.toThrow(
          'context-mismatch',
        );
      mockAssertStoredAgentContext.mockResolvedValue(undefined);
      await expect(getAgentModel(agent.id)).resolves.toMatchObject({
        name: 'Org agent',
      });
    },
  );

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each(['cursor-default', 'cursor:review-model%5B%5D'])(
    'saves and reloads a Cursor Agent: %s',
    async (baseModel) => {
      const saved = await saveAgentModel({
        name: 'Cursor reviewer',
        baseModel,
        instructions: 'Review carefully.',
        pluginSelections: emptySelections(),
      });
      await expect(getAgentModel(saved.id)).resolves.toMatchObject({
        baseModel,
        instructions: 'Review carefully.',
      });
    },
  );

  const importedDocument: SharedAgentDocument = {
    version: 1,
    id: 'agent_model_imported',
    name: 'Imported Agent',
    baseModel: BASE_MODEL,
    instructions: 'Imported instructions.',
    plugins: [],
  };
  const importedDetail: SharedAgentDetail = {
    id: PUBLIC_SHARE_ID,
    name: importedDocument.name,
    modelId: importedDocument.id,
    baseModel: BASE_MODEL,
    instructionsPreview: '',
    contentHash: PUBLIC_CONTENT_HASH,
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '',
    updatedAt: '',
    canUpdate: true,
    canDelete: true,
    agent: importedDocument,
  };

  it('keeps an imported Agent source separate from its author-side share link', async () => {
    const imported = await importSharedAgent(importedDetail, emptySelections());

    expect(imported.agent).toMatchObject({
      importedFromRemoteId: importedDetail.id,
      remoteContentHash: importedDetail.contentHash,
    });
    expect(imported.agent.remoteId).toBeUndefined();
  });

  it('drops an author-side link from a persisted import carrying both provenance fields', async () => {
    mockResourceContextEnabled = true;
    const imported = await importSharedAgent(importedDetail, emptySelections());
    await writeFile(
      mockAgentModelsFilePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            ...imported.agent,
            remoteId: importedDetail.id,
            remoteAccountId: 'legacy-account',
          },
        ],
      }),
      'utf8',
    );

    const [normalized] = await listAgentModels();

    expect(normalized).toMatchObject({
      importedFromRemoteId: importedDetail.id,
    });
    expect(normalized).not.toHaveProperty('remoteId');
    expect(normalized).not.toHaveProperty('remoteAccountId');
  });

  it.each([false, true])(
    'migrates a persisted legacy import with resource lanes enabled (%s)',
    async (enabled) => {
      mockResourceContextEnabled = enabled;
      const imported = await importSharedAgent(
        importedDetail,
        emptySelections(),
      );
      const legacy = { ...imported.agent };
      delete legacy.importedFromRemoteId;
      legacy.remoteId = importedDetail.id;
      await writeFile(
        mockAgentModelsFilePath,
        JSON.stringify({ version: 1, agents: [legacy] }),
        'utf8',
      );

      const migrated = await importSharedAgent(
        importedDetail,
        emptySelections(),
      );

      expect(migrated.agent).toMatchObject({
        importedFromRemoteId: importedDetail.id,
        remoteContentHash: importedDetail.contentHash,
      });
      expect(migrated.agent.remoteId).toBeUndefined();
      await expect(getAgentModel(legacy.id)).resolves.toMatchObject({
        importedFromRemoteId: importedDetail.id,
      });
      const persistedLegacy = await getAgentModel(legacy.id);
      if (!persistedLegacy) throw new Error('Expected migrated Agent');
      expect(persistedLegacy.remoteId).toBeUndefined();
    },
  );

  it.each(['instructions', 'plugins', 'name', 'disk edit'])(
    'protects scoped imports with changed %s during uninstall and re-import',
    async (edit): Promise<void> => {
      mockResourceContextEnabled = true;
      const first = await importSharedAgent(importedDetail, emptySelections());
      const edited = {
        ...first.agent,
        instructions:
          edit === 'instructions' || edit === 'disk edit'
            ? 'Local secret'
            : first.agent.instructions,
        name: edit === 'name' ? 'Local name' : first.agent.name,
        pluginSelections:
          edit === 'plugins'
            ? {
                ...emptySelections(),
                pluginRefs: [{ marketplaceId: 'local', pluginName: 'private' }],
              }
            : first.agent.pluginSelections,
      };
      if (edit === 'disk edit') {
        await writeFile(
          mockAgentModelsFilePath,
          JSON.stringify({ version: 1, agents: [edited] }),
        );
      } else {
        await saveAgentModel(edited);
      }
      await expect(
        deleteAgentModel(first.agent.id, {
          remoteId: importedDetail.id,
          contentHash: importedDetail.contentHash,
        }),
      ).rejects.toThrow('locally changed');
      expect(await getAgentModel(first.agent.id)).toMatchObject({
        instructions: edited.instructions,
        pluginSelections: edited.pluginSelections,
      });
      const second = await importSharedAgent(importedDetail, emptySelections());
      expect(second.agent.id).not.toBe(first.agent.id);
      expect(
        await importSharedAgent(importedDetail, emptySelections()),
      ).toEqual(second);
      await expect(
        deleteAgentModel(second.agent.id, {
          remoteId: importedDetail.id,
          contentHash: importedDetail.contentHash,
        }),
      ).resolves.toBe(true);
      await expect(deleteAgentModel(first.agent.id)).resolves.toBe(true);
    },
  );
  it.each([
    'legacy',
    'wrong remote',
    'wrong hash',
    'changed during authorization',
  ])('refuses unsafe scoped uninstall: %s', async (kind): Promise<void> => {
    mockResourceContextEnabled = true;
    const { agent } = await importSharedAgent(
      importedDetail,
      emptySelections(),
    );
    if (kind === 'legacy') {
      const legacy = { ...agent };
      delete legacy.importedContentHash;
      await writeFile(
        mockAgentModelsFilePath,
        JSON.stringify({ version: 1, agents: [legacy] }),
      );
    }
    if (kind === 'changed during authorization') {
      mockAssertStoredAgentContext.mockImplementationOnce(
        async (): Promise<void> => {
          await saveAgentModel({
            ...agent,
            instructions: 'Edited during authorization',
          });
        },
      );
    }
    await expect(
      deleteAgentModel(agent.id, {
        remoteId: kind === 'wrong remote' ? 'other-share' : importedDetail.id,
        contentHash:
          kind === 'wrong hash' ? 'other-hash' : importedDetail.contentHash,
      }),
    ).rejects.toThrow();
    expect(await getAgentModel(agent.id)).not.toBeNull();
  });
  it.each([true, false])(
    'preserves flag-off public uninstall behavior (%s)',
    async (enabled): Promise<void> => {
      mockResourceContextEnabled = enabled;
      const first = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      if (enabled) {
        expect(first.importedContentHash).toBe(first.contentHash);
      } else {
        expect(first).not.toHaveProperty('importedContentHash');
      }
      await expect(
        uninstallPublicAgent(first.id, PUBLIC_SHARE_ID, PUBLIC_CONTENT_HASH),
      ).resolves.toBe(true);
      const edited = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      await saveAgentModel({ ...edited, instructions: 'Edited' });
      const deletion = uninstallPublicAgent(
        edited.id,
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      if (enabled) await expect(deletion).rejects.toThrow('locally changed');
      else await expect(deletion).resolves.toBe(true);
    },
  );
  it('does not reuse a locally edited scoped import', async (): Promise<void> => {
    mockResourceContextEnabled = true;
    const first = await importSharedAgent(importedDetail, emptySelections());
    await saveAgentModel({ ...first.agent, instructions: 'Local secret' });
    const second = await importSharedAgent(importedDetail, emptySelections());
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(await getAgentModel(first.agent.id)).toMatchObject({
      instructions: 'Local secret',
    });
  });
  it.each(['instructions', 'plugins'])(
    'revalidates public imported %s before uninstall',
    async (edit): Promise<void> => {
      mockResourceContextEnabled = true;
      const first = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      await saveAgentModel({
        ...first,
        instructions:
          edit === 'instructions' ? 'Local secret' : first.instructions,
        pluginSelections:
          edit === 'plugins'
            ? {
                ...emptySelections(),
                pluginRefs: [{ marketplaceId: 'local', pluginName: 'private' }],
              }
            : first.pluginSelections,
      });
      await expect(
        uninstallPublicAgent(first.id, PUBLIC_SHARE_ID, PUBLIC_CONTENT_HASH),
      ).rejects.toThrow('locally changed');
      expect(await getAgentModel(first.id)).not.toBeNull();
    },
  );

  it.each(['public', 'shared'])(
    'fingerprints finalized %s package selections and preserves edit protection',
    async (source): Promise<void> => {
      mockResourceContextEnabled = true;
      const imported =
        source === 'public'
          ? await importPublicAgent(
              importedDocument,
              emptySelections(),
              PUBLIC_SHARE_ID,
              PUBLIC_CONTENT_HASH,
            )
          : (await importSharedAgent(importedDetail, emptySelections())).agent;
      const installed = await saveAgentModel(
        {
          ...imported,
          pluginSelections: {
            ...emptySelections(),
            skillRefs: [{ sourceId: 'custom:app', skillName: 'packaged' }],
          },
        },
        imported.importedContentHash,
      );
      expect(installed.contentHash).not.toBe(imported.contentHash);
      expect(installed.importedContentHash).toBe(installed.contentHash);
      // Transaction rollback must restore both the selections and fingerprint.
      const restored = await saveAgentModel(
        imported,
        installed.importedContentHash,
      );
      expect(restored.importedContentHash).toBe(imported.importedContentHash);
      await saveAgentModel({ ...restored, instructions: 'Local edits' });
      await expect(
        saveAgentModel(imported, restored.importedContentHash),
      ).rejects.toThrow('locally changed');
    },
  );

  it.each([
    { source: 'public', enabled: false },
    { source: 'public', enabled: true },
    { source: 'shared', enabled: false },
    { source: 'shared', enabled: true },
  ])(
    'keeps edited imports during package rollback (%j)',
    async ({ source, enabled }): Promise<void> => {
      mockResourceContextEnabled = enabled;
      const imported =
        source === 'public'
          ? await importPublicAgent(
              importedDocument,
              emptySelections(),
              PUBLIC_SHARE_ID,
              PUBLIC_CONTENT_HASH,
            )
          : (await importSharedAgent(importedDetail, emptySelections())).agent;
      await saveAgentModel({ ...imported, instructions: 'User edit' });
      await expect(
        deleteAgentModel(imported.id, undefined, imported.contentHash),
      ).resolves.toBe(false);
      const retained = await getAgentModel(imported.id);
      expect(retained).toMatchObject({ instructions: 'User edit' });
      expect(retained?.importedContentHash).toBeUndefined();
      expect(retained?.importedFromRemoteId).toBeUndefined();
      expect(retained?.publicShareExternalId).toBeUndefined();
      expect(retained?.publicShareContentHash).toBeUndefined();
      if (source === 'shared') {
        expect(retained?.remoteId).toBeUndefined();
        expect(retained?.importedFromRemoteId).toBeUndefined();
        expect(retained?.remoteContentHash).toBe(importedDetail.contentHash);
      }
    },
  );

  it('does not let package finalization bless an authored Agent or a stale import', async (): Promise<void> => {
    mockResourceContextEnabled = true;
    const authored = await saveAgentModel({
      name: 'Authored',
      baseModel: BASE_MODEL,
      instructions: '',
      pluginSelections: emptySelections(),
    });
    await expect(
      saveAgentModel(authored, authored.contentHash),
    ).rejects.toThrow('original content is unknown');
    const imported = await importPublicAgent(
      importedDocument,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    await expect(saveAgentModel(imported, 'stale-fingerprint')).rejects.toThrow(
      'changed during package installation',
    );
    expect(await getAgentModel(imported.id)).toEqual(imported);
  });

  it('returns an empty list when the store file does not exist', async () => {
    await expect(listAgentModels()).resolves.toEqual([]);
  });

  it('imports public Agent documents idempotently with public-link provenance', async () => {
    const document = {
      version: 1 as const,
      id: 'agent_model_public_reviewer',
      name: 'Public Reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Review public code.',
      plugins: [],
    };
    const first = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    const second = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    expect(second).toEqual(first);
    expect(first.remoteId).toBeUndefined();
    expect(first).toMatchObject({
      publicShareExternalId: PUBLIC_SHARE_ID,
      publicShareContentHash: PUBLIC_CONTENT_HASH,
    });
    await expect(
      findInstalledPublicAgent(
        document,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      ),
    ).resolves.toEqual(first);
    await expect(listAgentModels()).resolves.toHaveLength(1);
  });

  it('redetects a public Agent after resolving local id and name collisions', async () => {
    await saveAgentModel({
      name: 'Public Reviewer',
      modelIdSlug: 'public_reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Existing local instructions.',
      pluginSelections: emptySelections(),
    });
    const document = {
      version: 1 as const,
      id: 'agent_model_public_reviewer',
      name: 'Public Reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Shared public instructions.',
      plugins: [],
    };

    const first = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    const second = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );

    expect(first).toMatchObject({
      id: 'agent_model_public_reviewer_2',
      name: 'Public Reviewer (2)',
    });
    expect(second).toEqual(first);
    await expect(
      findInstalledPublicAgent(
        document,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      ),
    ).resolves.toEqual(first);
    await expect(listAgentModels()).resolves.toHaveLength(2);
  });

  it("does not classify the publisher's source Agent as an installed public copy", async () => {
    const source = await saveAgentModel({
      name: 'Public Reviewer',
      modelIdSlug: 'public_reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Review public code.',
      pluginSelections: emptySelections(),
    });
    const document = {
      version: 1 as const,
      id: source.id,
      name: source.name,
      baseModel: BASE_MODEL,
      instructions: source.instructions,
      plugins: [],
    };

    await expect(
      findInstalledPublicAgent(
        document,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      ),
    ).resolves.toBeNull();
  });

  it('revalidates public-link provenance before uninstalling an Agent', async () => {
    const document = {
      version: 1 as const,
      id: 'agent_model_public_reviewer',
      name: 'Public Reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Review public code.',
      plugins: [],
    };
    const imported = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );

    await expect(
      uninstallPublicAgent(
        imported.id,
        '22222222-2222-4222-8222-222222222222',
        PUBLIC_CONTENT_HASH,
      ),
    ).rejects.toThrow('not an installed copy');
    await expect(listAgentModels()).resolves.toHaveLength(1);
    await expect(
      uninstallPublicAgent(imported.id, PUBLIC_SHARE_ID, PUBLIC_CONTENT_HASH),
    ).resolves.toBe(true);
    await expect(listAgentModels()).resolves.toEqual([]);
  });

  it('saves, reloads and re-imports an Agent that inherits the default model', async () => {
    const saved = await saveAgentModel({
      name: 'Inherits Default',
      baseModel: AGENT_DEFAULT_BASE_MODEL,
      instructions: 'Use the destination default.',
      pluginSelections: emptySelections(),
    });
    expect(saved.baseModel).toBe(AGENT_DEFAULT_BASE_MODEL);
    await expect(getAgentModel(saved.id)).resolves.toEqual(saved);
    const pinned = await saveAgentModel({ ...saved, baseModel: BASE_MODEL });
    expect(pinned.contentHash).not.toBe(saved.contentHash);
    const restored = await saveAgentModel({
      ...pinned,
      baseModel: AGENT_DEFAULT_BASE_MODEL,
    });
    expect(restored.contentHash).toBe(saved.contentHash);

    const document = {
      version: 1 as const,
      id: 'agent_model_public_inherit',
      name: 'Public Inherit',
      baseModel: AGENT_DEFAULT_BASE_MODEL,
      instructions: 'Shared without a pinned model.',
      plugins: [],
    };
    const first = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    const second = await importPublicAgent(
      document,
      emptySelections(),
      PUBLIC_SHARE_ID,
      PUBLIC_CONTENT_HASH,
    );
    expect(first.baseModel).toBe(AGENT_DEFAULT_BASE_MODEL);
    expect(second).toEqual(first);
  });

  it('creates stable ids and keeps ids stable across renames', async () => {
    const first = await saveAgentModel({
      name: 'Code Reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Review code.',
      pluginSelections: emptySelections(),
    });
    const renamed = await saveAgentModel({
      id: first.id,
      name: 'Renamed Reviewer',
      baseModel: BASE_MODEL,
      instructions: 'Review code.',
      pluginSelections: emptySelections(),
    });

    expect(first.id).toBe('agent_model_code_reviewer');
    expect(renamed.id).toBe(first.id);
    expect(renamed.name).toBe('Renamed Reviewer');
  });

  it('honors custom model id slugs on create', async () => {
    const created = await saveAgentModel({
      name: 'Code Reviewer',
      modelIdSlug: 'review_bot',
      baseModel: BASE_MODEL,
      instructions: 'Review code.',
      pluginSelections: emptySelections(),
    });

    expect(created.id).toBe('agent_model_review_bot');
  });

  it('dedupes custom model id slugs with numeric suffixes', async () => {
    await saveAgentModel({
      name: 'First',
      modelIdSlug: 'review',
      baseModel: BASE_MODEL,
      instructions: '',
      pluginSelections: emptySelections(),
    });
    await saveAgentModel({
      name: 'Second',
      modelIdSlug: 'review',
      baseModel: BASE_MODEL,
      instructions: '',
      pluginSelections: emptySelections(),
    });

    await expect(listAgentModels()).resolves.toEqual([
      expect.objectContaining({ id: 'agent_model_review' }),
      expect.objectContaining({ id: 'agent_model_review_2' }),
    ]);
  });

  it('rejects attempts to change ids on update', async () => {
    const created = await saveAgentModel({
      name: 'Stable Agent',
      baseModel: BASE_MODEL,
      instructions: '',
      pluginSelections: emptySelections(),
    });

    await expect(
      saveAgentModel({
        id: created.id,
        name: 'Stable Agent',
        modelIdSlug: 'different',
        baseModel: BASE_MODEL,
        instructions: '',
        pluginSelections: emptySelections(),
      }),
    ).rejects.toThrow(
      'Agent model ID cannot be changed after the Agent is created.',
    );
  });

  it('returns an existing agent unchanged for no-op updates', async () => {
    const created = await saveAgentModel({
      name: 'No Op Agent',
      baseModel: BASE_MODEL,
      instructions: 'Keep stable.',
      pluginSelections: emptySelections(),
    });

    const updated = await saveAgentModel({
      id: created.id,
      name: created.name,
      baseModel: created.baseModel,
      instructions: created.instructions,
      pluginSelections: created.pluginSelections,
    });

    expect(updated).toEqual(created);
    expect(updated.updatedAt).toBe(created.updatedAt);
  });

  it('rejects updates for missing agent ids instead of creating agents', async () => {
    await expect(
      saveAgentModel({
        id: 'agent_model_missing',
        name: 'Missing Agent',
        baseModel: BASE_MODEL,
        instructions: '',
        pluginSelections: emptySelections(),
      }),
    ).rejects.toThrow('Agent model "agent_model_missing" does not exist.');

    await expect(listAgentModels()).resolves.toEqual([]);
  });

  it('skips corrupt entries while retaining semantically stale agents', async () => {
    await writeFile(
      mockAgentModelsFilePath,
      JSON.stringify({
        version: 1,
        agents: [
          { id: 'not-an-agent' },
          {
            id: 'agent_model_stale',
            name: 'Stale',
            baseModel: 'missing-base-model',
            instructions: '',
            pluginSelections: emptySelections(),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );

    await expect(listAgentModels()).resolves.toEqual([
      expect.objectContaining({
        id: 'agent_model_stale',
        baseModel: 'missing-base-model',
      }),
    ]);
  });

  it.each([true, false])(
    'preserves the authored source when importing its share with lanes enabled (%s)',
    async (enabled): Promise<void> => {
      mockResourceContextEnabled = enabled;
      mockSharedAgentIsAuthoredByCurrentAccount.mockResolvedValue(true);
      const detail = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Imported Agent',
        modelId: 'agent_model_imported',
        baseModel: BASE_MODEL,
        instructionsPreview: '',
        contentHash: 'remote-hash',
        shareScope: 'private' as const,
        owner: { type: 'user' as const, id: 'user-1', name: 'Owner' },
        createdBy: {
          id: 'user-1',
          name: 'Owner',
          email: 'owner@example.test',
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        agent: {
          version: 1 as const,
          id: 'agent_model_imported',
          name: 'Imported Agent',
          baseModel: BASE_MODEL,
          instructions: 'Imported instructions.',
          plugins: [],
        },
      };

      const authored = await saveAgentModel({
        name: detail.agent.name,
        baseModel: BASE_MODEL,
        instructions: 'Later local edits',
        pluginSelections: emptySelections(),
      });
      detail.agent.id = authored.id;
      await writeAgentRemoteMetadata({
        id: authored.id,
        remoteId: detail.id,
        remoteContentHash: detail.contentHash,
      });
      const imported = await importSharedAgent(detail, emptySelections());
      if (enabled) {
        expect(imported.agent.id).not.toBe(authored.id);
        expect(imported.agent).toMatchObject({
          importedFromRemoteId: detail.id,
        });
        expect(await importSharedAgent(detail, emptySelections())).toEqual(
          imported,
        );
        await saveAgentModel({
          ...imported.agent,
          instructions: 'Edited import',
        });
        expect(await getAgentModel(imported.agent.id)).toMatchObject({
          importedFromRemoteId: detail.id,
        });
        await deleteAgentModel(imported.agent.id);
        expect(await getAgentModel(authored.id)).toMatchObject({
          instructions: 'Later local edits',
        });
      } else {
        expect(imported.agent.id).toBe(authored.id);
        expect(imported.agent).not.toHaveProperty('importedFromRemoteId');
      }
    },
  );

  it('imports shared agents idempotently by remote content hash', async () => {
    const detail = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Imported Agent',
      modelId: 'agent_model_imported',
      baseModel: BASE_MODEL,
      instructionsPreview: '',
      contentHash: 'remote-hash',
      shareScope: 'private' as const,
      owner: { type: 'user' as const, id: 'user-1', name: 'Owner' },
      createdBy: {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      agent: {
        version: 1 as const,
        id: 'agent_model_imported',
        name: 'Imported Agent',
        baseModel: BASE_MODEL,
        instructions: 'Imported instructions.',
        plugins: [],
      },
    };

    mockRecordSharedAgentInstall.mockRejectedValueOnce(
      new Error('Receipt unavailable'),
    );
    await expect(importSharedAgent(detail, emptySelections())).rejects.toThrow(
      'Receipt unavailable',
    );
    await expect(listAgentModels()).resolves.toEqual([]);
    const first = await importSharedAgent(detail, emptySelections());
    const second = await importSharedAgent(detail, emptySelections());

    expect(second).toEqual(first);
    expect((await listAgentModels()).map((agent) => agent.id)).toEqual([
      'agent_model_imported',
    ]);
  });

  it('imports shared agents idempotently after resolving local id conflicts', async () => {
    await saveAgentModel({
      name: 'Imported Agent',
      baseModel: BASE_MODEL,
      instructions: 'Local instructions.',
      pluginSelections: emptySelections(),
    });

    const detail = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Imported Agent',
      modelId: 'agent_model_imported_agent',
      baseModel: BASE_MODEL,
      instructionsPreview: '',
      contentHash: 'remote-hash-conflict',
      shareScope: 'private' as const,
      owner: { type: 'user' as const, id: 'user-1', name: 'Owner' },
      createdBy: {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      agent: {
        version: 1 as const,
        id: 'agent_model_imported_agent',
        name: 'Imported Agent',
        baseModel: BASE_MODEL,
        instructions: 'Imported instructions.',
        plugins: [],
      },
    };

    const first = await importSharedAgent(detail, emptySelections());
    const second = await importSharedAgent(detail, emptySelections());
    const agents = await listAgentModels();

    expect(mockRecordSharedAgentInstall).toHaveBeenCalledWith(
      detail,
      'agent_model_imported_agent_2',
    );
    expect(first.agent.id).toBe('agent_model_imported_agent_2');
    expect(first.agent.name).toBe('Imported Agent (2)');
    expect(first).toMatchObject({
      requestedId: 'agent_model_imported_agent',
      finalId: 'agent_model_imported_agent_2',
      idChanged: true,
    });
    expect(second).toEqual(first);
    expect(agents.map((agent) => agent.id)).toEqual([
      'agent_model_imported_agent',
      'agent_model_imported_agent_2',
    ]);
    expect(
      agents.filter((agent) => agent.importedFromRemoteId === detail.id),
    ).toHaveLength(1);
  });

  it('persists the cloud account bound to an authored remote link', async () => {
    const agent = await saveAgentModel({
      name: 'Bound author',
      baseModel: BASE_MODEL,
      instructions: '',
      pluginSelections: emptySelections(),
    });

    await writeAgentRemoteMetadata({
      id: agent.id,
      remoteId: 'shared-agent-id',
      remoteAccountId: 'account-a',
      remoteContentHash: 'remote-hash',
    });

    await expect(getAgentModel(agent.id)).resolves.toMatchObject({
      remoteId: 'shared-agent-id',
      remoteAccountId: 'account-a',
      remoteContentHash: 'remote-hash',
    });
  });

  it('clears remote metadata from every local copy of a shared agent', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    await writeFile(
      mockAgentModelsFilePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'agent_model_first',
            name: 'First',
            baseModel: BASE_MODEL,
            instructions: '',
            pluginSelections: emptySelections(),
            createdAt: now,
            updatedAt: now,
            localContentHash: 'first-hash',
            remoteId: 'shared-agent-id',
            remoteContentHash: 'remote-first',
          },
          {
            id: 'agent_model_second',
            name: 'Second',
            baseModel: BASE_MODEL,
            instructions: '',
            pluginSelections: emptySelections(),
            createdAt: now,
            updatedAt: now,
            localContentHash: 'second-hash',
            remoteId: 'shared-agent-id',
            remoteContentHash: 'remote-second',
          },
          {
            id: 'agent_model_other',
            name: 'Other',
            baseModel: BASE_MODEL,
            instructions: '',
            pluginSelections: emptySelections(),
            createdAt: now,
            updatedAt: now,
            localContentHash: 'other-hash',
            remoteId: 'other-shared-agent-id',
            remoteContentHash: 'other-remote',
          },
        ],
      }),
    );

    await expect(
      clearAgentRemoteMetadataByRemoteId('shared-agent-id'),
    ).resolves.toBe(2);

    const agents = await listAgentModels();
    expect(
      agents.filter((agent) => agent.remoteId === 'shared-agent-id'),
    ).toHaveLength(0);
    expect(
      agents.find((agent) => agent.id === 'agent_model_other'),
    ).toMatchObject({
      remoteId: 'other-shared-agent-id',
      remoteContentHash: 'other-remote',
    });
  });

  it('deletes missing agents idempotently', async () => {
    await expect(deleteAgentModel('agent_model_missing')).resolves.toBe(false);
  });
  describe('install subscriptions', () => {
    const mockedRecordInstall = jest.mocked(recordSharedItemInstall);
    const mockedRecordUninstall = jest.mocked(recordSharedItemUninstall);

    it('registers a shared import after it is written, including an idempotent re-import', async () => {
      const first = await importSharedAgent(importedDetail, emptySelections());
      await importSharedAgent(importedDetail, emptySelections());
      const expected = {
        kind: 'agent',
        remoteId: importedDetail.id,
        sourceKind: 'shared',
        contentHash: importedDetail.contentHash,
        localId: first.agent.id,
      };
      expect(mockedRecordInstall.mock.calls).toEqual([[expected], [expected]]);
    });

    it('does not register a shared import whose receipt failed', async () => {
      mockRecordSharedAgentInstall.mockRejectedValueOnce(
        new Error('Receipt unavailable'),
      );
      await expect(
        importSharedAgent(importedDetail, emptySelections()),
      ).rejects.toThrow('Receipt unavailable');
      expect(mockedRecordInstall).not.toHaveBeenCalled();
    });

    it("does not register re-importing the author's own share", async () => {
      const authored = await saveAgentModel({
        name: importedDocument.name,
        modelIdSlug: 'imported',
        baseModel: BASE_MODEL,
        instructions: importedDocument.instructions,
        pluginSelections: emptySelections(),
      });
      await writeAgentRemoteMetadata({
        id: authored.id,
        remoteId: importedDetail.id,
        remoteContentHash: importedDetail.contentHash,
      });
      mockSharedAgentIsAuthoredByCurrentAccount.mockResolvedValue(true);
      const imported = await importSharedAgent(
        { ...importedDetail, agent: { ...importedDocument, id: authored.id } },
        emptySelections(),
      );
      expect(imported.agent.id).toBe(authored.id);
      expect(mockedRecordInstall).not.toHaveBeenCalled();
    });

    it('registers a public import with its share id and hash', async () => {
      const imported = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      expect(mockedRecordInstall).toHaveBeenCalledWith({
        kind: 'agent',
        remoteId: PUBLIC_SHARE_ID,
        sourceKind: 'public',
        contentHash: PUBLIC_CONTENT_HASH,
        localId: imported.id,
      });
    });

    it('unregisters a deleted shared import and a deleted public import', async () => {
      const shared = await importSharedAgent(importedDetail, emptySelections());
      const publicAgent = await importPublicAgent(
        { ...importedDocument, id: 'agent_model_public' },
        emptySelections(),
        '22222222-2222-4222-8222-222222222222',
        'other-hash',
      );
      await expect(deleteAgentModel(shared.agent.id)).resolves.toBe(true);
      await expect(deleteAgentModel(publicAgent.id)).resolves.toBe(true);
      expect(mockedRecordUninstall.mock.calls).toEqual([
        [
          {
            kind: 'agent',
            remoteId: importedDetail.id,
            sourceKind: 'shared',
            localId: shared.agent.id,
          },
        ],
        [
          {
            kind: 'agent',
            remoteId: '22222222-2222-4222-8222-222222222222',
            sourceKind: 'public',
            localId: publicAgent.id,
          },
        ],
      ]);
    });

    it('does not unregister a local agent or a missing one', async () => {
      const local = await saveAgentModel({
        name: 'Local',
        baseModel: BASE_MODEL,
        instructions: '',
        pluginSelections: emptySelections(),
      });
      await deleteAgentModel(local.id);
      await deleteAgentModel('agent_model_missing');
      expect(mockedRecordUninstall).not.toHaveBeenCalled();
    });

    it('unregisters an edited import whose install markers a package rollback strips', async () => {
      const imported = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      await saveAgentModel({ ...imported, instructions: 'User edit' });
      await expect(
        deleteAgentModel(imported.id, undefined, imported.contentHash),
      ).resolves.toBe(false);
      expect(mockedRecordUninstall).toHaveBeenCalledWith({
        kind: 'agent',
        remoteId: PUBLIC_SHARE_ID,
        sourceKind: 'public',
        localId: imported.id,
      });
    });

    it('unregisters an uninstalled public agent only after provenance checks pass', async () => {
      const imported = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      await expect(
        uninstallPublicAgent(
          imported.id,
          '22222222-2222-4222-8222-222222222222',
          PUBLIC_CONTENT_HASH,
        ),
      ).rejects.toThrow('not an installed copy');
      expect(mockedRecordUninstall).not.toHaveBeenCalled();
      await uninstallPublicAgent(
        imported.id,
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      expect(mockedRecordUninstall).toHaveBeenCalledWith({
        kind: 'agent',
        remoteId: PUBLIC_SHARE_ID,
        sourceKind: 'public',
        localId: imported.id,
      });
    });

    it('lists every stored agent for the backfill, regardless of context', async () => {
      const imported = await importPublicAgent(
        importedDocument,
        emptySelections(),
        PUBLIC_SHARE_ID,
        PUBLIC_CONTENT_HASH,
      );
      mockAssertStoredAgentContext.mockRejectedValue(
        new Error('Agent unavailable (context-mismatch)'),
      );
      await expect(listAgentModels()).resolves.toEqual([]);
      await expect(listAgentModelsForInstallBackfill()).resolves.toEqual([
        imported,
      ]);
    });
  });
});
