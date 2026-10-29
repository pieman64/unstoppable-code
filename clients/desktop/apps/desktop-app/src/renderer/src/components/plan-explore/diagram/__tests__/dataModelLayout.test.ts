import type {
  DataModelChange,
  DataModelGraph,
} from '@canopy/desktop-shared/types/plan-diagrams';
import {
  buildDataModelChangeMaps,
  buildUnifiedDataModelGraph,
  computeDataModelLayout,
} from '../dataModelLayout';

function graph(
  entities: DataModelGraph['entities'],
  relationships: DataModelGraph['relationships'] = [],
): DataModelGraph {
  return { entities, relationships };
}

describe('buildDataModelChangeMaps', () => {
  it('scopes field changes to their owning entity even when field ids collide', () => {
    // Both `user` and `post` own a field whose id is `id`.
    const current = graph([
      { id: 'user', name: 'User', fields: [{ id: 'id', name: 'id' }] },
      { id: 'post', name: 'Post', fields: [{ id: 'id', name: 'id' }] },
    ]);
    const planned = graph([
      { id: 'user', name: 'User', fields: [{ id: 'id', name: 'id' }] },
      { id: 'post', name: 'Post', fields: [{ id: 'id', name: 'id' }] },
    ]);
    const changes: DataModelChange[] = [
      {
        target: 'field',
        id: 'c1',
        type: 'changed',
        entityId: 'user',
        fieldId: 'id',
      },
    ];

    const maps = buildDataModelChangeMaps(current, planned, changes);

    expect(maps.fieldChangeByEntity.get('user')?.get('id')).toBe('changed');
    // The shared `id` field id must NOT be highlighted on `post`.
    expect(maps.fieldChangeByEntity.get('post')).toBeUndefined();
  });

  it('ignores a field change missing its entityId (cannot be scoped)', () => {
    const current = graph([
      { id: 'user', name: 'User', fields: [{ id: 'id', name: 'id' }] },
    ]);
    const changes: Parameters<typeof buildDataModelChangeMaps>[2] = [
      // Deliberately malformed: no entityId.
      { target: 'field', id: 'c1', type: 'changed', fieldId: 'id' },
    ];

    const maps = buildDataModelChangeMaps(current, current, changes);

    expect(maps.fieldChangeByEntity.size).toBe(0);
  });

  it('derives removed entities, fields, and relationships from current-vs-planned', () => {
    const current = graph(
      [
        {
          id: 'user',
          name: 'User',
          fields: [
            { id: 'id', name: 'id' },
            { id: 'email', name: 'email' },
          ],
        },
        { id: 'legacy', name: 'Legacy', fields: [{ id: 'id', name: 'id' }] },
      ],
      [{ id: 'r1', from: 'user', to: 'legacy' }],
    );
    const planned = graph(
      [
        // `user` keeps only `id`; `email` was removed within this entity.
        { id: 'user', name: 'User', fields: [{ id: 'id', name: 'id' }] },
        // `legacy` entity removed entirely.
      ],
      [],
    );

    const maps = buildDataModelChangeMaps(current, planned, []);

    expect(maps.entityChangeById.get('legacy')).toBe('removed');
    expect(maps.fieldChangeByEntity.get('user')?.get('email')).toBe('removed');
    // `id` survived in `user`, so it is not flagged.
    expect(maps.fieldChangeByEntity.get('user')?.get('id')).toBeUndefined();
    expect(maps.relationshipChangeById.get('r1')).toBe('removed');
  });

  it('records explicit added/changed entity and relationship changes with notes', () => {
    const current = graph([], []);
    const planned = graph(
      [{ id: 'audit', name: 'Audit', fields: [] }],
      [{ id: 'r9', from: 'audit', to: 'audit' }],
    );
    const changes: DataModelChange[] = [
      {
        target: 'entity',
        id: 'e1',
        type: 'added',
        entityId: 'audit',
        note: 'new table',
      },
      {
        target: 'relationship',
        id: 'rel1',
        type: 'added',
        relationshipId: 'r9',
        note: 'self ref',
      },
    ];

    const maps = buildDataModelChangeMaps(current, planned, changes);

    expect(maps.entityChangeById.get('audit')).toBe('added');
    expect(maps.entityNoteById.get('audit')).toBe('new table');
    expect(maps.relationshipChangeById.get('r9')).toBe('added');
  });
});

describe('buildUnifiedDataModelGraph', () => {
  it('unions entities (planned winning) and retains removed entities and fields', () => {
    const current = graph(
      [
        {
          id: 'user',
          name: 'User (old)',
          fields: [
            { id: 'id', name: 'id' },
            { id: 'legacyFlag', name: 'legacyFlag' },
          ],
        },
        { id: 'gone', name: 'Gone', fields: [{ id: 'id', name: 'id' }] },
      ],
      [{ id: 'rOld', from: 'user', to: 'gone' }],
    );
    const planned = graph(
      [
        {
          id: 'user',
          name: 'User',
          fields: [
            { id: 'id', name: 'id' },
            { id: 'avatar', name: 'avatar' },
          ],
        },
        { id: 'session', name: 'Session', fields: [{ id: 'id', name: 'id' }] },
      ],
      [{ id: 'rNew', from: 'user', to: 'session' }],
    );

    const unified = buildUnifiedDataModelGraph(current, planned);

    const userEntity = unified.entities.find((e) => e.id === 'user');
    // Planned data wins for the shared entity.
    expect(userEntity?.name).toBe('User');
    const userFieldIds = userEntity?.fields.map((f) => f.id) ?? [];
    // Planned fields plus retained removed field `legacyFlag`.
    expect(userFieldIds).toContain('avatar');
    expect(userFieldIds).toContain('legacyFlag');
    expect(userFieldIds).toContain('id');

    const entityIds = unified.entities.map((e) => e.id).sort();
    expect(entityIds).toEqual(['gone', 'session', 'user']);

    const relationshipIds = unified.relationships.map((r) => r.id).sort();
    expect(relationshipIds).toEqual(['rNew', 'rOld']);
  });
});

describe('computeDataModelLayout', () => {
  it('returns empty arrays for an empty/absent graph', () => {
    expect(computeDataModelLayout(undefined)).toEqual({ nodes: [], edges: [] });
    expect(computeDataModelLayout(graph([]))).toEqual({ nodes: [], edges: [] });
  });

  it('positions one node per entity and drops edges to unknown entities', () => {
    const g = graph(
      [
        { id: 'a', name: 'A', fields: [{ id: 'id', name: 'id' }] },
        { id: 'b', name: 'B', fields: [] },
      ],
      [
        { id: 'r1', from: 'a', to: 'b' },
        { id: 'rGhost', from: 'a', to: 'missing' },
      ],
    );

    const { nodes, edges } = computeDataModelLayout(g);

    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(nodes.every((n) => n.type === 'dataModelEntity')).toBe(true);
    // The edge referencing the unknown `missing` entity is dropped.
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('r1');
    expect(edges[0].source).toBe('a');
    expect(edges[0].target).toBe('b');
  });

  it('folds entity-scoped field changes into the matching node only', () => {
    const current = graph([
      { id: 'user', name: 'User', fields: [{ id: 'id', name: 'id' }] },
      { id: 'post', name: 'Post', fields: [{ id: 'id', name: 'id' }] },
    ]);
    const planned = current;
    const changes: DataModelChange[] = [
      {
        target: 'field',
        id: 'c1',
        type: 'changed',
        entityId: 'user',
        fieldId: 'id',
      },
    ];
    const maps = buildDataModelChangeMaps(current, planned, changes);

    const { nodes } = computeDataModelLayout(
      buildUnifiedDataModelGraph(current, planned),
      maps,
    );

    const userNode = nodes.find((n) => n.id === 'user');
    const postNode = nodes.find((n) => n.id === 'post');
    expect(userNode?.data.fieldChanges).toEqual({ id: 'changed' });
    // The colliding `id` field id must not leak onto `post`.
    expect(postNode?.data.fieldChanges).toBeUndefined();
  });
});
