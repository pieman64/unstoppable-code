import {
  catalogMaterializationFingerprintInput,
  catalogMaterializationSecretBindings,
  type CatalogMaterializationItemDescriptor,
  type CatalogMaterializationMcpServerDescriptor,
} from '../core';
import {
  ExecutionSecretBindingsSchema,
  STORED_SECRET_REF_PATTERN,
  WORKER_CATALOG_CODES,
  WorkerCatalogMaterializationSchema,
  WorkerCatalogMaterializeParamsSchema,
} from '../worker';

const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const materializationId = `catalog-materialization:v1:${'a'.repeat(64)}`;
const ref = (char: string): string => `ssr1_${char.repeat(43)}`;
const [r1, r2, r3, r4] = [ref('a'), ref('b'), ref('c'), ref('d')];

const mcp = (
  serverId: string,
  overrides: Partial<CatalogMaterializationMcpServerDescriptor> = {},
): CatalogMaterializationMcpServerDescriptor => ({
  kind: 'mcp_server',
  entryId: `mcp_server:${serverId}/c`,
  serverId,
  configId: 'c',
  transport: 'stdio',
  binding: 'device',
  configRevision: sha('1'),
  secretRefs: [],
  ...overrides,
});

const plugin: CatalogMaterializationItemDescriptor = {
  kind: 'plugin',
  entryId: 'plugin:m/p',
  marketplaceId: 'm',
  pluginName: 'p',
  providers: ['claude'],
  pluginRevision: sha('2'),
};

const params = (items: unknown[]): Record<string, unknown> => ({
  materializationId,
  scope: { chatId: 'c' },
  itemDescriptors: items,
  expectedFingerprint: sha('3'),
  secretGrantIds: [materializationId],
  _meta: { idempotencyKey: materializationId },
});

const accepts = (items: unknown[]): boolean =>
  WorkerCatalogMaterializeParamsSchema.safeParse(params(items)).success;

describe('catalog MCP contracts (CAN-4125)', () => {
  it('MCP descriptors are strict and carry references, never values', () => {
    expect(r1).toMatch(STORED_SECRET_REF_PATTERN);
    expect(accepts([mcp('a', { secretRefs: [r1, r2] })])).toBe(true);

    expect(accepts([{ ...mcp('a'), value: 'secret' }])).toBe(false);
    expect(accepts([mcp('a', { secretRefs: ['plain-secret-value'] })])).toBe(
      false,
    );
    expect(accepts([mcp('a', { secretRefs: [r2, r1] })])).toBe(false);
    expect(accepts([mcp('a', { secretRefs: [r1, r1] })])).toBe(false);
    expect(
      accepts([
        mcp('a', { binding: 'account', transport: 'http', secretRefs: [r1] }),
      ]),
    ).toBe(false);
    expect(
      accepts([mcp('a', { binding: 'account', transport: 'stdio' })]),
    ).toBe(false);
    expect(accepts([mcp('a', { configRevision: 'sha256:abc' })])).toBe(false);
    expect(
      accepts([mcp('a', { configRevision: `sha1:${'0'.repeat(64)}` })]),
    ).toBe(false);
  });

  it('secret bindings are derived in a fixed order and capped', () => {
    const items: CatalogMaterializationItemDescriptor[] = [
      mcp('b', { secretRefs: [r3, r4] }),
      plugin,
      mcp('a', { secretRefs: [r1, r2] }),
      mcp('acct', { binding: 'account', transport: 'http' }),
    ];
    const bindings = catalogMaterializationSecretBindings(items);
    expect(bindings).toEqual(
      [
        { name: 'CANOPY_MCP_SECRET_0', record: 'a', ref: r1 },
        { name: 'CANOPY_MCP_SECRET_1', record: 'a', ref: r2 },
        { name: 'CANOPY_MCP_SECRET_2', record: 'b', ref: r3 },
        { name: 'CANOPY_MCP_SECRET_3', record: 'b', ref: r4 },
      ].map(({ name, record, ref: secretRef }) => ({
        name,
        source: {
          kind: 'stored-secret',
          family: 'mcp.server',
          record,
          ref: secretRef,
        },
      })),
    );
    expect(ExecutionSecretBindingsSchema.safeParse(bindings).success).toBe(
      true,
    );

    const many = (prefix: string, count: number): string[] =>
      Array.from(
        { length: count },
        (_, index) => `ssr1_${prefix}${String(index).padStart(42, '0')}`,
      );
    expect(
      accepts([
        mcp('a', { secretRefs: many('a', 33) }),
        mcp('b', { secretRefs: many('b', 31) }),
      ]),
    ).toBe(true);
    expect(
      accepts([
        mcp('a', { secretRefs: many('a', 33) }),
        mcp('b', { secretRefs: many('b', 32) }),
      ]),
    ).toBe(false);
  });

  it('the fingerprint covers MCP items', () => {
    const items: CatalogMaterializationItemDescriptor[] = [
      mcp('a', { secretRefs: [r1] }),
      plugin,
      mcp('b'),
    ];
    const base = catalogMaterializationFingerprintInput(items);
    expect(
      catalogMaterializationFingerprintInput([
        mcp('a', { secretRefs: [r1], configRevision: sha('9') }),
        plugin,
        mcp('b'),
      ]),
    ).not.toBe(base);
    expect(
      catalogMaterializationFingerprintInput([
        mcp('a', { secretRefs: [r2] }),
        plugin,
        mcp('b'),
      ]),
    ).not.toBe(base);
    expect(catalogMaterializationFingerprintInput([...items].reverse())).toBe(
      base,
    );
  });

  it('worker results accept MCP items and secret errors', () => {
    const result = (effectiveItems: unknown[]): boolean =>
      WorkerCatalogMaterializationSchema.safeParse({
        materializationId,
        state: 'ready',
        fingerprint: sha('4'),
        effectiveItems,
        diagnostics: [],
      }).success;
    expect(
      result([
        { entryId: 'mcp_server:a/c', kind: 'mcp_server', transport: 'http' },
      ]),
    ).toBe(true);
    expect(
      result([
        {
          entryId: 'mcp_server:a/c',
          kind: 'mcp_server',
          providers: ['claude'],
        },
      ]),
    ).toBe(false);
    expect(WORKER_CATALOG_CODES).toContain('worker.executionSecret.notGranted');
  });
});
