import {
  nestFlattenedDocument,
  PIERCED_DOCUMENT_DEPTH,
  requestPiercedDocument,
} from '../pierced-document';

/**
 * Deep documents (about 100 DOM levels in Electron 42) make a nested
 * `DOM.getDocument` fail and detach the debugger, so the page model came back
 * empty. Shapes follow Chromium: a node at the depth limit has
 * `childNodeCount` but no `children`, and the flattened list keeps shadow
 * roots and frame documents nested in their host.
 */
describe('requestPiercedDocument', () => {
  const shallow = {
    root: {
      nodeId: 1,
      nodeType: 9,
      childNodeCount: 1,
      children: [{ nodeId: 2, nodeType: 1, childNodeCount: 0, children: [] }],
    },
  };

  it('asks for a bounded nested document and keeps it when nothing was cut off', async () => {
    const send = jest.fn().mockResolvedValue(shallow);

    await expect(requestPiercedDocument(send)).resolves.toBe(shallow);
    expect(send.mock.calls).toEqual([
      ['DOM.getDocument', { depth: PIERCED_DOCUMENT_DEPTH, pierce: true }],
    ]);
  });

  it('reads a document deeper than the bound flat and nests it again', async () => {
    const truncated = {
      root: {
        nodeId: 1,
        nodeType: 9,
        childNodeCount: 1,
        children: [{ nodeId: 2, nodeType: 1, childNodeCount: 3 }],
      },
    };
    const flat = {
      nodes: [
        { nodeId: 1, nodeType: 9, children: [] },
        { nodeId: 2, parentId: 1, nodeType: 1, children: [] },
        {
          nodeId: 3,
          parentId: 2,
          nodeName: 'IFRAME',
          nodeType: 1,
          children: [],
          contentDocument: { nodeId: 4, nodeType: 9, children: [] },
        },
        { nodeId: 5, parentId: 4, nodeName: 'HTML', nodeType: 1, children: [] },
        {
          nodeId: 6,
          parentId: 2,
          nodeName: 'SECTION',
          nodeType: 1,
          children: [],
          shadowRoots: [
            { nodeId: 7, nodeType: 11, shadowRootType: 'open', children: [] },
          ],
        },
        { nodeId: 8, parentId: 7, nodeName: 'I', nodeType: 1, children: [] },
        { nodeId: 9, parentId: 2, nodeName: '#text', nodeType: 3 },
      ],
    };
    const send = jest
      .fn()
      .mockResolvedValueOnce(truncated)
      .mockResolvedValueOnce(flat);

    const result = await requestPiercedDocument(send);

    expect(send.mock.calls[1]).toEqual([
      'DOM.getFlattenedDocument',
      { depth: -1, pierce: true },
    ]);
    expect(result).toMatchObject({
      root: {
        nodeId: 1,
        children: [
          {
            nodeId: 2,
            children: [
              {
                nodeId: 3,
                contentDocument: { nodeId: 4, children: [{ nodeId: 5 }] },
              },
              {
                nodeId: 6,
                children: [],
                shadowRoots: [{ nodeId: 7, children: [{ nodeId: 8 }] }],
              },
              { nodeId: 9 },
            ],
          },
        ],
      },
    });
  });

  it('rejects a flattened document whose parents do not resolve', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        root: { nodeId: 1, nodeType: 9, childNodeCount: 1 },
      })
      .mockResolvedValueOnce({
        nodes: [
          { nodeId: 1, nodeType: 9 },
          { nodeId: 2, parentId: 99, nodeType: 1 },
        ],
      });

    await expect(requestPiercedDocument(send)).rejects.toThrow(
      'Malformed flattened document.',
    );
  });

  it('rejects a flattened list with two roots', () => {
    expect(
      nestFlattenedDocument({ nodes: [{ nodeId: 1 }, { nodeId: 2 }] }),
    ).toBeUndefined();
  });
});
