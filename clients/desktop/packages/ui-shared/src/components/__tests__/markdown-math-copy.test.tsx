/** @jest-environment jsdom */
import {
  ensureMathCopyListener,
  MATH_CONTAINER_CLASS,
  MATH_SOURCE_ATTRIBUTE,
  selectionTextWithMathSource,
} from '../markdown-math-copy';

interface ClipboardDataMock {
  setData: jest.Mock<void, [string, string]>;
}

function makeClipboardData(): ClipboardDataMock {
  return { setData: jest.fn<void, [string, string]>() };
}

function getSelectionFor(doc: Document): Selection {
  const selection = doc.getSelection();
  if (!selection) {
    throw new Error('Expected the document to expose a selection');
  }
  return selection;
}

function makeFormula(
  doc: Document,
  source: string,
  renderedText = 'R ( 3 , 3 ) R(3,3)',
): HTMLSpanElement {
  const formula = doc.createElement('span');
  formula.className = MATH_CONTAINER_CLASS;
  formula.setAttribute(MATH_SOURCE_ATTRIBUTE, source);
  const katex = doc.createElement('span');
  katex.className = 'katex';
  const mathml = doc.createElement('span');
  mathml.className = 'katex-mathml';
  mathml.textContent = 'R(3,3)';
  const html = doc.createElement('span');
  html.className = 'katex-html';
  html.textContent = renderedText;
  katex.append(mathml, html);
  formula.append(katex);
  return formula;
}

function setSelectionToNodeContents(selection: Selection, node: Node): void {
  const range = node.ownerDocument?.createRange();
  if (!range) {
    throw new Error('Expected the selected node to belong to a document');
  }
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function createCopyEvent(
  doc: Document,
  clipboardData: ClipboardDataMock,
): Event {
  const eventOptions: EventInit = { bubbles: true, cancelable: true };
  const event = doc.defaultView
    ? new doc.defaultView.Event('copy', eventOptions)
    : new Event('copy', eventOptions);
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  return event;
}

function dispatchCopy(
  target: Element,
  clipboardData: ClipboardDataMock,
): Event {
  const event = createCopyEvent(target.ownerDocument, clipboardData);
  target.dispatchEvent(event);
  return event;
}

function makeDocumentWithSelection(): Document {
  const detachedDocument =
    document.implementation.createHTMLDocument('math copy');
  if (detachedDocument.getSelection()) {
    return detachedDocument;
  }

  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const iframeDocument = iframe.contentDocument;
  if (!iframeDocument?.getSelection()) {
    throw new Error('Expected an iframe document to expose a selection');
  }
  return iframeDocument;
}

beforeEach(() => {
  document.body.replaceChildren();
  getSelectionFor(document).removeAllRanges();
});

afterEach(() => {
  getSelectionFor(document).removeAllRanges();
  document.body.replaceChildren();
});

describe('selectionTextWithMathSource', () => {
  it('uses the source for a whole formula selection', () => {
    const formula = makeFormula(document, String.raw`\(R(3,3)\)`);
    document.body.append(formula);
    const selection = getSelectionFor(document);
    setSelectionToNodeContents(selection, formula);

    expect(selectionTextWithMathSource(selection)).toBe(String.raw`\(R(3,3)\)`);
  });

  it('expands a partial formula selection to the whole source', () => {
    const source = String.raw`\(R(3,3)\)`;
    const formula = makeFormula(document, source);
    document.body.append(formula);
    const textNode = formula.querySelector('.katex-html')?.firstChild;
    if (!textNode) throw new Error('Expected rendered KaTeX text');
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 8);
    const selection = getSelectionFor(document);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectionTextWithMathSource(selection)).toBe(source);
  });

  it('uses the whole source when the selection is entirely inside one formula', () => {
    const source = String.raw`\(R(3,3)\)`;
    const formula = makeFormula(document, source);
    document.body.append(formula);
    const textNode = formula.querySelector('.katex-html')?.firstChild;
    if (!textNode) throw new Error('Expected rendered KaTeX text');
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 5);
    const selection = getSelectionFor(document);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectionTextWithMathSource(selection)).toBe(source);
  });

  it('preserves surrounding text around a formula', () => {
    const paragraph = document.createElement('p');
    const formula = makeFormula(document, String.raw`\(R(3,3)\)`);
    paragraph.append(
      document.createTextNode('Ramsey '),
      formula,
      document.createTextNode(' is 6'),
    );
    document.body.append(paragraph);
    const selection = getSelectionFor(document);
    setSelectionToNodeContents(selection, paragraph);

    expect(selectionTextWithMathSource(selection)).toBe(
      String.raw`Ramsey \(R(3,3)\) is 6`,
    );
  });

  it('replaces two formulas in one selection', () => {
    const paragraph = document.createElement('p');
    paragraph.append(
      document.createTextNode('A '),
      makeFormula(document, String.raw`\(x^2\)`, 'x squared'),
      document.createTextNode(' plus '),
      makeFormula(document, String.raw`\(y^2\)`, 'y squared'),
      document.createTextNode(' equals z'),
    );
    document.body.append(paragraph);
    const selection = getSelectionFor(document);
    setSelectionToNodeContents(selection, paragraph);

    expect(selectionTextWithMathSource(selection)).toBe(
      String.raw`A \(x^2\) plus \(y^2\) equals z`,
    );
  });

  it('does not touch collapsed or empty selections', () => {
    const text = document.createTextNode('plain text');
    document.body.append(text);
    const selection = getSelectionFor(document);
    selection.setBaseAndExtent(text, 3, text, 3);
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    const focusNode = selection.focusNode;
    const focusOffset = selection.focusOffset;

    expect(selectionTextWithMathSource(selection)).toBe('');
    expect(selection.anchorNode).toBe(anchorNode);
    expect(selection.anchorOffset).toBe(anchorOffset);
    expect(selection.focusNode).toBe(focusNode);
    expect(selection.focusOffset).toBe(focusOffset);

    selection.removeAllRanges();
    expect(selectionTextWithMathSource(selection)).toBe('');
    expect(selection.rangeCount).toBe(0);
  });

  it('restores the same backward anchor and focus after source substitution', () => {
    const paragraph = document.createElement('p');
    const formula = makeFormula(document, String.raw`\(x\)`, 'x');
    paragraph.append(
      document.createTextNode('before '),
      formula,
      document.createTextNode(' after'),
    );
    document.body.append(paragraph);
    const selection = getSelectionFor(document);
    const startNode = paragraph.firstChild;
    const endNode = paragraph.lastChild;
    if (!startNode || !endNode) throw new Error('Expected paragraph text');
    selection.setBaseAndExtent(endNode, 6, startNode, 0);
    const originalAnchorNode = selection.anchorNode;
    const originalAnchorOffset = selection.anchorOffset;
    const originalFocusNode = selection.focusNode;
    const originalFocusOffset = selection.focusOffset;

    expect(selectionTextWithMathSource(selection)).toBe(
      String.raw`before \(x\) after`,
    );
    expect(selection.anchorNode).toBe(originalAnchorNode);
    expect(selection.anchorOffset).toBe(originalAnchorOffset);
    expect(selection.focusNode).toBe(originalFocusNode);
    expect(selection.focusOffset).toBe(originalFocusOffset);
  });
});

describe('ensureMathCopyListener', () => {
  it('leaves a copy event alone when no formula is selected', () => {
    const text = document.createTextNode('plain text');
    document.body.append(text);
    const selection = getSelectionFor(document);
    setSelectionToNodeContents(selection, text);
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    const focusNode = selection.focusNode;
    const focusOffset = selection.focusOffset;
    ensureMathCopyListener(document);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(
      text.parentElement ?? document.body,
      clipboardData,
    );

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
    expect(selection.anchorNode).toBe(anchorNode);
    expect(selection.anchorOffset).toBe(anchorOffset);
    expect(selection.focusNode).toBe(focusNode);
    expect(selection.focusOffset).toBe(focusOffset);
  });

  it('copies source-substituted plain text and escaped HTML without KaTeX markup', () => {
    const source = String.raw`\(x < y\)`;
    const paragraph = document.createElement('p');
    const formula = makeFormula(document, source, 'x is less than y');
    paragraph.append(document.createTextNode('compare '), formula);
    document.body.append(paragraph);
    const selection = getSelectionFor(document);
    setSelectionToNodeContents(selection, paragraph);
    ensureMathCopyListener(document);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(formula, clipboardData);

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/plain',
      String.raw`compare \(x < y\)`,
    );
    const htmlData = clipboardData.setData.mock.calls.find(
      ([mimeType]) => mimeType === 'text/html',
    )?.[1];
    expect(htmlData).toContain(String.raw`\(x &lt; y\)`);
    expect(htmlData).not.toContain('katex');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not override a copy event that was already prevented', () => {
    const formula = makeFormula(document, String.raw`\(x\)`, 'x');
    document.body.append(formula);
    setSelectionToNodeContents(getSelectionFor(document), formula);
    ensureMathCopyListener(document);
    const clipboardData = makeClipboardData();
    const preventEarlier = (event: Event): void => event.preventDefault();
    document.addEventListener('copy', preventEarlier, true);

    try {
      const event = dispatchCopy(formula, clipboardData);
      expect(event.defaultPrevented).toBe(true);
      expect(clipboardData.setData).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('copy', preventEarlier, true);
    }
  });

  it('does not replace copy while a textarea is focused', () => {
    const formula = makeFormula(document, String.raw`\(x\)`, 'x');
    const textarea = document.createElement('textarea');
    document.body.append(formula, textarea);
    textarea.focus();
    setSelectionToNodeContents(getSelectionFor(document), formula);
    ensureMathCopyListener(document);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(formula, clipboardData);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });

  it('does not replace copy while a contenteditable element is focused', () => {
    const formula = makeFormula(document, String.raw`\(x\)`, 'x');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 0;
    document.body.append(formula, editor);
    editor.focus();
    setSelectionToNodeContents(getSelectionFor(document), formula);
    ensureMathCopyListener(document);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(formula, clipboardData);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });

  it('installs only one listener when called more than once for a document', () => {
    const doc = makeDocumentWithSelection();
    const formula = makeFormula(doc, String.raw`\(x\)`, 'x');
    doc.body.append(formula);
    setSelectionToNodeContents(getSelectionFor(doc), formula);
    ensureMathCopyListener(doc);
    ensureMathCopyListener(doc);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(formula, clipboardData);

    expect(event.defaultPrevented).toBe(true);
    expect(
      clipboardData.setData.mock.calls.filter(
        ([mimeType]) => mimeType === 'text/plain',
      ),
    ).toHaveLength(1);
    expect(
      clipboardData.setData.mock.calls.filter(
        ([mimeType]) => mimeType === 'text/html',
      ),
    ).toHaveLength(1);
  });

  it('installs and uses a listener in a second document', () => {
    const doc = makeDocumentWithSelection();
    const source = String.raw`\(y\)`;
    const formula = makeFormula(doc, source, 'y');
    doc.body.append(formula);
    setSelectionToNodeContents(getSelectionFor(doc), formula);
    ensureMathCopyListener(doc);
    const clipboardData = makeClipboardData();

    const event = dispatchCopy(formula, clipboardData);

    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', source);
    expect(event.defaultPrevented).toBe(true);
  });
});
