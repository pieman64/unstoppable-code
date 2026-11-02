import {
  CORE_WORKSPACE_ITEM_ID_MAX_LENGTH,
  decodeWorkspaceItemId,
  encodeStoredWorkspaceItemId,
  encodeWorkspaceItemId,
  isAddressableWorkspaceItemScope,
  workspaceItemKeyMatches,
  workspaceItemNameDigest,
  workspaceItemRefMatches,
} from '../workspace-item-ids';

describe('workspace item IDs', () => {
  it('spells out the scope and name, escaping separators', () => {
    expect(
      encodeWorkspaceItemId({
        kind: 'attachment',
        workspaceId: 'code-ws',
        worktreeId: 'wt-1',
        name: 'report.pdf',
      }),
    ).toBe('attachment:code-ws@wt-1:report.pdf');
    const id = encodeWorkspaceItemId({
      kind: 'note',
      workspaceId: 'a:b@c',
      worktreeId: null,
      name: '#x: y@z',
    });
    expect(id).toBe('note:a%3Ab%40c:%23x%3A%20y%40z');
    expect(id === null ? null : decodeWorkspaceItemId(id)).toEqual({
      kind: 'note',
      workspaceId: 'a:b@c',
      worktreeId: null,
      key: { form: 'name', name: '#x: y@z' },
    });
  });

  it('round-trips every kind and both scope levels', () => {
    for (const kind of ['note', 'prompt', 'attachment'] as const)
      for (const worktreeId of [null, 'wt-1', 'home-draft']) {
        const scope = { workspaceId: 'ws-1', worktreeId };
        const id = encodeWorkspaceItemId({
          ...scope,
          kind,
          name: 'résumé.txt',
        });
        expect(id === null ? null : decodeWorkspaceItemId(id)).toEqual({
          ...scope,
          kind,
          key: { form: 'name', name: 'résumé.txt' },
        });
      }
  });

  it('digests a name that would exceed the bound and matches it by scanning', () => {
    const name = `${'ü'.repeat(120)}.png`;
    const id = encodeWorkspaceItemId({
      kind: 'attachment',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      name,
    });
    expect(id).toMatch(/^attachment:ws-1@wt-1:#[A-Za-z0-9_-]{43}$/);
    expect(id?.length).toBeLessThanOrEqual(CORE_WORKSPACE_ITEM_ID_MAX_LENGTH);
    const ref = id === null ? null : decodeWorkspaceItemId(id);
    expect(ref?.key.form).toBe('digest');
    expect(ref && workspaceItemKeyMatches(ref.key, name)).toBe(true);
    expect(ref && workspaceItemKeyMatches(ref.key, 'other.png')).toBe(false);
  });

  it('gives a stored name one ID, digesting names a key cannot carry', () => {
    const scope = {
      kind: 'attachment' as const,
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    };
    // A POSIX file name may hold a backslash, and a renderer string a lone
    // surrogate; neither is a key, but both stay addressable once stored.
    for (const name of ['old.v1\\2', 'paste.\uD800']) {
      expect(encodeWorkspaceItemId({ ...scope, name })).toBeNull();
      const id = encodeStoredWorkspaceItemId({ ...scope, name });
      expect(id).toMatch(/^attachment:ws-1@wt-1:#[A-Za-z0-9_-]{43}$/);
      const ref = id === null ? null : decodeWorkspaceItemId(id);
      expect(ref && workspaceItemRefMatches(ref, name)).toBe(true);
    }
    for (const name of ['', '.', '..'])
      expect(encodeStoredWorkspaceItemId({ ...scope, name })).toBeNull();
    expect(encodeStoredWorkspaceItemId({ ...scope, name: 'a.txt' })).toBe(
      'attachment:ws-1@wt-1:a.txt',
    );
    // A digest of a spelled-out name is not that item's ID.
    const alias = decodeWorkspaceItemId(
      `attachment:ws-1@wt-1:#${workspaceItemNameDigest('a.txt')}`,
    );
    expect(alias && workspaceItemKeyMatches(alias.key, 'a.txt')).toBe(true);
    expect(alias && workspaceItemRefMatches(alias, 'a.txt')).toBe(false);
    const long = `${'ü'.repeat(120)}.png`;
    const longId = encodeStoredWorkspaceItemId({ ...scope, name: long });
    const longRef = longId === null ? null : decodeWorkspaceItemId(longId);
    expect(longRef && workspaceItemRefMatches(longRef, long)).toBe(true);
  });

  it('refuses scopes too long for any ID', () => {
    const scope = { workspaceId: 'w'.repeat(300), worktreeId: 't'.repeat(200) };
    expect(isAddressableWorkspaceItemScope(scope, 'attachment')).toBe(false);
    expect(
      encodeWorkspaceItemId({ ...scope, kind: 'attachment', name: 'a' }),
    ).toBeNull();
    expect(
      isAddressableWorkspaceItemScope(
        { workspaceId: 'w'.repeat(200), worktreeId: 't'.repeat(200) },
        'attachment',
      ),
    ).toBe(true);
  });

  it.each([
    '',
    'attachment',
    'attachment:ws-1',
    'folder:ws-1:a.txt',
    'attachment::a.txt',
    'attachment:ws-1@:a.txt',
    'attachment:ws-1@wt-1@x:a.txt',
    'attachment:ws-1:',
    'attachment:ws-1:..',
    'attachment:ws-1:.',
    'attachment:ws-1:a%2Fb',
    'attachment:ws-1:a%5Cb',
    'attachment:ws-1:a%00',
    'attachment:ws-1:%E0%A4%A',
    // Non-canonical escapes: one spelling per item.
    'attachment:ws%2D1:a.txt',
    'attachment:ws-1:%61.txt',
    'attachment:ws-1:#short',
    'attachment:ws-1:a:b',
    `attachment:ws-1:${'a'.repeat(600)}`,
  ])('refuses the malformed ID %p', (itemId) => {
    expect(decodeWorkspaceItemId(itemId)).toBeNull();
  });

  it('refuses names a key may not carry', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b'])
      expect(
        encodeWorkspaceItemId({
          kind: 'attachment',
          workspaceId: 'ws',
          worktreeId: null,
          name,
        }),
      ).toBeNull();
  });
});
