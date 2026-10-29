// Browser Lab interaction case `scroll` (CAN-1570): a long page, a nested scroll
// container, a virtualized list, infinite scroll, a sticky header covering a
// target, and an off-screen button.

const ENTRY_PATH = '/browser-lab/scroll';

const SCROLL_STYLES = `
.scroll-main { max-width: 960px; }
.scroll-sticky-header {
  position: sticky;
  top: 0;
  z-index: 1000;
  min-height: 64px;
  box-sizing: border-box;
  padding: 20px;
  background: #20364f;
  color: #fff;
}
.scroll-sticky-target { margin-top: 0; }
.scroll-nested-outer {
  width: min(100%, 600px);
  height: 280px;
  overflow: auto;
  border: 2px solid #52677d;
  padding: 12px;
}
.scroll-nested-outer-content { min-height: 520px; }
.scroll-nested-inner {
  width: min(100%, 440px);
  height: 180px;
  overflow: auto;
  border: 2px solid #a5541b;
  padding: 8px;
}
.scroll-nested-inner-content { min-height: 900px; position: relative; }
.scroll-nested-target { position: absolute; bottom: 8px; left: 8px; }
.scroll-virtual-viewport {
  position: relative;
  height: 280px;
  overflow: auto;
  border: 1px solid #52677d;
  background: #fff;
}
.scroll-virtual-spacer { position: relative; width: 100%; }
.scroll-virtual-window { position: absolute; inset: 0 0 auto; }
.scroll-virtual-row {
  height: 32px;
  box-sizing: border-box;
  padding: 4px 8px;
  border-bottom: 1px solid #d8dce1;
}
.scroll-virtual-row button { margin: 0 0 0 12px; padding: 2px 8px; }
.scroll-infinite-viewport {
  height: 280px;
  overflow: auto;
  border: 1px solid #52677d;
  background: #fff;
}
.scroll-infinite-item { min-height: 30px; padding: 5px 10px; border-bottom: 1px solid #d8dce1; }
.scroll-infinite-item button { margin: 0 0 0 12px; padding: 2px 8px; }
.scroll-infinite-sentinel { height: 8px; }
.scroll-offscreen-viewport { height: 230px; overflow: auto; border: 1px solid #52677d; }
.scroll-offscreen-canvas { position: relative; width: 1500px; height: 620px; }
.scroll-offscreen-button { position: absolute; left: 1320px; top: 540px; }
.scroll-long-section { min-height: 140px; padding: 12px 4px; border-bottom: 1px solid #c5ccd4; }
.scroll-state { display: block; position: sticky; bottom: 0; z-index: 2; padding: 8px; background: #eef1f4; }
`;

const SCROLL_SCRIPT = `(() => {
  'use strict';
  const main = document.querySelector('[data-testid="browser-lab-scroll-main"]');
  const status = document.getElementById('scroll-state');
  const setScrollPosition = () => {
    status.dataset.browserLabScrollY = String(Math.round(window.scrollY || 0));
  };
  const clickCounts = Object.create(null);
  const recordClick = (button) => {
    const target = button.dataset.browserLabClickTarget;
    if (!target) return;
    clickCounts[target] = (clickCounts[target] || 0) + 1;
    status.dataset.browserLabLastClick = target;
    status.dataset.browserLabClicks = JSON.stringify(clickCounts);
    button.dataset.browserLabClickCount = String(clickCounts[target]);
  };
  main.addEventListener('click', (event) => {
    const button = event.target.closest('[data-browser-lab-click-target]');
    if (button) recordClick(button);
  });
  window.addEventListener('scroll', setScrollPosition, { passive: true });
  setScrollPosition();

  const virtualViewport = document.getElementById('virtual-viewport');
  const virtualSpacer = document.getElementById('virtual-spacer');
  const virtualWindow = document.getElementById('virtual-window');
  const virtualStatus = document.getElementById('virtual-status');
  const rowHeight = 32;
  const logicalRows = 10000;
  virtualSpacer.style.height = String(logicalRows * rowHeight) + 'px';
  const renderVirtualRows = () => {
    const first = Math.max(0, Math.floor(virtualViewport.scrollTop / rowHeight) - 2);
    const visible = Math.ceil(virtualViewport.clientHeight / rowHeight) + 4;
    const last = Math.min(logicalRows, first + visible);
    virtualWindow.style.transform = 'translateY(' + String(first * rowHeight) + 'px)';
    virtualWindow.replaceChildren();
    for (let index = first; index < last; index += 1) {
      const row = document.createElement('div');
      row.className = 'scroll-virtual-row';
      row.dataset.testid = 'browser-lab-scroll-virtual-row-' + String(index);
      row.textContent = 'Virtual row ' + String(index);
      if (index === 7777) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.browserLabClickTarget = 'virtual-target';
        button.dataset.testid = 'browser-lab-scroll-virtual-target';
        button.textContent = 'Target row 7,777';
        row.appendChild(button);
        virtualStatus.dataset.browserLabTargetRendered = 'true';
      }
      virtualWindow.appendChild(row);
    }
    virtualStatus.dataset.browserLabFirstRow = String(first);
    virtualStatus.dataset.browserLabLastRow = String(Math.max(first, last - 1));
    virtualStatus.dataset.browserLabLogicalRows = String(logicalRows);
  };
  virtualViewport.addEventListener('scroll', renderVirtualRows, { passive: true });
  renderVirtualRows();

  const infiniteViewport = document.getElementById('infinite-viewport');
  const infiniteItems = document.getElementById('infinite-items');
  const infiniteSentinel = document.getElementById('infinite-sentinel');
  const infiniteStatus = document.getElementById('infinite-status');
  const batchSize = 20;
  const maxItems = 200;
  let itemCount = 0;
  let appending = false;
  const syncInfiniteStatus = (state) => {
    infiniteStatus.dataset.browserLabItemCount = String(itemCount);
    infiniteStatus.dataset.browserLabState = state;
    infiniteStatus.dataset.browserLabTargetPresent = itemCount >= 150 ? 'true' : 'false';
  };
  const appendBatch = () => {
    if (appending || itemCount >= maxItems) return;
    appending = true;
    syncInfiniteStatus('loading');
    const end = Math.min(maxItems, itemCount + batchSize);
    for (let number = itemCount + 1; number <= end; number += 1) {
      const item = document.createElement('div');
      item.className = 'scroll-infinite-item';
      item.textContent = 'Infinite item ' + String(number);
      if (number === 150) {
        item.dataset.testid = 'browser-lab-scroll-infinite-item-150';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.browserLabClickTarget = 'infinite-target';
        button.dataset.testid = 'browser-lab-scroll-infinite-target';
        button.textContent = 'Target item 150';
        item.appendChild(button);
      }
      infiniteItems.appendChild(item);
    }
    itemCount = end;
    appending = false;
    syncInfiniteStatus(itemCount >= maxItems ? 'complete' : 'idle');
  };
  syncInfiniteStatus('idle');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) appendBatch();
    }, { root: infiniteViewport, rootMargin: '0px' });
    observer.observe(infiniteSentinel);
  } else {
    infiniteViewport.addEventListener('scroll', () => {
      const sentinelRect = infiniteSentinel.getBoundingClientRect();
      const viewportRect = infiniteViewport.getBoundingClientRect();
      if (sentinelRect.top <= viewportRect.bottom && sentinelRect.bottom >= viewportRect.top) appendBatch();
    }, { passive: true });
  }
})();`;

export const interactionCase = {
  id: 'scroll',
  kind: 'interaction',
  title: 'Scrolling',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-scroll-main',
        'browser-lab-scroll-status',
        'browser-lab-scroll-section-1',
        'browser-lab-scroll-section-30',
        'browser-lab-scroll-section-60',
        'browser-lab-scroll-sticky-header',
        'browser-lab-scroll-sticky-target',
        'browser-lab-scroll-nested-outer',
        'browser-lab-scroll-nested-inner',
        'browser-lab-scroll-nested-target',
        'browser-lab-scroll-virtual-viewport',
        'browser-lab-scroll-virtual-status',
        'browser-lab-scroll-infinite-viewport',
        'browser-lab-scroll-infinite-status',
        'browser-lab-scroll-infinite-sentinel',
        'browser-lab-scroll-offscreen-viewport',
        'browser-lab-scroll-offscreen-button',
      ],
      clientControls: [
        'browser-lab-scroll-virtual-row-0',
        'browser-lab-scroll-virtual-row-7777',
        'browser-lab-scroll-virtual-target',
        'browser-lab-scroll-infinite-item-150',
        'browser-lab-scroll-infinite-target',
      ],
    },
  ],
};

export function createRoutes(kit) {
  const { html } = kit;
  const sections = Array.from({ length: 60 }, (_, index) => {
    const number = index + 1;
    const headingTestId = [1, 30, 60].includes(number)
      ? `browser-lab-scroll-section-${number}`
      : null;
    return html`<section
      class="scroll-long-section"
      id="browser-lab-scroll-section-${number}"
    >
      <h2 ${headingTestId ? html`data-testid="${headingTestId}"` : ''}>
        Section ${number}
      </h2>
      <p>
        Deterministic long-page content for vertical scrolling case ${number}.
        Scroll the page to inspect this section.
      </p>
    </section>`;
  });
  const page = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [SCROLL_SCRIPT],
      styles: SCROLL_STYLES,
      main: html`<main
        class="scroll-main"
        data-testid="browser-lab-scroll-main"
      >
        <h1>${interactionCase.title}</h1>
        <output
          id="scroll-state"
          class="scroll-state"
          data-testid="browser-lab-scroll-status"
          data-browser-lab-last-click="none"
          data-browser-lab-clicks="{}"
          data-browser-lab-scroll-y="0"
          >No target clicked.</output
        >

        <section aria-labelledby="sticky-title">
          <h2 id="sticky-title">Sticky header overlap</h2>
          <div
            data-testid="browser-lab-scroll-sticky-header"
            class="scroll-sticky-header"
          >
            Sticky header
          </div>
          <button
            class="scroll-sticky-target"
            data-browser-lab-click-target="sticky-target"
            data-browser-lab-click-count="0"
            data-testid="browser-lab-scroll-sticky-target"
            type="button"
          >
            Sticky target button
          </button>
        </section>

        <section aria-labelledby="nested-title">
          <h2 id="nested-title">Nested scroll containers</h2>
          <div
            class="scroll-nested-outer"
            data-testid="browser-lab-scroll-nested-outer"
            tabindex="0"
          >
            <div class="scroll-nested-outer-content">
              <p>
                Outer scroller: scroll this area to reach the inner scroller.
              </p>
              <div
                class="scroll-nested-inner"
                data-testid="browser-lab-scroll-nested-inner"
                tabindex="0"
              >
                <div class="scroll-nested-inner-content">
                  <p>
                    Inner scroller: scroll independently to reach its target.
                  </p>
                  <button
                    class="scroll-nested-target"
                    data-browser-lab-click-target="nested-target"
                    data-browser-lab-click-count="0"
                    data-testid="browser-lab-scroll-nested-target"
                    type="button"
                  >
                    Nested target button
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="virtual-title">
          <h2 id="virtual-title">Virtualized list (10,000 rows)</h2>
          <output
            id="virtual-status"
            data-testid="browser-lab-scroll-virtual-status"
            data-browser-lab-logical-rows="10000"
            data-browser-lab-first-row="0"
            data-browser-lab-last-row="0"
            data-browser-lab-target-rendered="false"
            >Virtual rows are rendered on demand.</output
          >
          <div
            id="virtual-viewport"
            class="scroll-virtual-viewport"
            data-testid="browser-lab-scroll-virtual-viewport"
            tabindex="0"
            aria-label="Virtualized rows"
          >
            <div id="virtual-spacer" class="scroll-virtual-spacer">
              <div id="virtual-window" class="scroll-virtual-window"></div>
            </div>
          </div>
        </section>

        <section aria-labelledby="infinite-title">
          <h2 id="infinite-title">Infinite scroll (up to 200 items)</h2>
          <output
            id="infinite-status"
            data-testid="browser-lab-scroll-infinite-status"
            data-browser-lab-state="idle"
            data-browser-lab-item-count="0"
            data-browser-lab-target-present="false"
            >Scroll this container to append items.</output
          >
          <div
            id="infinite-viewport"
            class="scroll-infinite-viewport"
            data-testid="browser-lab-scroll-infinite-viewport"
            tabindex="0"
            aria-label="Infinite items"
          >
            <div id="infinite-items"></div>
            <div
              id="infinite-sentinel"
              class="scroll-infinite-sentinel"
              data-testid="browser-lab-scroll-infinite-sentinel"
              aria-hidden="true"
            ></div>
          </div>
        </section>

        <section aria-labelledby="offscreen-title">
          <h2 id="offscreen-title">Off-screen target</h2>
          <p>
            Scroll both axes inside this wide container to reach the button.
          </p>
          <div
            class="scroll-offscreen-viewport"
            data-testid="browser-lab-scroll-offscreen-viewport"
            tabindex="0"
          >
            <div class="scroll-offscreen-canvas">
              <button
                class="scroll-offscreen-button"
                data-browser-lab-click-target="offscreen-button"
                data-browser-lab-click-count="0"
                data-testid="browser-lab-scroll-offscreen-button"
                type="button"
              >
                Off-screen button
              </button>
            </div>
          </div>
        </section>

        <section aria-labelledby="long-page-title">
          <h2 id="long-page-title">Long page</h2>
          <p>
            Sixty deterministic sections provide more than six thousand pixels
            of page content.
          </p>
          ${sections}
        </section>
      </main>`,
    });
  return [[ENTRY_PATH, kit.pageRoute(page)]];
}
