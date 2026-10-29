/** @jest-environment jsdom */
import { findTextRange } from '../dom-text-range';

describe('findTextRange', () => {
  it('anchors authored text instead of generated Markdown text', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<span data-markdown-generated>Repeated label</span><p>Repeated label</p>';

    const range = findTextRange(container, 'Repeated label');

    expect(range).not.toBeNull();
    expect(range?.startContainer.parentElement?.tagName).toBe('P');
  });

  it("resolves a range in a popped-out window's document", () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    if (!frameDocument) {
      throw new Error('Expected an iframe document');
    }
    const container = frameDocument.createElement('div');
    container.innerHTML = '<p>Build the <strong>parser</strong> first</p>';
    frameDocument.body.appendChild(container);

    const range = findTextRange(container, 'the parser');

    expect(range?.toString()).toBe('the parser');
    expect(range?.startContainer.ownerDocument).toBe(frameDocument);
    frame.remove();
  });
});
