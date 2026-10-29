// Browser Lab interaction case `print` (CAN-1570): a `window.print()` button,
// a print stylesheet that hides screen-only chrome, and a long, multi-page
// document. Imports nothing; helpers arrive as `kit`.

const ENTRY_PATH = '/browser-lab/print';
const SECTION_COUNT = 24;

export const interactionCase = {
  id: 'print',
  kind: 'interaction',
  title: 'Print',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-print-main',
        'browser-lab-print-button',
        'browser-lab-print-status',
        'browser-lab-print-screen-only',
        'browser-lab-print-only',
        'browser-lab-print-section-0',
        `browser-lab-print-section-${SECTION_COUNT - 1}`,
      ],
    },
  ],
  sectionCount: SECTION_COUNT,
};

const STYLES = `
.print-only { display: none; }
.print-section { margin-block: 24px; }
@media print {
  header, .screen-only, [data-testid='browser-lab-print-button'] { display: none !important; }
  .print-only { display: block; }
  .print-section { break-inside: avoid; }
  .print-section:nth-of-type(6n) { break-after: page; }
}
`;

// Records `beforeprint`/`afterprint` so a test can tell the dialog opened
// without inspecting the native print UI.
const SCRIPT = `(() => {
  'use strict';
  const status = document.querySelector('[data-testid="browser-lab-print-status"]');
  const button = document.querySelector('[data-testid="browser-lab-print-button"]');
  const events = [];
  const record = (name) => {
    events.push(name);
    status.dataset.browserLabEvents = events.join(',');
    status.textContent = 'Print events: ' + events.join(', ');
  };
  window.addEventListener('beforeprint', () => record('beforeprint'));
  window.addEventListener('afterprint', () => record('afterprint'));
  button.addEventListener('click', () => {
    record('click');
    window.print();
  });
})();`;

const PARAGRAPH =
  'Synthetic report text. Each section repeats this deterministic paragraph so the document spans several printed pages.';

export function createRoutes(kit) {
  const { html } = kit;
  const sections = Array.from(
    { length: SECTION_COUNT },
    (_, index) =>
      html`<section
        class="print-section"
        data-testid="browser-lab-print-section-${index}"
      >
        <h2>Section ${index + 1}</h2>
        <p>${PARAGRAPH}</p>
        <p>${PARAGRAPH}</p>
        <p>${PARAGRAPH}</p>
      </section> `,
  );
  const render = () =>
    kit.renderInteractionPage({
      caseDef: interactionCase,
      styles: STYLES,
      scripts: [SCRIPT],
      main: html`<main data-testid="browser-lab-print-main">
        <h1>${interactionCase.title}</h1>
        <div class="screen-only" data-testid="browser-lab-print-screen-only">
          <p>This note is hidden when the page prints.</p>
          <button type="button" data-testid="browser-lab-print-button">
            Print this page
          </button>
          <output
            data-testid="browser-lab-print-status"
            data-browser-lab-events=""
            >Print events: none</output
          >
        </div>
        <p class="print-only" data-testid="browser-lab-print-only">
          Printed from the Browser Lab.
        </p>
        ${sections}
      </main>`,
    });
  return [[ENTRY_PATH, kit.pageRoute(render)]];
}
