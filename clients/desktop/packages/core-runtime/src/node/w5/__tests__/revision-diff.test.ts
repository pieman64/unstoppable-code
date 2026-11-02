import { diffW5Rows, equalW5Contents } from '../revision-diff';

describe('equalW5Contents', () => {
  it('compares parsed JSON and treats an absent previous file as changed', () => {
    expect(equalW5Contents(null, '{}')).toBe(false);
    expect(
      equalW5Contents('{"a":1,"b":[1,2]}', '{\n  "b": [1, 2],\n  "a": 1\n}'),
    ).toBe(true);
    expect(equalW5Contents('{"b":[1,2]}', '{"b":[2,1]}')).toBe(false);
    expect(equalW5Contents('{"a":1}', '{"a":"1"}')).toBe(false);
  });

  it('throws on malformed JSON', () => {
    expect(() => equalW5Contents('{', '{}')).toThrow(SyntaxError);
  });
});

describe('diffW5Rows', () => {
  it('reports membership order and per-row changes for lists', () => {
    expect(
      diffW5Rows(
        [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
          { id: 'c', name: 'c' },
        ],
        [
          { id: 'b', name: 'b' },
          { id: 'a', name: 'renamed' },
          { id: 'd', name: 'd' },
        ],
        false,
      ),
    ).toEqual({ collectionChanged: true, changedIds: ['a', 'c', 'd'] });
    expect(
      diffW5Rows([{ id: 'a', order: 1 }], [{ id: 'a', order: 2 }], false),
    ).toEqual({ collectionChanged: false, changedIds: ['a'] });
  });

  it('treats index order as collection state, not row content', () => {
    expect(
      diffW5Rows(
        [
          { id: 'a', order: 0, name: 'a' },
          { id: 'b', order: 1, name: 'b' },
        ],
        [
          { id: 'a', order: 1, name: 'a' },
          { id: 'b', order: 0, name: 'b' },
        ],
        true,
      ),
    ).toEqual({ collectionChanged: true, changedIds: [] });
    expect(
      diffW5Rows([{ id: 'a', order: 0 }], [{ id: 'a', order: 0, x: 1 }], true),
    ).toEqual({ collectionChanged: false, changedIds: ['a'] });
  });

  it('ignores non-object rows and non-arrays, keeping id-less rows in membership', () => {
    expect(diffW5Rows(undefined, { rows: [] }, false)).toEqual({
      collectionChanged: false,
      changedIds: [],
    });
    expect(diffW5Rows([1, null, 'x'], [], false)).toEqual({
      collectionChanged: false,
      changedIds: [],
    });
    expect(diffW5Rows([{ name: 'no id' }], [], false)).toEqual({
      collectionChanged: true,
      changedIds: [],
    });
    expect(
      diffW5Rows(
        [{ id: 'a', nested: { b: 1, c: 2 } }],
        [{ id: 'a', nested: { c: 2, b: 1 } }],
        false,
      ),
    ).toEqual({ collectionChanged: false, changedIds: [] });
  });
});
