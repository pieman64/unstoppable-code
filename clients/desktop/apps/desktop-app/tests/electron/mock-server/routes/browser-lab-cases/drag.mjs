// Browser Lab interaction case `drag` (CAN-1570): a pointer-event sortable
// list, an HTML5 drag-and-drop board, range sliders, and a file drop zone.

const ENTRY_PATH = '/browser-lab/drag';

const DRAG_STYLES = `
.drag-sort-list { max-width: 440px; padding: 8px 8px 8px 38px; }
.drag-sort-item { margin: 8px 0; padding: 10px; border: 1px solid #52677d; background: #fff; cursor: grab; touch-action: none; }
.drag-sort-item[data-browser-lab-dragging="true"] { opacity: 0.55; cursor: grabbing; }
.drag-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.drag-board-column { min-height: 200px; padding: 8px; border: 1px solid #52677d; background: #eef1f4; }
.drag-board-column h3 { margin-top: 4px; }
.drag-board-cards { min-height: 120px; padding: 4px; }
.drag-board-card { margin: 8px 0; padding: 10px; border: 1px solid #52677d; background: #fff; cursor: grab; }
.drag-custom-slider { position: relative; width: min(100%, 420px); height: 32px; margin-top: 16px; touch-action: none; }
.drag-custom-slider::before { content: ''; position: absolute; top: 14px; right: 0; left: 0; height: 4px; background: #aab4c0; }
.drag-custom-thumb { position: absolute; top: 7px; width: 18px; height: 18px; border-radius: 50%; background: #20364f; transform: translateX(-50%); }
.drag-drop-zone { min-height: 120px; display: grid; place-items: center; border: 2px dashed #52677d; background: #fff; }
.drag-drop-zone[data-browser-lab-drag-state="over"] { border-color: #a5541b; background: #fff4e9; }
`;

const DRAG_SCRIPT = `(() => {
  'use strict';
  const sortable = document.getElementById('sortable-list');
  const sortableStatus = document.getElementById('sortable-status');
  const syncSortableOrder = () => {
    const order = Array.from(sortable.querySelectorAll('[data-sort-item]'))
      .map((item) => item.dataset.sortItem);
    const value = order.join(',');
    sortable.dataset.browserLabOrder = value;
    sortableStatus.dataset.browserLabOrder = value;
    sortableStatus.textContent = value;
  };
  let activeSortItem = null;
  let activePointerId = null;
  sortable.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('[data-sort-item]');
    if (!item || event.button !== 0) return;
    activeSortItem = item;
    activePointerId = event.pointerId;
    item.dataset.browserLabDragging = 'true';
    sortableStatus.dataset.browserLabState = 'dragging';
    if (typeof item.setPointerCapture === 'function') item.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener('pointermove', (event) => {
    if (!activeSortItem || event.pointerId !== activePointerId) return;
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const target = over && over.closest('[data-sort-item]');
    if (!target || target === activeSortItem || !sortable.contains(target)) return;
    const bounds = target.getBoundingClientRect();
    const placeAfter = event.clientY > bounds.top + bounds.height / 2;
    if (placeAfter && target.nextElementSibling === activeSortItem) return;
    if (!placeAfter && target.previousElementSibling === activeSortItem) return;
    if (placeAfter) target.after(activeSortItem);
    else target.before(activeSortItem);
    syncSortableOrder();
  });
  const finishSort = (event) => {
    if (!activeSortItem || (event && event.pointerId !== activePointerId)) return;
    const item = activeSortItem;
    const pointerId = activePointerId;
    activeSortItem = null;
    activePointerId = null;
    delete item.dataset.browserLabDragging;
    if (typeof item.hasPointerCapture === 'function' && item.hasPointerCapture(pointerId)) {
      item.releasePointerCapture(pointerId);
    }
    sortableStatus.dataset.browserLabState = 'idle';
    syncSortableOrder();
  };
  document.addEventListener('pointerup', finishSort);
  document.addEventListener('pointercancel', finishSort);
  syncSortableOrder();

  const board = document.getElementById('drag-board');
  const boardStatus = document.getElementById('board-status');
  let draggedCardId = '';
  const syncBoard = () => {
    const parts = Array.from(board.querySelectorAll('[data-board-column]')).map((column) => {
      const ids = Array.from(column.querySelectorAll('[data-board-card]'))
        .map((card) => card.dataset.boardCard);
      return column.dataset.boardColumn + ':' + ids.join(',');
    });
    const value = parts.join('|');
    board.dataset.browserLabBoard = value;
    boardStatus.dataset.browserLabBoard = value;
    boardStatus.textContent = value;
  };
  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-board-card]');
    if (!card || !event.dataTransfer) return;
    draggedCardId = card.dataset.boardCard;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedCardId);
    card.dataset.browserLabDragging = 'true';
  });
  board.addEventListener('dragend', (event) => {
    const card = event.target.closest('[data-board-card]');
    if (card) delete card.dataset.browserLabDragging;
    draggedCardId = '';
    syncBoard();
  });
  for (const column of board.querySelectorAll('[data-board-column]')) {
    column.addEventListener('dragover', (event) => event.preventDefault());
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      const id = event.dataTransfer && event.dataTransfer.getData('text/plain') || draggedCardId;
      const card = board.querySelector('[data-board-card="' + id + '"]');
      if (!card) return;
      column.querySelector('[data-board-cards]').appendChild(card);
      draggedCardId = '';
      syncBoard();
    });
  }
  syncBoard();

  const customSlider = document.getElementById('custom-slider');
  const customThumb = document.getElementById('custom-thumb');
  const rangeStatus = document.getElementById('range-status');
  let customValue = 25;
  let sliderPointerId = null;
  const updateCustomValue = (nextValue) => {
    customValue = Math.max(0, Math.min(100, Math.round(nextValue)));
    customSlider.setAttribute('aria-valuenow', String(customValue));
    customThumb.style.left = String(customValue) + '%';
    rangeStatus.dataset.browserLabCustomRangeValue = String(customValue);
    rangeStatus.textContent = 'Custom: ' + String(customValue) + '; native: ' + rangeStatus.dataset.browserLabNativeRangeValue;
  };
  const updateFromPointer = (event) => {
    const bounds = customSlider.getBoundingClientRect();
    if (bounds.width <= 0) return;
    updateCustomValue(((event.clientX - bounds.left) / bounds.width) * 100);
  };
  customSlider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    sliderPointerId = event.pointerId;
    if (typeof customSlider.setPointerCapture === 'function') customSlider.setPointerCapture(event.pointerId);
    updateFromPointer(event);
    event.preventDefault();
  });
  customSlider.addEventListener('pointermove', (event) => {
    if (sliderPointerId === event.pointerId) updateFromPointer(event);
  });
  const finishSlider = (event) => {
    if (sliderPointerId === null || event.pointerId !== sliderPointerId) return;
    const pointerId = sliderPointerId;
    sliderPointerId = null;
    if (typeof customSlider.hasPointerCapture === 'function' && customSlider.hasPointerCapture(pointerId)) {
      customSlider.releasePointerCapture(pointerId);
    }
  };
  customSlider.addEventListener('pointerup', finishSlider);
  customSlider.addEventListener('pointercancel', finishSlider);
  customSlider.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') updateCustomValue(customValue + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') updateCustomValue(customValue - 1);
    else return;
    event.preventDefault();
  });
  const nativeRange = document.getElementById('native-range');
  nativeRange.addEventListener('input', () => {
    rangeStatus.dataset.browserLabNativeRangeValue = nativeRange.value;
    rangeStatus.textContent = 'Custom: ' + String(customValue) + '; native: ' + nativeRange.value;
  });
  updateCustomValue(customValue);

  const dropZone = document.getElementById('file-drop-zone');
  const dropStatus = document.getElementById('file-drop-status');
  let dragDepth = 0;
  const setFileDragState = (state) => {
    dropZone.dataset.browserLabDragState = state;
    dropStatus.dataset.browserLabDragState = state;
  };
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    setFileDragState('over');
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setFileDragState('idle');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    setFileDragState('dropped');
    const files = Array.from(event.dataTransfer && event.dataTransfer.files || [])
      .map((file) => ({ name: file.name, size: file.size, type: file.type }));
    const value = JSON.stringify(files);
    dropStatus.dataset.browserLabDroppedFiles = value;
    dropStatus.dataset.browserLabFileCount = String(files.length);
    dropStatus.textContent = value;
  });
})();`;

export const interactionCase = {
  id: 'drag',
  kind: 'interaction',
  title: 'Drag and drop',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-drag-main',
        'browser-lab-drag-sortable-list',
        'browser-lab-drag-sortable-status',
        'browser-lab-drag-sort-item-a',
        'browser-lab-drag-sort-item-b',
        'browser-lab-drag-sort-item-c',
        'browser-lab-drag-sort-item-d',
        'browser-lab-drag-sort-item-e',
        'browser-lab-drag-board',
        'browser-lab-drag-board-status',
        'browser-lab-drag-board-todo',
        'browser-lab-drag-board-doing',
        'browser-lab-drag-board-done',
        'browser-lab-drag-card-a',
        'browser-lab-drag-card-b',
        'browser-lab-drag-card-c',
        'browser-lab-drag-card-d',
        'browser-lab-drag-card-e',
        'browser-lab-drag-custom-slider',
        'browser-lab-drag-custom-thumb',
        'browser-lab-drag-native-range',
        'browser-lab-drag-range-status',
        'browser-lab-drag-file-drop-zone',
        'browser-lab-drag-file-drop-status',
      ],
    },
  ],
};

export function createRoutes(kit) {
  const { html } = kit;
  const sortableItems = [
    ['a', 'Sortable item A'],
    ['b', 'Sortable item B'],
    ['c', 'Sortable item C'],
    ['d', 'Sortable item D'],
    ['e', 'Sortable item E'],
  ];
  const boardColumns = [
    {
      id: 'todo',
      title: 'To do',
      cards: [
        ['a', 'Card A'],
        ['b', 'Card B'],
      ],
    },
    { id: 'doing', title: 'Doing', cards: [['c', 'Card C']] },
    {
      id: 'done',
      title: 'Done',
      cards: [
        ['d', 'Card D'],
        ['e', 'Card E'],
      ],
    },
  ];
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [DRAG_SCRIPT],
      styles: DRAG_STYLES,
      main: html`<main data-testid="browser-lab-drag-main">
        <h1>${interactionCase.title}</h1>

        <section aria-labelledby="sortable-title">
          <h2 id="sortable-title">Pointer-sortable list</h2>
          <p>
            Drag a row to reorder it. This list uses pointer events, not HTML
            drag-and-drop.
          </p>
          <ol
            id="sortable-list"
            class="drag-sort-list"
            data-testid="browser-lab-drag-sortable-list"
            data-browser-lab-order="a,b,c,d,e"
          >
            ${sortableItems.map(
              ([id, label]) =>
                html`<li
                  class="drag-sort-item"
                  data-sort-item="${id}"
                  data-testid="browser-lab-drag-sort-item-${id}"
                  tabindex="0"
                >
                  ${label}
                </li>`,
            )}
          </ol>
          <output
            id="sortable-status"
            data-testid="browser-lab-drag-sortable-status"
            data-browser-lab-state="idle"
            data-browser-lab-order="a,b,c,d,e"
            >a,b,c,d,e</output
          >
        </section>

        <section aria-labelledby="board-title">
          <h2 id="board-title">HTML5 drag-and-drop board</h2>
          <output
            id="board-status"
            data-testid="browser-lab-drag-board-status"
            data-browser-lab-board="todo:a,b|doing:c|done:d,e"
            >todo:a,b|doing:c|done:d,e</output
          >
          <div
            id="drag-board"
            class="drag-board"
            data-testid="browser-lab-drag-board"
            data-browser-lab-board="todo:a,b|doing:c|done:d,e"
          >
            ${boardColumns.map(
              (column) =>
                html`<section
                  class="drag-board-column"
                  data-board-column="${column.id}"
                  data-testid="browser-lab-drag-board-${column.id}"
                >
                  <h3>${column.title}</h3>
                  <div class="drag-board-cards" data-board-cards>
                    ${column.cards.map(
                      ([id, label]) =>
                        html`<div
                          class="drag-board-card"
                          draggable="true"
                          data-board-card="${id}"
                          data-testid="browser-lab-drag-card-${id}"
                        >
                          ${label}
                        </div>`,
                    )}
                  </div>
                </section>`,
            )}
          </div>
        </section>

        <section aria-labelledby="range-title">
          <h2 id="range-title">Range sliders</h2>
          <div
            id="custom-slider"
            class="drag-custom-slider"
            role="slider"
            tabindex="0"
            aria-label="Custom range"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="25"
            data-testid="browser-lab-drag-custom-slider"
          >
            <span
              id="custom-thumb"
              class="drag-custom-thumb"
              data-testid="browser-lab-drag-custom-thumb"
            ></span>
          </div>
          <label for="native-range">Native range</label>
          <input
            id="native-range"
            type="range"
            min="0"
            max="100"
            step="1"
            value="50"
            data-testid="browser-lab-drag-native-range"
          />
          <output
            id="range-status"
            data-testid="browser-lab-drag-range-status"
            data-browser-lab-custom-range-value="25"
            data-browser-lab-native-range-value="50"
            >Custom: 25; native: 50</output
          >
        </section>

        <section aria-labelledby="file-drop-title">
          <h2 id="file-drop-title">File drop zone (no upload)</h2>
          <div
            id="file-drop-zone"
            class="drag-drop-zone"
            role="region"
            aria-label="Drop files here"
            tabindex="0"
            data-browser-lab-drag-state="idle"
            data-testid="browser-lab-drag-file-drop-zone"
          >
            Drop files here
          </div>
          <output
            id="file-drop-status"
            data-testid="browser-lab-drag-file-drop-status"
            data-browser-lab-drag-state="idle"
            data-browser-lab-dropped-files="[]"
            data-browser-lab-file-count="0"
            >No files dropped.</output
          >
        </section>
      </main>`,
    });
  return [[ENTRY_PATH, kit.pageRoute(render)]];
}
