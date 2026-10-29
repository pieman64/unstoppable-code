import { PORTAL_CATALOG_RESULT_MAX_BYTES } from '../../portal';
import {
  DESKTOP_INVENTORY_DEVICE_SCOPE_KEY,
  DESKTOP_INVENTORY_KINDS,
  MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_DOCUMENT_BYTES,
  MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_SCOPE_KEY_LENGTH,
  buildWorktreeInventoryScopeKey,
  isDesktopInventoryKind,
  isDesktopInventoryScopeKeyValid,
  parseDesktopInventorySyncRequest,
  parseWorktreeInventoryScopeKey,
  stableStringify,
  type DesktopInventoryDocument,
} from '../index';

/**
 * Fixture bodies are deliberately untyped: the parser takes `unknown`, and
 * the rejection cases need shapes the wire types would never allow.
 */
type Body = Record<string, unknown>;

function document(overrides: Body = {}): Body {
  return {
    kind: 'skills',
    scopeKey: DESKTOP_INVENTORY_DEVICE_SCOPE_KEY,
    contentHash: 'a'.repeat(64),
    capturedAt: '2026-09-06T10:00:00.000Z',
    payload: { skills: [] },
    ...overrides,
  };
}

function request(overrides: Body = {}): Body {
  return {
    clientDeviceId: 'device-1',
    documents: [document()],
    ...overrides,
  };
}

describe('desktop inventory wire contract (CAN-2830)', () => {
  it('exports the stable kind vocabulary', () => {
    expect([...DESKTOP_INVENTORY_KINDS]).toEqual([
      'marketplaces',
      'skills',
      'mcp_servers',
      'collections',
      'pipelines',
    ]);
    expect(isDesktopInventoryKind('skills')).toBe(true);
    expect(isDesktopInventoryKind('plugins')).toBe(false);
    expect(isDesktopInventoryKind(42)).toBe(false);
  });

  it('caps a document at the portal catalog result budget', () => {
    expect(MAX_DESKTOP_INVENTORY_DOCUMENT_BYTES).toBe(
      PORTAL_CATALOG_RESULT_MAX_BYTES,
    );
  });

  describe('worktree scope keys', () => {
    it('round-trips workspace and worktree local ids', () => {
      const key = buildWorktreeInventoryScopeKey('ws-1', 'wt-2');
      expect(key).toBe('ws-1:wt-2');
      expect(parseWorktreeInventoryScopeKey(key)).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
      });
    });

    it('rejects malformed keys', () => {
      expect(parseWorktreeInventoryScopeKey('')).toBeNull();
      expect(parseWorktreeInventoryScopeKey('ws-only')).toBeNull();
      expect(parseWorktreeInventoryScopeKey(':wt')).toBeNull();
      expect(parseWorktreeInventoryScopeKey('ws:')).toBeNull();
      expect(parseWorktreeInventoryScopeKey('a:b:c')).toBeNull();
    });

    it('refuses ids that would collide with the separator', () => {
      expect(() => buildWorktreeInventoryScopeKey('ws:1', 'wt')).toThrow();
      expect(() => buildWorktreeInventoryScopeKey('', 'wt')).toThrow();
    });
  });

  describe('isDesktopInventoryScopeKeyValid', () => {
    it('requires the device scope key for device-level kinds', () => {
      expect(isDesktopInventoryScopeKeyValid('skills', '')).toBe(true);
      expect(isDesktopInventoryScopeKeyValid('marketplaces', 'ws:wt')).toBe(
        false,
      );
    });

    it('requires a worktree scope key for pipelines', () => {
      expect(isDesktopInventoryScopeKeyValid('pipelines', 'ws:wt')).toBe(true);
      expect(isDesktopInventoryScopeKeyValid('pipelines', '')).toBe(false);
      expect(isDesktopInventoryScopeKeyValid('pipelines', 'ws')).toBe(false);
      expect(
        isDesktopInventoryScopeKeyValid(
          'pipelines',
          `${'w'.repeat(MAX_DESKTOP_INVENTORY_SCOPE_KEY_LENGTH)}:t`,
        ),
      ).toBe(false);
    });
  });

  it('couples kind and payload at the type level', () => {
    const valid: DesktopInventoryDocument = {
      kind: 'skills',
      scopeKey: '',
      contentHash: 'a'.repeat(64),
      capturedAt: '2026-09-06T10:00:00.000Z',
      payload: { skills: [] },
    };
    const mismatched: DesktopInventoryDocument = {
      kind: 'skills',
      scopeKey: '',
      contentHash: 'a'.repeat(64),
      capturedAt: '2026-09-06T10:00:00.000Z',
      // @ts-expect-error a skills document cannot carry a marketplaces payload
      payload: { marketplaces: [], lastRefreshed: '' },
    };
    expect(valid.kind).toBe('skills');
    expect(mismatched.kind).toBe('skills');
  });

  describe('stableStringify', () => {
    it('sorts object keys recursively and preserves arrays', () => {
      const left = stableStringify({
        b: 1,
        a: { z: [3, { y: 1, x: 2 }], w: 0 },
      });
      const right = stableStringify({
        a: { w: 0, z: [3, { x: 2, y: 1 }] },
        b: 1,
      });
      expect(left).toBe(right);
      expect(left).toBe('{"a":{"w":0,"z":[3,{"x":2,"y":1}]},"b":1}');
    });

    it('keeps an own __proto__ key instead of invoking the setter', () => {
      const parsed: unknown = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}');
      expect(stableStringify(parsed)).toBe('{"__proto__":{"x":1},"a":2,"b":1}');
    });

    it('drops undefined members like JSON.stringify and keeps null', () => {
      expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
      expect(stableStringify([undefined, 1])).toBe('[null,1]');
    });
  });

  describe('parseDesktopInventorySyncRequest', () => {
    it('accepts a well-formed request', () => {
      const result = parseDesktopInventorySyncRequest(request());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.clientDeviceId).toBe('device-1');
      expect(result.request.documents).toHaveLength(1);
      expect(result.request.removals).toEqual([]);
    });

    it('accepts removals and an optional client name', () => {
      const result = parseDesktopInventorySyncRequest(
        request({
          clientName: 'Sergii MacBook',
          documents: [],
          removals: [{ kind: 'pipelines', scopeKey: 'ws:wt' }],
        }),
      );
      expect(result).toEqual({
        ok: true,
        request: {
          clientDeviceId: 'device-1',
          clientName: 'Sergii MacBook',
          documents: [],
          removals: [{ kind: 'pipelines', scopeKey: 'ws:wt' }],
        },
      });
    });

    it.each<[string, unknown]>([
      ['non-object body', 'nope'],
      ['missing device id', { documents: [] }],
      ['blank device id', { clientDeviceId: '  ', documents: [] }],
      [
        'oversized device id',
        { clientDeviceId: 'd'.repeat(257), documents: [] },
      ],
      ['documents not an array', { clientDeviceId: 'd', documents: {} }],
      ['unknown kind', request({ documents: [document({ kind: 'plugins' })] })],
      [
        'oversized scope key',
        request({
          documents: [
            document({
              kind: 'pipelines',
              scopeKey: `ws:${'s'.repeat(MAX_DESKTOP_INVENTORY_SCOPE_KEY_LENGTH)}`,
            }),
          ],
        }),
      ],
      [
        'worktree scope key on a device-level kind',
        request({ documents: [document({ scopeKey: 'ws:wt' })] }),
      ],
      [
        'device scope key on pipelines',
        request({ documents: [document({ kind: 'pipelines', scopeKey: '' })] }),
      ],
      [
        'non-canonical capturedAt',
        request({
          documents: [document({ capturedAt: '2026-09-06T10:00:00+02:00' })],
        }),
      ],
      [
        'non-hex content hash',
        request({ documents: [document({ contentHash: 'zz' })] }),
      ],
      [
        'invalid capturedAt',
        request({ documents: [document({ capturedAt: 'yesterday' })] }),
      ],
      [
        'payload not an object',
        request({ documents: [document({ payload: [] })] }),
      ],
      [
        'duplicate document identity',
        request({ documents: [document(), document()] }),
      ],
      [
        'too many documents',
        request({
          documents: Array.from(
            { length: MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST + 1 },
            (_, index) => document({ scopeKey: `s${index}` }),
          ),
        }),
      ],
      [
        'removal with unknown kind',
        request({ removals: [{ kind: 'nope', scopeKey: '' }] }),
      ],
      [
        'removal whose scope key does not fit its kind',
        request({ removals: [{ kind: 'pipelines', scopeKey: '' }] }),
      ],
      [
        'duplicate removal',
        request({
          removals: [
            { kind: 'pipelines', scopeKey: 'ws:wt' },
            { kind: 'pipelines', scopeKey: 'ws:wt' },
          ],
        }),
      ],
      [
        'removal that targets a document in the same request',
        request({ removals: [{ kind: 'skills', scopeKey: '' }] }),
      ],
      [
        'too many removals',
        request({
          documents: [],
          removals: Array.from(
            { length: MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST + 1 },
            (_, index) => ({ kind: 'pipelines', scopeKey: `ws:wt-${index}` }),
          ),
        }),
      ],
      ['removals not an array', request({ removals: {} })],
    ])('rejects %s', (_label, body) => {
      const result = parseDesktopInventorySyncRequest(body);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    });

    it('rejects a document whose payload exceeds the per-document budget', () => {
      const result = parseDesktopInventorySyncRequest(
        request({
          documents: [
            document({
              payload: {
                skills: [],
                // Pad well past the 700 KiB budget.
                padding: 'x'.repeat(MAX_DESKTOP_INVENTORY_DOCUMENT_BYTES + 1),
              },
            }),
          ],
        }),
      );
      expect(result.ok).toBe(false);
    });
  });
});
