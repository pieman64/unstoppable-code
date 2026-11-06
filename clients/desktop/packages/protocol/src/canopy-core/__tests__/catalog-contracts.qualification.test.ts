import {
  CatalogSourceRefreshParamsSchema,
  CatalogSourceUpsertParamsSchema,
  catalogMaterializationFingerprintInput,
  catalogMaterializationIdInput,
  resolveCatalogEntryIds,
  selectionEntryIds,
  type CatalogMaterializationItemDescriptor,
} from '../core';
import { WorkerCatalogMaterializeParamsSchema } from '../worker';

const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const materializationId = `catalog-materialization:v1:${'a'.repeat(64)}`;

const plugin = (
  name: string,
  pluginRevision = sha('1'),
): CatalogMaterializationItemDescriptor => ({
  kind: 'plugin',
  entryId: `plugin:m/${name}`,
  marketplaceId: 'm',
  pluginName: name,
  providers: ['claude'],
  pluginRevision,
});

const materializeParams = (items: unknown[]): Record<string, unknown> => ({
  materializationId,
  scope: { chatId: 'c' },
  itemDescriptors: items,
  expectedFingerprint: sha('2'),
  _meta: { idempotencyKey: materializationId },
});

const meta = { idempotencyKey: 'k' };

describe('catalog contracts (CAN-4123)', () => {
  it('resolves entry ids by lookup, never by splitting', () => {
    const ref = { marketplaceId: 'a/b', pluginName: 'c' };
    const known = [{ pluginRefs: [ref] }];

    expect(resolveCatalogEntryIds(['plugin:a/b/c'], known)).toEqual({
      ok: true,
      refs: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [ref],
        mcpServerRefs: [],
      },
    });
    const repeated = resolveCatalogEntryIds(
      ['plugin:a/b/c', 'plugin:a/b/c'],
      known,
    );
    expect(repeated.ok && repeated.refs.pluginRefs).toEqual([ref]);
    expect(resolveCatalogEntryIds(['plugin:a/b/x'], known)).toEqual({
      ok: false,
      unknownId: 'plugin:a/b/x',
    });
    expect(
      selectionEntryIds({
        collectionIds: ['k'],
        skillRefs: [{ sourceId: 's', skillName: 'n' }],
      }),
    ).toEqual(['collection:k', 'skill:s/n']);
  });

  it('strict materialization descriptors', () => {
    expect(
      WorkerCatalogMaterializeParamsSchema.safeParse(
        materializeParams([plugin('p')]),
      ).success,
    ).toBe(true);
    expect(
      WorkerCatalogMaterializeParamsSchema.safeParse(
        materializeParams([
          {
            kind: 'skill',
            entryId: 'skill:s/n',
            sourceId: 's',
            skillName: 'n',
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      WorkerCatalogMaterializeParamsSchema.safeParse(
        materializeParams([{ ...plugin('p'), extra: true }]),
      ).success,
    ).toBe(false);
    expect(
      WorkerCatalogMaterializeParamsSchema.safeParse(
        materializeParams([{ ...plugin('p'), pluginRevision: 'sha256:abc' }]),
      ).success,
    ).toBe(false);
    expect(
      WorkerCatalogMaterializeParamsSchema.safeParse({
        ...materializeParams([plugin('p')]),
        materializationId: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('fingerprint input is order independent and content sensitive', () => {
    const a = plugin('a');
    const b = plugin('b');
    const forward = catalogMaterializationFingerprintInput([a, b]);

    expect(catalogMaterializationFingerprintInput([b, a])).toBe(forward);
    expect(
      catalogMaterializationFingerprintInput([a, plugin('b', sha('3'))]),
    ).not.toBe(forward);
    expect(catalogMaterializationIdInput(sha('4'), { chatId: 'a' })).not.toBe(
      catalogMaterializationIdInput(sha('4'), { chatId: 'b' }),
    );
  });

  it('source contracts follow their pages', () => {
    const refresh = {
      sourceIds: ['s'],
      providers: ['claude', 'codex'],
      mode: 'scan',
      _meta: meta,
    };
    expect(CatalogSourceRefreshParamsSchema.safeParse(refresh).success).toBe(
      true,
    );
    expect(
      CatalogSourceRefreshParamsSchema.safeParse({
        ...refresh,
        sourceIds: Array.from({ length: 101 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
    expect(
      CatalogSourceRefreshParamsSchema.safeParse({
        ...refresh,
        providers: ['claude', 'claude'],
      }).success,
    ).toBe(false);

    const upsert = {
      sourceId: null,
      displayName: 'owner/repo',
      locator: { kind: 'git', repository: 'owner/repo', ref: null },
      providers: ['claude', 'codex'],
      enabled: true,
      expectedRevision: null,
      _meta: meta,
    };
    expect(CatalogSourceUpsertParamsSchema.safeParse(upsert).success).toBe(
      true,
    );
    expect(
      CatalogSourceUpsertParamsSchema.safeParse({
        ...upsert,
        locator: { kind: 'git', repository: 'ownerrepo', ref: null },
      }).success,
    ).toBe(false);
  });
});
