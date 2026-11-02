import type { Descendant } from 'slate';
import type { CustomText, FileReferenceElement } from '@canopy/ui-rich/types';
import { draftHasContent } from '../chat-draft-content';

function paragraph(
  ...children: (CustomText | FileReferenceElement)[]
): Descendant {
  return {
    type: 'paragraph',
    children: children.length ? children : [{ text: '' }],
  };
}

const fileReference: FileReferenceElement = {
  type: 'file-reference',
  displayPath: 'src/a.ts',
  absolutePath: '/repo/src/a.ts',
  children: [{ text: '' }],
};

describe('draftHasContent', () => {
  it.each<[string, Descendant[]]>([
    ['an untouched empty paragraph', [paragraph()]],
    ['blank lines', [paragraph(), paragraph()]],
    [
      'whitespace-only text',
      [paragraph({ text: '  \t ' }), paragraph({ text: ' ' })],
    ],
    ['no nodes', []],
  ])('is false for %s', (_label, nodes) => {
    expect(draftHasContent(nodes)).toBe(false);
  });

  it.each<[string, Descendant[]]>([
    ['typed text', [paragraph({ text: 'hello' })]],
    ['text on a later line', [paragraph(), paragraph({ text: ' x ' })]],
    [
      'a file reference alone',
      [paragraph({ text: '' }, fileReference, { text: '' })],
    ],
  ])('is true for %s', (_label, nodes) => {
    expect(draftHasContent(nodes)).toBe(true);
  });
});
