import type { PageCheck, Scenario } from '../browser-agent-bench-evaluator';

const SITE = 'https://the-internet.herokuapp.com';

const page = (path: string, js: string, equals: unknown): PageCheck => ({
  url: `the-internet.herokuapp.com${path}`,
  js,
  equals,
});

const text = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)})?.innerText.trim() ?? null`;

function scenario(
  id: string,
  title: string,
  prompt: string,
  expect: Scenario['expect'],
  extra: Partial<Scenario> = {},
): Scenario {
  return { id, pack: 'the-internet', title, prompt, expect, ...extra };
}

// One scenario per page. Checks read live page state where the page keeps it,
// otherwise exact literals the page shows. Left out: forgot_password (the site
// answers 500), typos and dynamic text (random), geolocation (needs an OS
// permission), slow resources (nothing to check), and the auth pages, which
// are in the guardrails pack.
export const theInternetScenarios: Scenario[] = [
  scenario(
    'ab-test',
    'A/B test heading',
    `Go to ${SITE}/abtest and tell me the page's main heading exactly.`,
    { replyMatches: ['A/B Test'] },
  ),
  scenario(
    'add-remove-elements',
    'Add and remove elements',
    `On ${SITE}/add_remove_elements/ add three elements, then delete one of them.`,
    {
      page: [
        page(
          '/add_remove_elements',
          "document.querySelectorAll('#elements button').length",
          2,
        ),
      ],
    },
  ),
  scenario(
    'broken-images',
    'Find broken images',
    `On ${SITE}/broken_images, which images fail to load? Give me their file names.`,
    { replyContains: ['asdf.jpg', 'hjkl.jpg'] },
  ),
  scenario(
    'challenging-dom',
    'Read a table cell',
    `On ${SITE}/challenging_dom, find the table row whose Lorem column is "Iuvaret4" and tell me the value in its Diceret column.`,
    { replyContains: ['Phaedrum4'] },
  ),
  scenario(
    'checkboxes',
    'Set checkbox states',
    `Go to ${SITE}/checkboxes. Make sure checkbox 1 is checked and checkbox 2 is unchecked.`,
    {
      page: [
        page(
          '/checkboxes',
          "[...document.querySelectorAll('#checkboxes input')].map((box) => box.checked)",
          [true, false],
        ),
      ],
    },
  ),
  scenario(
    'context-menu',
    'Right-click context menu',
    `On ${SITE}/context_menu, right-click inside the box and tell me exactly what the alert that appears says. Then dismiss it.`,
    // The alert text is in the page source, so the dialog must be answered.
    {
      replyContains: ['You selected a context menu'],
      actionsSucceeded: ['browser.handle_dialog'],
    },
  ),
  scenario(
    'disappearing-elements',
    'List menu items',
    `List every item in the menu on ${SITE}/disappearing_elements.`,
    { replyContains: ['Home', 'About', 'Contact Us', 'Portfolio'] },
  ),
  scenario(
    'drag-and-drop',
    'Drag A onto B',
    `On ${SITE}/drag_and_drop, drag box A onto box B.`,
    {
      page: [
        page(
          '/drag_and_drop',
          "[...document.querySelectorAll('#columns header')].map((header) => header.innerText)",
          ['B', 'A'],
        ),
      ],
    },
  ),
  scenario(
    'dropdown',
    'Pick a dropdown option',
    `On ${SITE}/dropdown, choose "Option 2".`,
    {
      page: [
        page('/dropdown', "document.querySelector('#dropdown').value", '2'),
      ],
    },
  ),
  scenario(
    'dynamic-content',
    'Count content rows',
    `How many content rows (avatar plus text) does ${SITE}/dynamic_content show?`,
    { replyMatches: ['\\b(3|three)\\b'] },
  ),
  scenario(
    'dynamic-controls',
    'Remove and enable controls',
    `On ${SITE}/dynamic_controls, remove the checkbox, then enable the text field and type "canopy" into it. Wait for each change to finish.`,
    {
      page: [
        page(
          '/dynamic_controls',
          "document.querySelector('#checkbox') === null",
          true,
        ),
        page(
          '/dynamic_controls',
          "document.querySelector('#input-example input').value",
          'canopy',
        ),
      ],
    },
  ),
  scenario(
    'dynamic-loading-hidden',
    'Wait for a hidden element',
    `On ${SITE}/dynamic_loading/1, click Start and tell me the text that appears when loading finishes.`,
    {
      replyContains: ['Hello World!'],
      page: [page('/dynamic_loading/1', text('#finish'), 'Hello World!')],
    },
  ),
  scenario(
    'dynamic-loading-rendered',
    'Wait for a rendered element',
    `On ${SITE}/dynamic_loading/2, click Start and tell me the text that appears when loading finishes.`,
    {
      replyContains: ['Hello World!'],
      page: [page('/dynamic_loading/2', text('#finish'), 'Hello World!')],
    },
  ),
  scenario(
    'entry-ad',
    'Close an entry modal',
    `Open ${SITE}/entry_ad and close the ad modal that appears.`,
    {
      page: [
        page(
          '/entry_ad',
          "getComputedStyle(document.querySelector('#modal')).display",
          'none',
        ),
      ],
    },
  ),
  scenario(
    'exit-intent',
    'Trigger an exit-intent modal',
    `On ${SITE}/exit_intent, make the exit-intent modal appear and tell me its title.`,
    // The title is in the page source, so the modal itself must be open.
    {
      replyContains: ['This is a modal window'],
      page: [
        page(
          '/exit_intent',
          "getComputedStyle(document.querySelector('#ouibounce-modal')).display !== 'none'",
          true,
        ),
      ],
    },
  ),
  scenario(
    'file-download',
    'Download and save into the workspace',
    `Download the first .txt file listed on ${SITE}/download, wait for it to finish, then save a copy into the workspace folder tmp/downloads/ and tell me its name.`,
    { files: ['tmp/downloads/'] },
    { timeoutMs: 360_000 },
  ),
  scenario(
    'file-upload',
    'Upload a workspace file',
    `Upload the workspace file tmp/upload-test.txt with the file input on ${SITE}/upload, submit it, and tell me what the page says.`,
    {
      page: [page('/upload', text('#uploaded-files'), 'upload-test.txt')],
    },
    {
      setup: {
        workspaceFiles: { 'tmp/upload-test.txt': 'hello upload\n' },
        approvals: 'allow',
      },
    },
  ),
  scenario(
    'file-drop',
    'Drop a file on a drop zone',
    `Drop the workspace file tmp/drop-test.txt onto the drag-and-drop area on ${SITE}/upload.`,
    {
      page: [
        page(
          '/upload',
          "[...document.querySelectorAll('#drag-drop-upload .dz-filename')].map((name) => name.innerText.trim())",
          ['drop-test.txt'],
        ),
      ],
    },
    {
      setup: {
        workspaceFiles: { 'tmp/drop-test.txt': 'hello drop\n' },
        approvals: 'allow',
      },
    },
  ),
  scenario(
    'floating-menu',
    'Use a floating menu after scrolling',
    `On ${SITE}/floating_menu, scroll to the bottom of the page, then click "News" in the floating menu.`,
    { page: [page('/floating_menu', 'location.hash', '#news')] },
  ),
  scenario(
    'form-login',
    'Log in with the demo credentials',
    `Log in at ${SITE}/login with the username and password the page tells you to use, then tell me the message you see.`,
    {
      replyContains: ['You logged into a secure area!'],
      page: [page('/secure', 'location.pathname', '/secure')],
    },
  ),
  scenario(
    'iframe-editor',
    'Type in an editor inside an iframe',
    `On ${SITE}/iframe, replace the editor's text with "Hello from Canopy" and tell me what the editor contains.`,
    {
      page: [
        page(
          '/iframe',
          "document.querySelector('#mce_0_ifr').contentDocument.body.innerText.trim()",
          'Hello from Canopy',
        ),
      ],
    },
  ),
  scenario(
    'nested-frames',
    'Read nested frames',
    `List the text in each frame of ${SITE}/nested_frames.`,
    { replyContains: ['LEFT', 'MIDDLE', 'RIGHT', 'BOTTOM'] },
  ),
  scenario(
    'horizontal-slider',
    'Set a range slider',
    `On ${SITE}/horizontal_slider, set the slider to 3.5.`,
    { page: [page('/horizontal_slider', text('#range'), '3.5')] },
  ),
  scenario(
    'hovers',
    'Reveal hover captions',
    `Go to ${SITE}/hovers. Hover over each of the three avatars and tell me the name revealed under each one.`,
    // The names are in the page source too, so the hovers must work.
    {
      replyContains: ['user1', 'user2', 'user3'],
      actionsSucceeded: ['browser.hover'],
    },
  ),
  scenario(
    'infinite-scroll',
    'Scroll an infinite page',
    `Go to ${SITE}/infinite_scroll and scroll down 5 pages. Tell me how many paragraphs have loaded.`,
    {
      page: [
        page(
          '/infinite_scroll',
          "document.querySelectorAll('.jscroll-added').length >= 5",
          true,
        ),
      ],
    },
  ),
  scenario(
    'inputs',
    'Type into a number input',
    `On ${SITE}/inputs, enter 42 in the number field.`,
    { page: [page('/inputs', "document.querySelector('input').value", '42')] },
  ),
  scenario(
    'jqueryui-menu',
    'Navigate a nested menu',
    `On ${SITE}/jqueryui/menu, open Enabled → Downloads and tell me the link address of the CSV item.`,
    { replyContains: ['/download/jqueryui/menu/menu.csv'] },
  ),
  scenario(
    'javascript-alerts',
    'Handle alert, confirm, and prompt',
    `Go to ${SITE}/javascript_alerts. Click the JS Alert and accept it, click the JS Confirm and cancel it, then click the JS Prompt, enter "canopy", and accept. Report the result text after each.`,
    {
      replyContains: [
        'You successfully clicked an alert',
        'You clicked: Cancel',
        'You entered: canopy',
      ],
      page: [
        page('/javascript_alerts', text('#result'), 'You entered: canopy'),
      ],
    },
  ),
  scenario(
    'javascript-error',
    'Read a console error',
    `Open ${SITE}/javascript_error and tell me the JavaScript error the page logs when it loads.`,
    { replyContains: ["reading 'xyz'"] },
  ),
  scenario(
    'key-presses',
    'Press a named key',
    `On ${SITE}/key_presses, click the input and press the Escape key. Tell me what the page reports.`,
    {
      replyContains: ['You entered: ESCAPE'],
      page: [page('/key_presses', text('#result'), 'You entered: ESCAPE')],
    },
  ),
  scenario(
    'large-dom',
    'Find a cell in a large table',
    `On ${SITE}/large, what is in the large table at row 37, column 12?`,
    { replyContains: ['37.12'] },
  ),
  scenario(
    'multiple-windows',
    'Follow a link that opens a window',
    `On ${SITE}/windows, click "Click Here" and tell me the heading of the page that opens.`,
    { replyContains: ['New Window'] },
  ),
  scenario(
    'notification-message',
    'Retry until a message appears',
    `On ${SITE}/notification_message_rendered, click "Click here" until the notification says "Action successful", then tell me how many clicks it took.`,
    {
      page: [
        page(
          '/notification_message',
          "document.querySelector('#flash')?.innerText.includes('Action successful') ?? false",
          true,
        ),
      ],
    },
  ),
  scenario(
    'redirect',
    'Follow a redirect',
    `On ${SITE}/redirector, follow the redirect link and tell me the page you end up on.`,
    { page: [page('/status_codes', 'location.pathname', '/status_codes')] },
  ),
  scenario(
    'shadow-dom',
    'Read text in shadow roots',
    `Go to ${SITE}/shadowdom and tell me all the text inside the shadow roots.`,
    { replyContains: ["Let's have some different text!", 'In a list!'] },
  ),
  scenario(
    'shifting-content',
    'Read a shifting menu',
    `List the menu items on ${SITE}/shifting_content/menu.`,
    { replyContains: ['Home', 'About', 'Contact Us', 'Portfolio', 'Gallery'] },
  ),
  scenario(
    'sortable-tables',
    'Sort a table',
    `On ${SITE}/tables, sort the first table by Last Name, ascending, and tell me the email in the top row.`,
    {
      replyContains: ['fbach@yahoo.com'],
      page: [page('/tables', text('#table1 tbody tr td'), 'Bach')],
    },
  ),
  scenario(
    'status-codes',
    'Open a status page',
    `On ${SITE}/status_codes, open the 404 example and tell me what the page says.`,
    { replyContains: ['404 status code'] },
  ),
];
