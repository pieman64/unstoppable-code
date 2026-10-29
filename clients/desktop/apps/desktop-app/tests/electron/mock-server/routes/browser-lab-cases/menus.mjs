// Browser Lab interaction case `menus` (CAN-1570).

const ENTRY_PATH = '/browser-lab/menus';

const PAGE_CONTROLS = [
  'browser-lab-menus-main',
  'browser-lab-header-home',
  'browser-lab-menus-pointer-trigger',
  'browser-lab-menus-pointer-menu',
  'browser-lab-menus-pointer-one',
  'browser-lab-menus-pointer-two',
  'browser-lab-menus-pointer-status',
  'browser-lab-menus-select-trigger',
  'browser-lab-menus-select-label',
  'browser-lab-menus-select-value',
  'browser-lab-menus-select-list',
  'browser-lab-menus-select-one',
  'browser-lab-menus-select-two',
  'browser-lab-menus-select-status',
  'browser-lab-menus-hover-trigger',
  'browser-lab-menus-hover-menu',
  'browser-lab-menus-hover-one',
  'browser-lab-menus-hover-two',
  'browser-lab-menus-hover-status',
  'browser-lab-menus-context-area',
  'browser-lab-menus-context-menu',
  'browser-lab-menus-context-one',
  'browser-lab-menus-context-two',
  'browser-lab-menus-context-status',
  'browser-lab-menus-edit-label',
  'browser-lab-menus-edit-input',
  'browser-lab-menus-edit-status',
];

export const interactionCase = {
  id: 'menus',
  kind: 'interaction',
  title: 'Menus',
  entryPath: ENTRY_PATH,
  pages: [{ path: ENTRY_PATH, controls: PAGE_CONTROLS }],
};

const STYLES = `
.interaction-widget { margin-block: 20px; padding: 12px; border: 1px solid #c8cdd4; border-radius: 6px; }
[role='menu'] { min-width: 160px; padding: 6px; background: #fff; border: 1px solid #8d96a3; box-shadow: 0 4px 12px #0002; }
[role='menu'] button, [role='listbox'] [role='option'] { display: block; width: 100%; margin: 0; text-align: left; }
[role='option'] { padding: 6px; cursor: pointer; }
#browser-lab-menus-hover-menu { width: max-content; }
#browser-lab-menus-context-menu { position: fixed; z-index: 5; }
#browser-lab-menus-edit-input[hidden] { display: none; }
`;

const SCRIPT = `(() => {
  'use strict';

  const byTestId = (id) =>
    Array.from(document.querySelectorAll('[data-testid]')).find(
      (element) => element.dataset.testid === 'browser-lab-menus-' + id,
    );
  const record = (output, selection, action) => {
    output.dataset.browserLabSelection = selection;
    output.dataset.browserLabLastAction = action;
    output.textContent = selection ? 'Selection: ' + selection + ' (' + action + ')' : action;
  };

  const pointerTrigger = byTestId('pointer-trigger');
  const pointerMenu = byTestId('pointer-menu');
  const pointerStatus = byTestId('pointer-status');
  const closePointer = () => {
    pointerMenu.hidden = true;
    pointerTrigger.setAttribute('aria-expanded', 'false');
    record(pointerStatus, pointerStatus.dataset.browserLabSelection, 'closed');
  };
  pointerTrigger.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerMenu.hidden = !pointerMenu.hidden;
    pointerTrigger.setAttribute('aria-expanded', String(!pointerMenu.hidden));
    record(pointerStatus, pointerStatus.dataset.browserLabSelection, pointerMenu.hidden ? 'closed' : 'opened-pointerdown');
  });
  pointerMenu.querySelectorAll('[role="menuitem"]').forEach((item) => {
    item.addEventListener('click', () => {
      record(pointerStatus, item.dataset.value, 'selected-click');
      closePointer();
      pointerStatus.dataset.browserLabSelection = item.dataset.value;
      pointerStatus.dataset.browserLabLastAction = 'selected-click';
      pointerStatus.textContent = 'Selection: ' + item.dataset.value + ' (selected-click)';
    });
  });

  const selectTrigger = byTestId('select-trigger');
  const selectList = byTestId('select-list');
  const selectValue = byTestId('select-value');
  const selectLabel = byTestId('select-label');
  const selectStatus = byTestId('select-status');
  selectTrigger.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    selectList.hidden = false;
    selectTrigger.setAttribute('aria-expanded', 'true');
    record(selectStatus, selectStatus.dataset.browserLabSelection, 'opened-mousedown');
  });
  selectList.querySelectorAll('[role="option"]').forEach((option) => {
    option.addEventListener('click', () => {
      selectValue.value = option.dataset.value;
      selectLabel.textContent = option.textContent;
      selectTrigger.setAttribute('aria-expanded', 'false');
      selectList.hidden = true;
      record(selectStatus, option.dataset.value, 'selected-click');
    });
  });

  const hoverTrigger = byTestId('hover-trigger');
  const hoverMenu = byTestId('hover-menu');
  const hoverStatus = byTestId('hover-status');
  let hoverTimer;
  const openHover = () => {
    clearTimeout(hoverTimer);
    hoverMenu.hidden = false;
    hoverTrigger.setAttribute('aria-expanded', 'true');
    record(hoverStatus, hoverStatus.dataset.browserLabSelection, 'opened-hover');
  };
  const scheduleHoverClose = () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverMenu.hidden = true;
      hoverTrigger.setAttribute('aria-expanded', 'false');
      record(hoverStatus, hoverStatus.dataset.browserLabSelection, 'closed-hover');
    }, 120);
  };
  hoverTrigger.addEventListener('mouseenter', openHover);
  hoverTrigger.addEventListener('mouseleave', scheduleHoverClose);
  hoverMenu.addEventListener('mouseenter', openHover);
  hoverMenu.addEventListener('mouseleave', scheduleHoverClose);
  hoverMenu.querySelectorAll('[role="menuitem"]').forEach((item) => {
    item.addEventListener('click', () => {
      const selection = item.dataset.value;
      hoverStatus.dataset.browserLabSelection = selection;
      hoverStatus.dataset.browserLabLastAction = 'selected-click';
      hoverStatus.textContent = 'Selection: ' + selection + ' (selected-click)';
      scheduleHoverClose();
    });
  });

  const contextArea = byTestId('context-area');
  const contextMenu = byTestId('context-menu');
  const contextStatus = byTestId('context-status');
  const closeContext = () => {
    contextMenu.hidden = true;
    record(contextStatus, contextStatus.dataset.browserLabSelection, 'closed');
  };
  contextArea.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    contextMenu.hidden = false;
    contextMenu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - 180)) + 'px';
    contextMenu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - 100)) + 'px';
    record(contextStatus, contextStatus.dataset.browserLabSelection, 'opened-contextmenu');
  });
  contextMenu.querySelectorAll('[role="menuitem"]').forEach((item) => {
    item.addEventListener('click', () => {
      const selection = item.dataset.value;
      contextStatus.dataset.browserLabSelection = selection;
      contextStatus.dataset.browserLabLastAction = 'selected-click';
      contextStatus.textContent = 'Selection: ' + selection + ' (selected-click)';
      closeContext();
      contextStatus.dataset.browserLabSelection = selection;
      contextStatus.dataset.browserLabLastAction = 'selected-click';
      contextStatus.textContent = 'Selection: ' + selection + ' (selected-click)';
    });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target) && !contextArea.contains(event.target)) closeContext();
  });

  const editLabel = byTestId('edit-label');
  const editInput = byTestId('edit-input');
  const editStatus = byTestId('edit-status');
  let committedValue = editStatus.dataset.browserLabValue;
  const finishEdit = (commit) => {
    if (commit) {
      committedValue = editInput.value;
      editLabel.textContent = committedValue;
      editStatus.dataset.browserLabValue = committedValue;
      record(editStatus, committedValue, 'committed-enter');
    } else {
      editInput.value = committedValue;
      record(editStatus, committedValue, 'cancelled-escape');
    }
    editInput.hidden = true;
    editLabel.hidden = false;
  };
  editLabel.addEventListener('dblclick', () => {
    editInput.value = committedValue;
    editLabel.hidden = true;
    editInput.hidden = false;
    editInput.focus();
    editInput.select();
    record(editStatus, committedValue, 'editing-dblclick');
  });
  editInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishEdit(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!pointerMenu.hidden) closePointer();
    if (!contextMenu.hidden) closeContext();
  });
})();`;

export function createRoutes(kit) {
  const { html } = kit;
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [SCRIPT],
      styles: STYLES,
      main: html`<main data-testid="browser-lab-menus-main">
        <h1>${interactionCase.title}</h1>

        <section class="interaction-widget" aria-labelledby="pointer-heading">
          <h2 id="pointer-heading">Pointer-down menu</h2>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded="false"
            data-testid="browser-lab-menus-pointer-trigger"
          >
            Open pointer menu
          </button>
          <div
            role="menu"
            aria-label="Pointer menu"
            hidden
            data-testid="browser-lab-menus-pointer-menu"
          >
            <button
              type="button"
              role="menuitem"
              data-value="pointer-one"
              data-testid="browser-lab-menus-pointer-one"
            >
              First item
            </button>
            <button
              type="button"
              role="menuitem"
              data-value="pointer-two"
              data-testid="browser-lab-menus-pointer-two"
            >
              Second item
            </button>
          </div>
          <output
            role="status"
            data-browser-lab-selection=""
            data-browser-lab-last-action="idle"
            data-testid="browser-lab-menus-pointer-status"
            >idle</output
          >
        </section>

        <section class="interaction-widget" aria-labelledby="select-heading">
          <h2 id="select-heading">Mouse-down select</h2>
          <div
            role="combobox"
            tabindex="0"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-controls="browser-lab-menus-select-list"
            data-testid="browser-lab-menus-select-trigger"
          >
            <span data-testid="browser-lab-menus-select-label"
              >Choose a color</span
            >
          </div>
          <input
            type="hidden"
            value=""
            data-testid="browser-lab-menus-select-value"
          />
          <div
            role="listbox"
            aria-label="Color"
            hidden
            data-testid="browser-lab-menus-select-list"
          >
            <div
              role="option"
              aria-selected="false"
              data-value="blue"
              data-testid="browser-lab-menus-select-one"
            >
              Blue
            </div>
            <div
              role="option"
              aria-selected="false"
              data-value="green"
              data-testid="browser-lab-menus-select-two"
            >
              Green
            </div>
          </div>
          <output
            role="status"
            data-browser-lab-selection=""
            data-browser-lab-last-action="idle"
            data-testid="browser-lab-menus-select-status"
            >idle</output
          >
        </section>

        <section class="interaction-widget" aria-labelledby="hover-heading">
          <h2 id="hover-heading">Hover-reveal menu</h2>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded="false"
            data-testid="browser-lab-menus-hover-trigger"
          >
            Hover for menu
          </button>
          <div
            role="menu"
            aria-label="Hover menu"
            hidden
            data-testid="browser-lab-menus-hover-menu"
          >
            <button
              type="button"
              role="menuitem"
              data-value="hover-one"
              data-testid="browser-lab-menus-hover-one"
            >
              Hover item one
            </button>
            <button
              type="button"
              role="menuitem"
              data-value="hover-two"
              data-testid="browser-lab-menus-hover-two"
            >
              Hover item two
            </button>
          </div>
          <output
            role="status"
            data-browser-lab-selection=""
            data-browser-lab-last-action="idle"
            data-testid="browser-lab-menus-hover-status"
            >idle</output
          >
        </section>

        <section class="interaction-widget" aria-labelledby="context-heading">
          <h2 id="context-heading">Context menu</h2>
          <div
            tabindex="0"
            role="region"
            aria-label="Right-click area"
            data-testid="browser-lab-menus-context-area"
          >
            Right-click in this area
          </div>
          <div
            role="menu"
            aria-label="Context actions"
            hidden
            data-testid="browser-lab-menus-context-menu"
          >
            <button
              type="button"
              role="menuitem"
              data-value="context-one"
              data-testid="browser-lab-menus-context-one"
            >
              Context action one
            </button>
            <button
              type="button"
              role="menuitem"
              data-value="context-two"
              data-testid="browser-lab-menus-context-two"
            >
              Context action two
            </button>
          </div>
          <output
            role="status"
            data-browser-lab-selection=""
            data-browser-lab-last-action="idle"
            data-testid="browser-lab-menus-context-status"
            >idle</output
          >
        </section>

        <section class="interaction-widget" aria-labelledby="edit-heading">
          <h2 id="edit-heading">Double-click to edit</h2>
          <span tabindex="0" data-testid="browser-lab-menus-edit-label"
            >Quarterly plan</span
          >
          <input
            type="text"
            value="Quarterly plan"
            hidden
            aria-label="Edit label"
            data-testid="browser-lab-menus-edit-input"
          />
          <output
            role="status"
            data-browser-lab-value="Quarterly plan"
            data-browser-lab-selection="Quarterly plan"
            data-browser-lab-last-action="idle"
            data-testid="browser-lab-menus-edit-status"
            >Quarterly plan</output
          >
        </section>
      </main>`,
    });
  return [[ENTRY_PATH, kit.pageRoute(render)]];
}
