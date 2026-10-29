// Browser Lab interaction case `heavy` (CAN-1570).

const ENTRY_PATH = '/browser-lab/heavy';
const FRAME_PATH = `${ENTRY_PATH}/frame`;

// These catalog values mirror BROWSER_LAB_INTERACTION_LIMITS in
// ../browser-lab.mjs. Keep them in sync; the fixture test asserts the match.
const HEAVY_ELEMENTS = 8000;
const HEAVY_FRAMES = 30;
const HEAVY_CROSS_SITE_FRAMES = 10;
const HEAVY_SHADOW_HOSTS = 20;
const HEAVY_CLICK_LISTENERS = 150;

const HEAVY_STYLES = `
  main[data-testid="browser-lab-heavy-main"] { max-width: 1100px; }
  .heavy-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .heavy-panel { min-width: 0; padding: 12px; border: 1px solid #b7bec7; border-radius: 6px; }
  .heavy-panel iframe { width: 100%; height: 90px; border: 1px solid #8993a0; }
  .heavy-listeners { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
  .heavy-listeners button { min-width: 0; margin: 0; padding: 4px; }
  .heavy-generated-record { display: inline-block; margin: 0 4px 2px 0; padding: 1px 3px; font-size: 11px; }
  .heavy-example-groups { margin-top: 16px; }
  .heavy-example-groups section { margin: 8px 0; padding: 8px; border: 1px solid #d5d9df; }
  .heavy-example-groups table { max-width: 460px; }
`;

const HEAVY_SCRIPT = `(() => {
  'use strict';

  const main = document.querySelector('[data-testid="browser-lab-heavy-main"]');
  const status = document.querySelector('[data-testid="browser-lab-heavy-status"]');
  const targetCount = Number(main.getAttribute('data-browser-lab-heavy-elements'));
  const generated = main.querySelector('[data-browser-lab-heavy-generated]');
  const tags = ['span', 'p', 'a', 'button', 'label', 'section', 'div'];
  let elementCount = document.getElementsByTagName('*').length;
  let generatedIndex = 0;
  while (elementCount < targetCount) {
    const item = document.createElement(tags[(generatedIndex * 7 + 3) % tags.length]);
    item.className = 'heavy-generated-record';
    item.textContent = 'Synthetic record ' + String(generatedIndex + 1);
    if (item.tagName === 'A') {
      item.href = '#heavy-records';
    } else if (item.tagName === 'BUTTON') {
      item.type = 'button';
    }
    generated.appendChild(item);
    generatedIndex += 1;
    elementCount += 1;
  }

  const listenerElements = Array.from(main.querySelectorAll('[data-browser-lab-heavy-listener]'));
  let clickCount = 0;
  listenerElements.slice(0, Number(main.getAttribute('data-browser-lab-heavy-click-listeners'))).forEach((element) => {
    element.addEventListener('click', () => {
      clickCount += 1;
      status.setAttribute('data-browser-lab-click-count', String(clickCount));
      status.textContent = 'Listener clicks: ' + String(clickCount);
    });
  });

  // Shadow content carries no listeners, so the page has exactly
  // data-browser-lab-heavy-click-listeners elements with a click listener.
  const shadowHosts = Array.from(main.querySelectorAll('[data-browser-lab-heavy-shadow-host]'));
  shadowHosts.forEach((host, index) => {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<section><button type="button">Shadow action ' + String(index + 1) + '</button><input aria-label="Shadow note" type="text"><select aria-label="Shadow option"><option>One</option><option>Two</option></select></section>';
  });

  main.setAttribute('data-browser-lab-heavy-ready', 'true');
  status.setAttribute('data-browser-lab-heavy-ready', 'true');
  status.setAttribute('data-browser-lab-element-count', String(document.getElementsByTagName('*').length));
  status.setAttribute('data-browser-lab-shadow-roots', String(shadowHosts.length));
  status.setAttribute('data-browser-lab-listener-count', String(listenerElements.length));
  status.textContent = 'Ready: ' + String(document.getElementsByTagName('*').length) + ' elements';
})();`;

const HEAVY_FRAME_SCRIPT = `(() => {
  'use strict';
  const button = document.querySelector('[data-testid="browser-lab-heavy-frame-action"]');
  const status = document.querySelector('[data-testid="browser-lab-heavy-frame-status"]');
  let clickCount = 0;
  button.addEventListener('click', () => {
    clickCount += 1;
    status.setAttribute('data-browser-lab-state', 'clicked');
    status.setAttribute('data-browser-lab-click-count', String(clickCount));
    status.textContent = 'Frame clicks: ' + String(clickCount);
  });
})();`;

function buildExampleGroups(html) {
  return Array.from({ length: 10 }, (_, groupIndex) => {
    const rows = Array.from(
      { length: 6 },
      (_, rowIndex) =>
        html`<tr>
          <th scope="row">Group ${groupIndex + 1}, row ${rowIndex + 1}</th>
          <td><a href="#heavy-records">Open record ${rowIndex + 1}</a></td>
          <td><button type="button">Review</button></td>
        </tr>`,
    );
    const items = Array.from(
      { length: 5 },
      (_, itemIndex) =>
        html`<li>
          <a href="#heavy-records"
            >Group ${groupIndex + 1} item ${itemIndex + 1}</a
          >
        </li>`,
    );
    return html`<section>
      <h2>Workspace group ${groupIndex + 1}</h2>
      <p>
        Reference material for synthetic workspace group ${groupIndex + 1}.
        <a href="#heavy-records">Read the summary</a>
      </p>
      <ul>
        ${items}
      </ul>
      <table>
        <caption>
          Recent records for group ${groupIndex + 1}
        </caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Details</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <form>
        <label for="heavy-filter-${groupIndex}"
          >Filter group ${groupIndex + 1}</label
        >
        <input id="heavy-filter-${groupIndex}" type="text" value="sample" />
        <button type="button">Apply filter</button>
      </form>
    </section>`;
  });
}

export const interactionCase = {
  id: 'heavy',
  kind: 'interaction',
  title: 'Heavy page',
  entryPath: ENTRY_PATH,
  heavy: {
    elements: HEAVY_ELEMENTS,
    frames: HEAVY_FRAMES,
    crossSiteFrames: HEAVY_CROSS_SITE_FRAMES,
    shadowHosts: HEAVY_SHADOW_HOSTS,
    clickListeners: HEAVY_CLICK_LISTENERS,
  },
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-heavy-main',
        'browser-lab-header-home',
        'browser-lab-heavy-frame-container',
        'browser-lab-heavy-shadow-host-container',
        'browser-lab-heavy-listener-container',
        'browser-lab-heavy-status',
      ],
    },
    {
      path: FRAME_PATH,
      controls: [
        'browser-lab-heavy-frame-main',
        'browser-lab-heavy-frame-action',
        'browser-lab-heavy-frame-status',
      ],
    },
  ],
};

function assertLimitsMatch(kit) {
  const limits = kit.INTERACTION_LIMITS;
  if (
    limits.heavyElements !== HEAVY_ELEMENTS ||
    limits.heavyFrames !== HEAVY_FRAMES ||
    limits.heavyCrossSiteFrames !== HEAVY_CROSS_SITE_FRAMES ||
    limits.heavyShadowHosts !== HEAVY_SHADOW_HOSTS ||
    limits.heavyClickListeners !== HEAVY_CLICK_LISTENERS
  ) {
    throw new Error(
      'The heavy Browser Lab catalog and interaction limits must stay in sync.',
    );
  }
}

function renderFramePage(kit) {
  const { html } = kit;
  return kit.renderInteractionPage({
    caseDef: interactionCase,
    suffix: 'Heavy frame',
    header: null,
    scripts: [HEAVY_FRAME_SCRIPT],
    main: html`<main
      data-testid="browser-lab-heavy-frame-main"
      data-browser-lab-frame="heavy"
    >
      <h1>Heavy fixture frame</h1>
      <button type="button" data-testid="browser-lab-heavy-frame-action">
        Frame action
      </button>
      <output
        data-testid="browser-lab-heavy-frame-status"
        data-browser-lab-state="ready"
        data-browser-lab-click-count="0"
        >Ready</output
      >
    </main>`,
  });
}

export function createRoutes(kit) {
  assertLimitsMatch(kit);
  const { html } = kit;

  const renderMainPage = (context) => {
    const paired = kit.pairedOriginFor(context);
    if (paired.error) {
      kit.sendRouteError(context, 500, paired.error);
      return null;
    }

    const frames = Array.from({ length: HEAVY_FRAMES }, (_, index) => {
      const crossSite = index >= HEAVY_FRAMES - HEAVY_CROSS_SITE_FRAMES;
      const frameOrigin = crossSite ? paired.origin : '';
      return html`<iframe
        title="Heavy fixture frame ${index + 1}"
        name="browser-lab-heavy-frame-${index}"
        src="${frameOrigin}${FRAME_PATH}"
        data-browser-lab-frame-index="${index}"
        data-browser-lab-cross-site="${String(crossSite)}"
      ></iframe>`;
    });
    const shadowHosts = Array.from(
      { length: HEAVY_SHADOW_HOSTS },
      (_, index) =>
        html`<div
          data-browser-lab-heavy-shadow-host="${index}"
          aria-label="Open shadow root ${index + 1}"
        ></div>`,
    );
    const listeners = Array.from(
      { length: HEAVY_CLICK_LISTENERS },
      (_, index) =>
        html`<button type="button" data-browser-lab-heavy-listener="${index}">
          Action ${index + 1}
        </button>`,
    );

    return kit.renderInteractionPage({
      caseDef: interactionCase,
      scripts: [HEAVY_SCRIPT],
      styles: HEAVY_STYLES,
      csp: { frameSources: ["'self'", paired.origin] },
      main: html`<main
        data-testid="browser-lab-heavy-main"
        data-browser-lab-heavy-elements="${HEAVY_ELEMENTS}"
        data-browser-lab-heavy-frames="${HEAVY_FRAMES}"
        data-browser-lab-heavy-cross-site-frames="${HEAVY_CROSS_SITE_FRAMES}"
        data-browser-lab-heavy-shadow-hosts="${HEAVY_SHADOW_HOSTS}"
        data-browser-lab-heavy-click-listeners="${HEAVY_CLICK_LISTENERS}"
        data-browser-lab-heavy-ready="false"
      >
        <h1>Heavy interaction fixture</h1>
        <p>
          A deterministic, synthetic page with a fixed light-DOM element count.
        </p>
        <output
          data-testid="browser-lab-heavy-status"
          data-browser-lab-state="loading"
          data-browser-lab-heavy-ready="false"
          data-browser-lab-click-count="0"
          >Preparing fixture</output
        >
        <div class="heavy-columns">
          <section class="heavy-panel">
            <h2>Frames</h2>
            <div data-testid="browser-lab-heavy-frame-container">${frames}</div>
          </section>
          <section class="heavy-panel">
            <h2>Open shadow roots</h2>
            <div data-testid="browser-lab-heavy-shadow-host-container">
              ${shadowHosts}
            </div>
          </section>
          <section class="heavy-panel">
            <h2>Click listeners</h2>
            <div
              class="heavy-listeners"
              data-testid="browser-lab-heavy-listener-container"
            >
              ${listeners}
            </div>
          </section>
        </div>
        <div class="heavy-example-groups">${buildExampleGroups(html)}</div>
        <section aria-label="Generated synthetic records" id="heavy-records">
          <h2>Generated records</h2>
          <div data-browser-lab-heavy-generated></div>
        </section>
      </main>`,
    });
  };

  return [
    [
      ENTRY_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const page = renderMainPage(context);
            if (page) kit.sendPage(context.response, 200, page);
          },
        },
      },
    ],
    [FRAME_PATH, kit.pageRoute(() => renderFramePage(kit))],
  ];
}
