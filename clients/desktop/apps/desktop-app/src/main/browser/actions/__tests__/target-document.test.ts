import { dialogFromTargetDocument, sameDocumentUrl } from '../target-document';

const TARGET = {
  sessionId: '',
  frameId: 'child',
  loaderId: 'child-document',
  backendNodeId: 4,
};
const FRAME = {
  frameId: 'child',
  sessionId: '',
  loaderId: 'child-document',
  url: 'https://child.test/pay',
  parentId: 'main',
  frameRef: 'f-1',
};

describe("a dialog from a child-frame target's document", () => {
  it('comes from the same frame, still showing the same document', () => {
    expect(
      dialogFromTargetDocument(
        { frameId: 'child', url: 'https://child.test/pay#confirm' },
        TARGET,
        FRAME.url,
        FRAME,
      ),
    ).toBe(true);
  });

  it.each([
    ['another frame', { frameId: 'other', url: FRAME.url }, FRAME],
    ['no frame identity yet', { url: FRAME.url }, FRAME],
    [
      'another URL',
      { frameId: 'child', url: 'https://child.test/other' },
      FRAME,
    ],
    [
      'a replaced document',
      { frameId: 'child', url: FRAME.url },
      { ...FRAME, loaderId: 'next-document' },
    ],
    [
      'a navigated frame',
      { frameId: 'child', url: FRAME.url },
      { ...FRAME, url: 'https://child.test/next' },
    ],
    [
      'a frame in another session',
      { frameId: 'child', url: FRAME.url },
      { ...FRAME, sessionId: 'oopif' },
    ],
    ['a detached frame', { frameId: 'child', url: FRAME.url }, undefined],
  ] as const)('does not come from %s', (_case, dialog, current) => {
    expect(dialogFromTargetDocument(dialog, TARGET, FRAME.url, current)).toBe(
      false,
    );
  });

  it('compares document URLs without their fragments', () => {
    expect(sameDocumentUrl('https://a.test/x#1', 'https://a.test/x')).toBe(
      true,
    );
    expect(sameDocumentUrl('https://a.test/x?q', 'https://a.test/x')).toBe(
      false,
    );
  });
});
