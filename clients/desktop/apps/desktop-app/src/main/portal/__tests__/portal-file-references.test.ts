import { PortalFileReferenceRegistry } from '../portal-file-references';

describe('scoped Portal file references', () => {
  const scope = {
    sessionId: 'session',
    projectId: 'workspace',
    worktreeId: 'worktree',
  };
  const file = {
    absolutePath: '/private/repo/notes.md',
    displayPath: 'notes.md',
    repoName: 'repo',
  };

  it('projects opaque references without nested host paths and resolves only within their owner scope', () => {
    const registry = new PortalFileReferenceRegistry();
    const wire = registry.mint(scope, file);
    expect(JSON.stringify(wire)).not.toContain('/private');
    expect(wire).not.toHaveProperty('absolutePath');
    expect(registry.resolve(scope, wire)).toEqual(file);
    for (const wrong of [
      { ...scope, sessionId: 'other' },
      { ...scope, projectId: 'other' },
      { ...scope, worktreeId: 'other' },
    ])
      expect(() => registry.resolve(wrong, wire)).toThrow('authorized');
    expect(() =>
      registry.resolve(scope, { ...wire, referenceId: 'unknown' }),
    ).toThrow('authorized');
    registry.clearSession(scope.sessionId);
    expect(() => registry.resolve(scope, wire)).toThrow('authorized');
  });

  it('expires references, bounds capacity, reuses an active reference and denies revoked callers', () => {
    let now = 0;
    const registry = new PortalFileReferenceRegistry({
      now: (): number => now,
      capacity: 2,
      ttlMs: 10,
    });
    const first = registry.mint(scope, file);
    expect(registry.mint(scope, file).referenceId).toBe(first.referenceId);
    registry.mint(scope, { ...file, absolutePath: '/private/second' });
    registry.mint(scope, { ...file, absolutePath: '/private/third' });
    expect(() => registry.resolve(scope, first)).toThrow('authorized');
    const last = registry.mint(scope, file);
    now = 11;
    expect(() => registry.resolve(scope, last)).toThrow('authorized');
    const live = registry.mint(scope, file);
    expect(() =>
      registry.resolve({ ...scope, canRead: () => false }, live),
    ).toThrow('authorized');
    expect(() => registry.resolve(scope, live)).toThrow('authorized');
    expect(() => registry.mint({ ...scope, sessionId: '' }, file)).toThrow(
      'authorized',
    );
    registry.clear();
  });
});
