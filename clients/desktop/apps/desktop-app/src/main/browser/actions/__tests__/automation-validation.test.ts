import { browserActionCorpus } from '@canopy/agent-actions/families/browser/__tests__/browser-action-corpus';
import { validateBrowserAutomationCommand } from '../automation-validation';

describe('validateBrowserAutomationCommand', () => {
  it.each([
    { kind: 'click', locator: '#submit' },
    { kind: 'fill', locator: '#name', text: 'Ada' },
    { kind: 'press', key: 'Enter' },
    { kind: 'focus', locator: '#name' },
    { kind: 'wait_for', text: 'Ready' },
    { kind: 'wait_for', url: '/dashboard' },
    { kind: 'wait_for', loadState: 'domcontentloaded' },
    { kind: 'inspect', locator: '#submit' },
    {
      kind: 'click',
      locator: '#submit',
      actionId: undefined,
      force: undefined,
    },
  ])(
    'accepts valid commands without requiring omitted defaults: %j',
    (command) => {
      expect(validateBrowserAutomationCommand(command)).toBeUndefined();
    },
  );

  it.each([
    null,
    [],
    {},
    { kind: 'unknown' },
    { kind: 'fill', locator: '#name' },
    { kind: 'press' },
    { kind: 'wait_for' },
    { kind: 'wait_for', locator: '#ready', url: '/ready' },
  ])('rejects malformed commands: %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toEqual(
      expect.any(String),
    );
  });

  it.each([
    { kind: 'click', locator: '#submit', clickCount: 0 },
    { kind: 'click', locator: '#submit', clickCount: 1.5 },
    { kind: 'click', locator: '#submit', clickCount: 4 },
    { kind: 'click', locator: '#submit', timeoutMs: Number.NaN },
    { kind: 'click', locator: '#submit', timeoutMs: Number.POSITIVE_INFINITY },
    { kind: 'click', locator: '#submit', timeoutMs: -1 },
    { kind: 'click', locator: '#submit', timeoutMs: 60_001 },
    { kind: 'wait_for', text: 'Ready', timeoutMs: 120_001 },
    {
      kind: 'click',
      locator: '#submit',
      position: { x: -0.1, y: 2 },
    },
    {
      kind: 'click',
      locator: '#submit',
      position: { x: 1, y: Number.POSITIVE_INFINITY },
    },
  ])('rejects invalid numeric bounds: %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toEqual(
      expect.any(String),
    );
  });

  it.each([
    { kind: 'click', locator: '#submit', button: 'extra' },
    { kind: 'click', locator: '#submit', modifiers: ['Option'] },
    { kind: 'click', locator: '#submit', position: { x: 1 } },
    { kind: 'focus', locator: 42 },
    { kind: 'wait_for', locator: '#ready', state: 'eventually' },
    { kind: 'wait_for', loadState: 'networkidle' },
  ])('rejects invalid command fields: %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toEqual(
      expect.any(String),
    );
  });
});

describe('the frame field at the main-process boundary', () => {
  it.each([
    { kind: 'click', locator: 'button', frame: 'iframe#pay' },
    { kind: 'fill', locator: '#name', frame: 'f-0', text: 'Ada' },
    { kind: 'press', locator: '#name', frame: 'f-0', key: 'Enter' },
    { kind: 'focus', locator: '#name', frame: ' iframe ' },
    { kind: 'wait_for', locator: '#ready', frame: 'iframe' },
    { kind: 'wait_for', text: 'Ready', frame: 'iframe' },
    { kind: 'inspect', locator: '#name', frame: 'iframe' },
  ])('accepts a frame that scopes a locator or text: %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toBeUndefined();
  });

  it.each([
    [
      { kind: 'click', locator: 'button', frame: '' },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'fill', locator: '#n', text: 'x', frame: '   ' },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'press', locator: '#n', key: 'a', frame: 7 },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'focus', locator: '#n', frame: null },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'inspect', locator: '#n', frame: ['iframe'] },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'wait_for', text: 'Ready', frame: {} },
      'frame must be a non-empty string.',
    ],
    [
      { kind: 'click', ref: 'r-1', frame: 'iframe' },
      'browser.click frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'click', x: 1, y: 2, frame: 'iframe' },
      'browser.click frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'click', locator: 'button', x: 1, y: 2, frame: 'iframe' },
      'browser.click frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'fill', ref: 'r-1', text: 'x', frame: 'iframe' },
      'browser.fill frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'press', key: 'Enter', frame: 'iframe' },
      'browser.press frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'focus', ref: 'r-1', frame: 'iframe' },
      'browser.focus frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'inspect', x: 3, y: 4, frame: 'iframe' },
      'browser.inspect frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'wait_for', url: '/done', frame: 'iframe' },
      'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, or download.',
    ],
    [
      { kind: 'wait_for', loadState: 'load', frame: 'iframe' },
      'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, or download.',
    ],
  ])('rejects %j', (command, message) => {
    expect(validateBrowserAutomationCommand(command)).toBe(message);
  });

  describe('phase 06 form action payloads (D1)', () => {
    it.each([
      {
        kind: 'set_checked',
        ref: 'r-1',
        checked: true,
        actionId: 'a'.repeat(128),
        timeoutMs: 60_000,
      },
      {
        kind: 'set_checked',
        locator: '#enabled',
        frame: 'f-1',
        checked: false,
      },
      {
        kind: 'select_option',
        ref: 'r-2',
        values: ['', 'v'.repeat(500)],
      },
      {
        kind: 'select_option',
        locator: '#color',
        labels: ['Red', 'L'.repeat(500)],
        searchText: 'S'.repeat(200),
      },
      {
        kind: 'select_option',
        locator: '#size',
        indexes: [0, 9_999],
      },
      { kind: 'type', text: 'x' },
      { kind: 'type', text: 'x'.repeat(4_000), delayMs: 0 },
      {
        kind: 'type',
        locator: '#search',
        frame: 'f-1',
        text: 'search',
        delayMs: 500,
      },
      { kind: 'type', text: 'x'.repeat(100), delayMs: 500 },
    ])('accepts valid form action payloads: %j', (command) => {
      expect(validateBrowserAutomationCommand(command)).toBeUndefined();
    });

    it.each([
      [
        { kind: 'set_checked', checked: true },
        'Provide exactly one of ref or locator.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', locator: '#enabled', checked: true },
        'Provide exactly one of ref or locator.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: 'true' },
        'checked must be a boolean.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: true, x: 1 },
        'x is not supported for this command.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: true, actionId: '   ' },
        'actionId must be a non-empty string of at most 128 characters.',
      ],
      [
        {
          kind: 'set_checked',
          ref: 'r-1',
          checked: true,
          actionId: 'a'.repeat(129),
        },
        'actionId must be a non-empty string of at most 128 characters.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: true, timeoutMs: 0 },
        'timeoutMs must be an integer between 1 and 60000.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: true, timeoutMs: 1.5 },
        'timeoutMs must be an integer between 1 and 60000.',
      ],
      [
        { kind: 'set_checked', ref: 'r-1', checked: true, timeoutMs: 60_001 },
        'timeoutMs must be an integer between 1 and 60000.',
      ],
      [
        {
          kind: 'set_checked',
          ref: 'r-1',
          frame: 'f-1',
          checked: true,
        },
        'browser.set_checked frame applies only to locators; a ref already identifies its frame.',
      ],
      [
        { kind: 'select_option', ref: 'r-1' },
        'Provide exactly one of values, labels, or indexes.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', values: ['x'], labels: ['X'] },
        'Provide exactly one of values, labels, or indexes.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', values: [] },
        'values must contain between 1 and 50 entries.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', labels: Array(51).fill('x') },
        'labels must contain between 1 and 50 entries.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', values: [1] },
        'values entries must be strings of at most 500 characters.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', values: ['v'.repeat(501)] },
        'values entries must be strings of at most 500 characters.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', labels: [''] },
        'labels entries must be strings of 1 to 500 characters.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', labels: ['l'.repeat(501)] },
        'labels entries must be strings of 1 to 500 characters.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', indexes: [-1] },
        'indexes entries must be integers from 0 to 9999.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', indexes: [1.5] },
        'indexes entries must be integers from 0 to 9999.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', indexes: [10_000] },
        'indexes entries must be integers from 0 to 9999.',
      ],
      [
        { kind: 'select_option', ref: 'r-1', values: ['x'], searchText: '' },
        'searchText must contain between 1 and 200 characters.',
      ],
      [
        {
          kind: 'select_option',
          ref: 'r-1',
          values: ['x'],
          searchText: 's'.repeat(201),
        },
        'searchText must contain between 1 and 200 characters.',
      ],
      [
        { kind: 'type', text: '' },
        'text must contain between 1 and 4000 characters.',
      ],
      [
        { kind: 'type', text: 'x'.repeat(4_001) },
        'text must contain between 1 and 4000 characters.',
      ],
      [
        { kind: 'type', text: 'x', delayMs: -1 },
        'delayMs must be an integer between 0 and 500.',
      ],
      [
        { kind: 'type', text: 'x', delayMs: 1.5 },
        'delayMs must be an integer between 0 and 500.',
      ],
      [
        { kind: 'type', text: 'x', delayMs: 501 },
        'delayMs must be an integer between 0 and 500.',
      ],
      [
        { kind: 'type', text: 'x'.repeat(101), delayMs: 500 },
        'text is too long for this delayMs: at most 100 characters. Shorten the text or the delay.',
      ],
      [
        { kind: 'type', text: 'x'.repeat(2_001), delayMs: 6 },
        'text is too long for this delayMs: at most 2000 characters. Shorten the text or the delay.',
      ],
      [
        { kind: 'type', locator: '#search', frame: ' ', text: 'x' },
        'frame must be a non-empty string.',
      ],
    ])('rejects malformed form action payloads: %j', (command, message) => {
      expect(validateBrowserAutomationCommand(command)).toBe(message);
    });
  });
});

describe('the main validator against the shared form-control corpus', () => {
  // The agent routes validate a payload before main builds its command. Main
  // validates the command again, so the two must agree on every phase 06 case.
  const cases = browserActionCorpus.filter((entry) =>
    entry.id.startsWith('phase06-'),
  );

  it('covers every phase 06 payload in the corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(67);
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))(
    '%s gets the same verdict',
    (id, entry) => {
      // A command carries the action's fields without its type and scope.
      const scope = new Set([
        'type',
        'expectedRuntimeGeneration',
        'browserId',
        'projectId',
        'worktreeId',
      ]);
      const fields = Object.fromEntries(
        Object.entries(entry.action).filter(([key]) => !scope.has(key)),
      );
      const error = validateBrowserAutomationCommand({
        kind: entry.action.type.replace(/^browser\./, ''),
        ...fields,
      });
      if (id.startsWith('phase06-valid-')) expect(error).toBeUndefined();
      else expect(error).toEqual(expect.any(String));
    },
  );
});

describe('download wait validation', () => {
  it.each([{}, { downloadId: 'download-1' }])(
    'accepts a fifth exclusive condition: %j',
    (download) => {
      expect(
        validateBrowserAutomationCommand({ kind: 'wait_for', download }),
      ).toBeUndefined();
    },
  );
  it.each(['locator', 'text', 'url', 'loadState'])(
    'rejects download combined with %s',
    (condition) => {
      expect(
        validateBrowserAutomationCommand({
          kind: 'wait_for',
          download: {},
          [condition]: condition === 'loadState' ? 'load' : 'ready',
        }),
      ).toEqual(expect.any(String));
    },
  );
  it.each([
    null,
    [],
    'download-1',
    { downloadId: '' },
    { downloadId: ' ' },
    { downloadId: 3 },
    { other: true },
  ])('rejects a malformed download condition: %j', (download) => {
    expect(
      validateBrowserAutomationCommand({ kind: 'wait_for', download }),
    ).toEqual(expect.any(String));
  });
  it.each([{ state: 'visible' }, { frame: 'f-0' }])(
    'rejects element-only fields on download waits: %j',
    (fields) => {
      expect(
        validateBrowserAutomationCommand({
          kind: 'wait_for',
          download: {},
          ...fields,
        }),
      ).toEqual(expect.any(String));
    },
  );
});

describe('phase 08a upload payloads', () => {
  it.each([
    { kind: 'upload_files', ref: 'r-1', files: [{ path: 'exports/a.csv' }] },
    {
      kind: 'upload_files',
      locator: '#drop',
      frame: 'f-1',
      files: [{ path: 'a.csv' }, { downloadId: 'download-1' }],
      actionId: 'upload-1',
      timeoutMs: 120_000,
    },
    { kind: 'wait_for', upload: { uploadId: 'u-1' }, timeoutMs: 120_000 },
  ])('accepts %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toBeUndefined();
  });

  it.each([
    [
      { kind: 'upload_files', ref: 'r-1' },
      'files must be a list of 1 to 50 files.',
    ],
    [
      { kind: 'upload_files', ref: 'r-1', files: [] },
      'files must be a list of 1 to 50 files.',
    ],
    [
      {
        kind: 'upload_files',
        ref: 'r-1',
        files: Array.from({ length: 51 }, () => ({ path: 'a' })),
      },
      'files must be a list of 1 to 50 files.',
    ],
    [
      {
        kind: 'upload_files',
        ref: 'r-1',
        files: [{ path: 'a', downloadId: 'd' }],
      },
      'Each file needs exactly one of path, downloadId, or attachmentId.',
    ],
    [
      { kind: 'upload_files', ref: 'r-1', files: [{ path: ' ' }] },
      'Each file needs exactly one of path, downloadId, or attachmentId.',
    ],
    [
      { kind: 'upload_files', ref: 'r-1', files: [{ path: 'a', mode: 'x' }] },
      'Each file needs exactly one of path, downloadId, or attachmentId.',
    ],
    [
      { kind: 'upload_files', files: [{ path: 'a' }] },
      'Provide exactly one of ref, locator, or chooserId.',
    ],
    [
      {
        kind: 'upload_files',
        ref: 'r-1',
        files: [{ path: 'a' }],
        append: true,
      },
      'append is not supported for this command.',
    ],
    [
      {
        kind: 'upload_files',
        ref: 'r-1',
        files: [{ path: 'a' }],
        timeoutMs: 120_001,
      },
      'timeoutMs must be an integer between 1 and 120000.',
    ],
    [{ kind: 'wait_for', upload: {} }, 'uploadId must be a non-empty string.'],
    [
      { kind: 'wait_for', upload: { uploadId: 'u' }, url: '/done' },
      'wait_for requires exactly one of locator, text, url, loadState, download, or upload.',
    ],
    [
      { kind: 'wait_for', upload: { uploadId: 'u' }, frame: 'iframe' },
      'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, download, or upload.',
    ],
  ])('rejects %j', (command, message) => {
    expect(validateBrowserAutomationCommand(command)).toBe(message);
  });
});

describe('phase 08b chooser payloads', () => {
  it.each([
    { kind: 'upload_files', chooserId: 'chooser-1', files: [{ path: 'a' }] },
    { kind: 'request_files', ref: 'r-1' },
    {
      kind: 'request_files',
      locator: '#resume',
      frame: 'f-1',
      purpose: 'Your résumé',
      actionId: 'request-1',
    },
    { kind: 'request_files', chooserId: 'chooser-1' },
  ])('accepts %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toBeUndefined();
  });

  it.each([
    [
      {
        kind: 'upload_files',
        chooserId: 'chooser-1',
        ref: 'r-1',
        files: [{ path: 'a' }],
      },
      'Provide exactly one of ref, locator, or chooserId.',
    ],
    [
      { kind: 'upload_files', chooserId: ' ', files: [{ path: 'a' }] },
      'chooserId must be a non-empty string.',
    ],
    [
      {
        kind: 'upload_files',
        chooserId: 'chooser-1',
        frame: 'f-1',
        files: [{ path: 'a' }],
      },
      'browser.upload_files frame applies only to locators; a ref already identifies its frame.',
    ],
    [
      { kind: 'request_files' },
      'Provide exactly one of ref, locator, or chooserId.',
    ],
    [
      { kind: 'request_files', ref: 'r-1', chooserId: 'chooser-1' },
      'Provide exactly one of ref, locator, or chooserId.',
    ],
    [
      { kind: 'request_files', ref: 'r-1', purpose: 'x'.repeat(501) },
      'purpose must be 1 to 500 characters.',
    ],
    [
      { kind: 'request_files', ref: 'r-1', timeoutMs: 1000 },
      'timeoutMs is not supported for this command.',
    ],
    [
      { kind: 'request_files', ref: 'r-1', files: [{ path: 'a' }] },
      'files is not supported for this command.',
    ],
  ])('rejects %j', (command, message) => {
    expect(validateBrowserAutomationCommand(command)).toBe(message);
  });
});

describe('phase 08c drop and attachment payloads', () => {
  it.each([
    { kind: 'drop_files', ref: 'r-1', files: [{ path: 'exports/a.csv' }] },
    {
      kind: 'drop_files',
      locator: '#zone',
      frame: 'f-1',
      files: [{ attachmentId: 'report.csv' }, { downloadId: 'download-1' }],
      actionId: 'drop-1',
      timeoutMs: 120_000,
    },
    { kind: 'upload_files', ref: 'r-1', files: [{ attachmentId: 'a.png' }] },
  ])('accepts %j', (command) => {
    expect(validateBrowserAutomationCommand(command)).toBeUndefined();
  });

  it.each([
    [
      { kind: 'drop_files', files: [{ path: 'a' }] },
      'Provide exactly one of ref or locator.',
    ],
    [
      { kind: 'drop_files', chooserId: 'chooser-1', files: [{ path: 'a' }] },
      'chooserId is not supported for this command.',
    ],
    [
      { kind: 'drop_files', ref: 'r-1', files: [] },
      'files must be a list of 1 to 50 files.',
    ],
    [
      {
        kind: 'drop_files',
        ref: 'r-1',
        files: [{ path: 'a' }],
        timeoutMs: 120_001,
      },
      'timeoutMs must be an integer between 1 and 120000.',
    ],
    [
      {
        kind: 'upload_files',
        ref: 'r-1',
        files: [{ attachmentId: 'a.png', path: 'a.png' }],
      },
      'Each file needs exactly one of path, downloadId, or attachmentId.',
    ],
    [
      { kind: 'upload_files', ref: 'r-1', files: [{ attachmentId: ' ' }] },
      'Each file needs exactly one of path, downloadId, or attachmentId.',
    ],
  ])('rejects %j', (command, message) => {
    expect(validateBrowserAutomationCommand(command)).toBe(message);
  });
});
