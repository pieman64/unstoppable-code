// Browser Lab interaction case `editor` (CAN-1570).

const ENTRY_PATH = '/browser-lab/editor';
const SAVE_PATH = `${ENTRY_PATH}/submit`;

const PAGE_CONTROLS = [
  'browser-lab-editor-main',
  'browser-lab-header-home',
  'browser-lab-editor-plain',
  'browser-lab-editor-plain-status',
  'browser-lab-editor-model',
  'browser-lab-editor-leaf-0',
  'browser-lab-editor-leaf-1',
  'browser-lab-editor-leaf-2',
  'browser-lab-editor-leaf-3',
  'browser-lab-editor-model-status',
  'browser-lab-editor-save',
  'browser-lab-editor-saved',
];

export const interactionCase = {
  id: 'editor',
  kind: 'interaction',
  title: 'Rich text editor',
  entryPath: ENTRY_PATH,
  endpoints: [SAVE_PATH],
  pages: [{ path: ENTRY_PATH, controls: PAGE_CONTROLS }],
};

const STYLES = `
.editor-widget { margin-block: 20px; padding: 12px; border: 1px solid #c8cdd4; border-radius: 6px; }
[contenteditable='true'] { min-height: 56px; padding: 8px; border: 1px solid #7d8794; background: #fff; white-space: pre-wrap; }
[contenteditable='true']:focus { outline: 3px solid #9bbcf4; }
.leaf-start-editor p { margin: 0 0 8px; }
.leaf-start-editor [data-editor-leaf] { white-space: pre-wrap; }
output { display: block; min-height: 1.25em; margin-top: 4px; white-space: pre-wrap; }
`;

const SCRIPT = `(() => {
  'use strict';

  const byTestId = (id) =>
    Array.from(document.querySelectorAll('[data-testid]')).find(
      (element) => element.dataset.testid === 'browser-lab-editor-' + id,
    );
  const plainEditor = byTestId('plain');
  const plainStatus = byTestId('plain-status');
  const updatePlainStatus = () => {
    const value = plainEditor.textContent;
    plainStatus.dataset.browserLabValue = value;
    plainStatus.textContent = value;
  };
  plainEditor.addEventListener('input', updatePlainStatus);

  const editor = byTestId('model');
  const modelStatus = byTestId('model-status');
  let paragraphs = [
    [
      { id: 0, text: 'The browser ' },
      { id: 1, text: 'interaction model' },
    ],
    [
      { id: 2, text: 'keeps leaf ' },
      { id: 3, text: 'boundaries in view.' },
    ],
  ];
  let nextLeafId = 4;
  let droppedCount = 0;
  const droppedAtLeafStart = new Set();
  let rendering = false;

  const flattenModel = () => paragraphs
    .map((paragraph) => paragraph.map((leaf) => leaf.text).join(''))
    .join('\\n');
  const updateModelStatus = () => {
    const value = flattenModel();
    modelStatus.dataset.browserLabModel = value;
    modelStatus.dataset.browserLabDropped = String(droppedCount);
    modelStatus.textContent = value;
  };
  const paragraphOfLeaf = (leafId) => paragraphs.findIndex((paragraph) => paragraph.some((leaf) => leaf.id === leafId));
  const findLeaf = (leafId) => {
    const paragraphIndex = paragraphOfLeaf(leafId);
    if (paragraphIndex < 0) return null;
    const leaves = paragraphs[paragraphIndex];
    const leafIndex = leaves.findIndex((leaf) => leaf.id === leafId);
    return { paragraphIndex, leafIndex, leaf: leaves[leafIndex] };
  };
  const renderModel = (caret) => {
    rendering = true;
    editor.replaceChildren();
    const renderedLeaves = new Map();
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const paragraphNode = document.createElement('p');
      paragraph.forEach((leaf) => {
        const span = document.createElement('span');
        span.dataset.editorLeaf = '';
        span.dataset.leafId = String(leaf.id);
        span.textContent = leaf.text;
        if (leaf.id < 4) span.dataset.testid = 'browser-lab-editor-leaf-' + leaf.id;
        if (leaf.text === '') span.append(document.createTextNode(''));
        paragraphNode.append(span);
        renderedLeaves.set(leaf.id, { span, textNode: span.firstChild, paragraphIndex });
      });
      editor.append(paragraphNode);
    });
    if (caret) {
      const rendered = renderedLeaves.get(caret.leafId);
      if (rendered) {
        const selection = window.getSelection();
        const range = document.createRange();
        const anchor = rendered.textNode ?? rendered.span;
        range.setStart(anchor, Math.min(caret.offset, rendered.textNode?.textContent.length ?? 0));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    rendering = false;
    updateModelStatus();
  };
  const startOfModel = () => ({ paragraphIndex: 0, leafIndex: 0, leaf: paragraphs[0][0], offset: 0 });
  const leafPosition = (leafNode, offset) => {
    const located = findLeaf(Number(leafNode.dataset.leafId));
    return located ? { ...located, offset: Math.min(offset, located.leaf.text.length) } : null;
  };
  // Maps a DOM range boundary to a model position. Boundaries can sit in a
  // leaf's text node, on a leaf, on a paragraph, or on the editor itself.
  const positionFor = (node, offset) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const leafNode = node.parentElement?.closest('[data-editor-leaf]');
      return leafNode && editor.contains(leafNode) ? leafPosition(leafNode, offset) : null;
    }
    if (node.matches?.('[data-editor-leaf]')) return leafPosition(node, offset === 0 ? 0 : node.textContent.length);
    const leafNodes = node === editor || (node.tagName === 'P' && editor.contains(node))
      ? Array.from(node.querySelectorAll('[data-editor-leaf]'))
      : [];
    if (leafNodes.length === 0) return null;
    const boundary = Array.from(node.childNodes)[offset];
    const after = boundary ? leafNodes.find((leafNode) => boundary === leafNode || boundary.contains(leafNode)) : null;
    if (after) return leafPosition(after, 0);
    const last = leafNodes[leafNodes.length - 1];
    return leafPosition(last, last.textContent.length);
  };
  const resolveRange = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return { start: startOfModel(), end: null };
    const range = selection.getRangeAt(0);
    const start = positionFor(range.startContainer, range.startOffset) ?? startOfModel();
    if (range.collapsed) return { start, end: null };
    const end = positionFor(range.endContainer, range.endOffset);
    if (!end || (end.leaf.id === start.leaf.id && end.offset === start.offset)) return { start, end: null };
    return { start, end };
  };
  // Removes the text between two ordered model positions, joining paragraphs
  // when the span crosses them.
  const deleteSpan = (start, end) => {
    if (start.leaf.id === end.leaf.id) {
      start.leaf.text = start.leaf.text.slice(0, start.offset) + start.leaf.text.slice(end.offset);
      return;
    }
    start.leaf.text = start.leaf.text.slice(0, start.offset);
    end.leaf.text = end.leaf.text.slice(end.offset);
    const left = paragraphs[start.paragraphIndex].slice(0, start.leafIndex + 1);
    const right = paragraphs[end.paragraphIndex].slice(end.leafIndex);
    paragraphs.splice(start.paragraphIndex, end.paragraphIndex - start.paragraphIndex + 1, [...left, ...right]);
  };
  const syncModelFromDom = () => {
    const domParagraphs = Array.from(editor.querySelectorAll('p'));
    if (domParagraphs.length === 0) {
      const text = editor.textContent;
      paragraphs = text.split('\\n').map((line) => [{ id: nextLeafId++, text: line }]);
      if (paragraphs.length === 0) paragraphs = [[{ id: nextLeafId++, text: '' }]];
    } else {
      const byId = new Map(paragraphs.flat().map((leaf) => [leaf.id, leaf]));
      paragraphs = domParagraphs.map((paragraphNode) => {
        const spans = Array.from(paragraphNode.querySelectorAll('[data-editor-leaf]'));
        if (spans.length === 0) return [{ id: nextLeafId++, text: paragraphNode.textContent }];
        return spans.map((span) => {
          const id = Number(span.dataset.leafId);
          return { id, text: span.textContent, previous: byId.get(id) };
        }).map(({ id, text }) => ({ id, text }));
      });
    }
    if (editor.textContent === '') droppedAtLeafStart.clear();
    updateModelStatus();
  };

  editor.addEventListener('beforeinput', (event) => {
    if (!['insertText', 'deleteContentBackward', 'insertParagraph'].includes(event.inputType)) return;
    event.preventDefault();
    const { start, end } = resolveRange();
    if (!start.leaf) return;
    let caret = start;
    if (end) {
      deleteSpan(start, end);
      caret = { ...findLeaf(start.leaf.id), offset: start.offset };
      if (event.inputType === 'deleteContentBackward') {
        renderModel({ leafId: caret.leaf.id, offset: caret.offset });
        return;
      }
    }
    const current = caret.leaf;

    if (event.inputType === 'insertText') {
      const inputText = event.data ?? '';
      if (!inputText) return;
      let inserted = inputText;
      let droppedFirst = false;
      if (caret.offset === 0 && !droppedAtLeafStart.has(current.id)) {
        droppedAtLeafStart.add(current.id);
        droppedCount += 1;
        inserted = inputText.slice(1);
        droppedFirst = true;
      }
      if (inserted.length > 0) {
        current.text = current.text.slice(0, caret.offset) + inserted + current.text.slice(caret.offset);
        renderModel({ leafId: current.id, offset: caret.offset + inserted.length });
      } else {
        updateModelStatus();
      }
      if (droppedFirst) modelStatus.dataset.browserLabDropped = String(droppedCount);
      return;
    }

    if (event.inputType === 'deleteContentBackward') {
      if (caret.offset > 0) {
        current.text = current.text.slice(0, caret.offset - 1) + current.text.slice(caret.offset);
        renderModel({ leafId: current.id, offset: caret.offset - 1 });
        return;
      }
      const currentParagraph = paragraphs[caret.paragraphIndex];
      const previousLeaf = currentParagraph[caret.leafIndex - 1];
      if (previousLeaf && previousLeaf.text.length > 0) {
        previousLeaf.text = previousLeaf.text.slice(0, -1);
        renderModel({ leafId: previousLeaf.id, offset: previousLeaf.text.length });
        return;
      }
      if (caret.paragraphIndex > 0 && caret.leafIndex === 0) {
        const previousParagraph = paragraphs[caret.paragraphIndex - 1];
        const joinLeaf = previousParagraph[previousParagraph.length - 1];
        previousParagraph.push(...currentParagraph);
        paragraphs.splice(caret.paragraphIndex, 1);
        renderModel({ leafId: joinLeaf.id, offset: joinLeaf.text.length });
      }
      return;
    }

    const leftLeaves = paragraphs[caret.paragraphIndex].slice(0, caret.leafIndex + 1);
    const rightLeaves = paragraphs[caret.paragraphIndex].slice(caret.leafIndex + 1);
    const rightLeaf = { id: nextLeafId++, text: current.text.slice(caret.offset) };
    current.text = current.text.slice(0, caret.offset);
    paragraphs.splice(caret.paragraphIndex, 1, leftLeaves, [rightLeaf, ...rightLeaves]);
    renderModel({ leafId: rightLeaf.id, offset: 0 });
  });

  editor.addEventListener('input', () => {
    if (!rendering) syncModelFromDom();
  });

  // Save posts the leaf editor's model text; the server echoes what it got.
  const saved = byTestId('saved');
  byTestId('save').addEventListener('click', async () => {
    saved.dataset.browserLabState = 'saving';
    const response = await fetch('/browser-lab/editor/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ document: flattenModel() }),
    });
    const result = await response.json();
    const document = response.ok ? result.fields.find(([name]) => name === 'document') : null;
    saved.dataset.browserLabState = document ? 'saved' : 'error';
    saved.dataset.browserLabValue = document ? document[1] : '';
    saved.textContent = document ? 'Saved.' : 'Save failed.';
  });

  renderModel();
  updatePlainStatus();
})();`;

export function createRoutes(kit) {
  const { html } = kit;
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-editor-main">
        <h1>${interactionCase.title}</h1>
        <section class="editor-widget" aria-labelledby="plain-editor-heading">
          <h2 id="plain-editor-heading">Plain contenteditable</h2>
          <!-- prettier-ignore -->
          <div
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            data-testid="browser-lab-editor-plain"
          >Edit this plain text region.</div>
          <output
            data-browser-lab-value="Edit this plain text region."
            data-testid="browser-lab-editor-plain-status"
            >Edit this plain text region.</output
          >
        </section>
        <section class="editor-widget" aria-labelledby="model-editor-heading">
          <h2 id="model-editor-heading">
            Beforeinput editor with leaf boundaries
          </h2>
          <div
            class="leaf-start-editor"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            aria-label="Leaf-based editor"
            data-testid="browser-lab-editor-model"
          >
            <p>
              <span
                data-editor-leaf
                data-leaf-id="0"
                data-testid="browser-lab-editor-leaf-0"
                >The browser </span
              ><span
                data-editor-leaf
                data-leaf-id="1"
                data-testid="browser-lab-editor-leaf-1"
                >interaction model</span
              >
            </p>
            <p>
              <span
                data-editor-leaf
                data-leaf-id="2"
                data-testid="browser-lab-editor-leaf-2"
                >keeps leaf </span
              ><span
                data-editor-leaf
                data-leaf-id="3"
                data-testid="browser-lab-editor-leaf-3"
                >boundaries in view.</span
              >
            </p>
          </div>
          <output
            data-browser-lab-model="The browser interaction model&#10;keeps leaf boundaries in view."
            data-browser-lab-dropped="0"
            data-testid="browser-lab-editor-model-status"
            >The browser interaction model keeps leaf boundaries in
            view.</output
          >
          <button type="button" data-testid="browser-lab-editor-save">
            Save
          </button>
          <output
            data-browser-lab-state="idle"
            data-browser-lab-value=""
            data-testid="browser-lab-editor-saved"
            >Not saved.</output
          >
        </section>
      </main>`,
    });

  return [
    [ENTRY_PATH, kit.pageRoute(render)],
    [SAVE_PATH, kit.echoSubmitRoute(interactionCase, { format: 'json' })],
  ];
}
