import type { Scenario } from '../browser-agent-bench-evaluator';

const SITE = 'https://the-internet.herokuapp.com';

// The CAN-4831 report's page: one link per target, both to example.com.
const LINK_TEST_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link test</title>
</head>
<body>
  <h1>Link test</h1>
  <p><a href="https://example.com" target="_self">Open in the same tab</a></p>
  <p><a href="https://example.com" target="_blank" rel="noopener noreferrer">Open in a new tab</a></p>
</body>
</html>
`;

const heading = "document.querySelector('h1')?.innerText.trim() ?? null";
// example.com has no heading, only a title.
const title = 'document.title';

// The CAN-1570 manual prompts that are not the-internet pages, and link
// targets (CAN-4831).
export const generalScenarios: Scenario[] = [
  {
    id: 'link-target-blank',
    pack: 'general',
    title: 'Follow a target="_blank" link into a new tab',
    prompt:
      'Open the local file {worktree}/link-test.html in the browser, click "Open in a new tab", and tell me the title of the page that opens.',
    setup: { workspaceFiles: { 'link-test.html': LINK_TEST_HTML } },
    expect: {
      replyContains: ['Example Domain'],
      page: [
        // The test page stays in its own tab...
        { url: 'link-test.html', js: heading, equals: 'Link test', tabs: 1 },
        // ...and exactly one new tab shows the link's page.
        { url: 'example.com', js: title, equals: 'Example Domain', tabs: 1 },
      ],
    },
  },
  {
    id: 'link-target-self',
    pack: 'general',
    title: 'Follow a target="_self" link in the same tab',
    prompt:
      'Open the local file {worktree}/link-test.html in the browser, click "Open in the same tab", and tell me the title of the page that opens.',
    setup: { workspaceFiles: { 'link-test.html': LINK_TEST_HTML } },
    expect: {
      replyContains: ['Example Domain'],
      page: [
        // The tab navigated away from the test page, and no other tab opened.
        { url: 'link-test.html', js: 'false', equals: true, passIfNoTab: true },
        { url: 'example.com', js: title, equals: 'Example Domain', tabs: 1 },
      ],
    },
  },
  {
    id: 'wikipedia-scroll-to-text',
    pack: 'general',
    title: 'Scroll to a section and screenshot it',
    prompt:
      'On https://en.wikipedia.org/wiki/Web_browser, scroll to the "History" section heading and take a screenshot. Tell me the first sentence of that section.',
    expect: {
      actionsSucceeded: ['browser.screenshot'],
      page: [
        {
          url: 'en.wikipedia.org/wiki/Web_browser',
          js: "(() => { const top = document.getElementById('History')?.getBoundingClientRect().top; return top !== undefined && top >= -5 && top < innerHeight; })()",
          equals: true,
        },
      ],
    },
  },
  {
    id: 'wikipedia-save-pdf',
    pack: 'general',
    title: 'Save a page as PDF',
    prompt:
      'Save https://en.wikipedia.org/wiki/Electron_(software_framework) as a landscape A4 PDF and tell me the file name.',
    expect: {
      transferStatus: [{ action: 'browser.save_pdf', status: 'complete' }],
    },
  },
  {
    id: 'demoqa-form',
    pack: 'general',
    title: 'Fill a form with comboboxes and a date',
    prompt:
      'Fill out https://demoqa.com/automation-practice-form: name Jane Test, email jane@example.com, gender Female, mobile 5551234567, date of birth 1990-04-15, hobbies Reading and Music, state "NCR", city "Delhi". Don\'t submit.',
    timeoutMs: 420_000,
    expect: {
      page: [
        {
          url: 'demoqa.com/automation-practice-form',
          js: "[document.querySelector('#firstName')?.value, document.querySelector('#lastName')?.value, document.querySelector('#userEmail')?.value, document.querySelector('#gender-radio-2')?.checked, document.querySelector('#userNumber')?.value]",
          equals: ['Jane', 'Test', 'jane@example.com', true, '5551234567'],
        },
        {
          url: 'demoqa.com/automation-practice-form',
          js: "[document.querySelector('#hobbies-checkbox-2')?.checked, document.querySelector('#hobbies-checkbox-3')?.checked]",
          equals: [true, true],
        },
        {
          url: 'demoqa.com/automation-practice-form',
          js: "[document.querySelector('#state')?.innerText.includes('NCR'), document.querySelector('#city')?.innerText.includes('Delhi')]",
          equals: [true, true],
        },
        {
          url: 'demoqa.com/automation-practice-form',
          js: "document.querySelector('#dateOfBirthInput')?.value",
          equals: '15 Apr 1990',
        },
      ],
    },
  },
  {
    id: 'cross-origin-print',
    pack: 'general',
    title: 'Save a print request from a cross-origin frame as PDF',
    prompt:
      'Go to https://www.w3schools.com/jsref/tryit.asp?filename=tryjsref_print and click the "Print this page" button in the result frame. Handle whatever comes up by saving it as a PDF.',
    expect: {
      // Dismissing the print also succeeds, so require the saved PDF.
      transferStatus: [{ action: 'browser.handle_dialog', status: 'complete' }],
    },
  },
  {
    id: 'recording-workflow',
    pack: 'general',
    title: 'Record a workflow as a Playwright script',
    prompt: `Start a browser recording. Then on ${SITE}: check both checkboxes on /checkboxes, pick Option 1 on /dropdown, hover the first avatar on /hovers, and drag A to B on /drag_and_drop. Stop recording and show me the generated Playwright script.`,
    timeoutMs: 480_000,
    expect: {
      actionsSucceeded: ['browser.start_recording', 'browser.stop_recording'],
      // What the recorder writes: page-side steps, and pointer moves for the
      // hover and the drag.
      replyContains: ['check()', 'selectOption', 'mouse.move', 'mouse.down()'],
    },
  },
  {
    id: 'download-cancel',
    pack: 'general',
    title: 'Start and cancel a large download',
    prompt:
      'Start downloading the large file at https://proof.ovh.net/files/1Gb.dat, then cancel it and confirm it is cancelled.',
    expect: {
      transferStatus: [
        { action: 'browser.cancel_transfer', status: 'cancelled' },
      ],
    },
  },
];
