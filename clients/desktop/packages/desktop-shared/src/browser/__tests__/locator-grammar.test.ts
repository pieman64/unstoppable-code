import {
  parseLocator,
  parseSemanticLocator,
  parseTestIdLocator,
  UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
  type ParsedLocator,
} from '../locator-grammar';

const unsupported: { kind: 'invalid'; message: string } = {
  kind: 'invalid',
  message:
    'Unsupported Playwright-like locator. Supported forms are page.locator(string), page.getByTestId(string), page.getByRole(role, { name: string }), page.getByLabel(string), page.getByPlaceholder(string), page.getByAltText(string), and page.getByText(string, { exact: true }). Use browser.input_snapshot for reusable refs.',
};

describe('parseLocator', () => {
  const cases: Array<{ locator: string; expected: ParsedLocator }> = [
    {
      locator: '#submit',
      expected: { kind: 'css', selector: '#submit', explicit: false },
    },
    {
      locator: '  button.primary  ',
      expected: { kind: 'css', selector: 'button.primary', explicit: false },
    },
    { locator: '', expected: { kind: 'css', selector: '', explicit: false } },
    {
      locator: '   ',
      expected: { kind: 'css', selector: '', explicit: false },
    },
    {
      locator: "page.locator('#submit')",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      // The preload falls back to a trailing getByTestId when the CSS matches nothing.
      locator: "page.locator('#none').getByTestId('save')",
      expected: {
        kind: 'css',
        selector: '#none',
        explicit: true,
        testIdFallback: 'save',
      },
    },
    {
      locator: "locator('#submit')",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      locator: "page.locator(  '#submit')",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      locator: "prefix locator('#submit') suffix",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      locator: "page.locator('#submit'",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      locator: "page.locator('#submit') trailing text",
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      // E5: a string literal, closed by its own delimiter (was cut to 'a').
      locator: "page.locator('a\"b')",
      expected: { kind: 'css', selector: 'a"b', explicit: true },
    },
    {
      locator: 'page.locator(\'[data-testid="x"]\')',
      expected: { kind: 'css', selector: '[data-testid="x"]', explicit: true },
    },
    {
      locator: 'page.locator("[data-testid=\'x\']")',
      expected: { kind: 'css', selector: "[data-testid='x']", explicit: true },
    },
    {
      locator: "page.locator('a[title=\\'x\\']')",
      expected: { kind: 'css', selector: "a[title='x']", explicit: true },
    },
    {
      // Other escapes, as in CSS, are kept.
      locator: "page.locator('#a\\:b')",
      expected: { kind: 'css', selector: '#a\\:b', explicit: true },
    },
    {
      locator: "page.frameLocator('#f').locator('[data-testid=\"x\"]')",
      expected: {
        kind: 'frame',
        frameSelector: '#f',
        inner: { kind: 'css', selector: '[data-testid="x"]', explicit: true },
      },
    },
    {
      locator: 'css=#submit',
      expected: { kind: 'css', selector: '#submit', explicit: true },
    },
    {
      locator: 'css=',
      expected: { kind: 'css', selector: '', explicit: true },
    },
    {
      locator: 'css=   ',
      expected: { kind: 'css', selector: '', explicit: true },
    },
    {
      locator: "page.getByTestId('save-button')",
      expected: { kind: 'testId', value: 'save-button' },
    },
    {
      locator: 'getByTestId("save-button") trailing',
      expected: { kind: 'testId', value: 'save-button' },
    },
    {
      locator: "prefix getByTestId('save-button') suffix",
      expected: { kind: 'testId', value: 'save-button' },
    },
    {
      locator: "page.getByRole('button')",
      expected: { kind: 'role', role: 'button' },
    },
    {
      locator: "getByRole(  'button', { name: 'Save changes' })",
      expected: { kind: 'role', role: 'button', name: 'Save changes' },
    },
    {
      locator: "page.getByRole('button', { name: 'Save changes'",
      expected: { kind: 'role', role: 'button', name: 'Save changes' },
    },
    {
      locator: "page.getByRole('button', { name: '' })",
      expected: { kind: 'role', role: 'button' },
    },
    {
      locator: "page.getByRole('button') unrelated name: 'Global name'",
      expected: { kind: 'role', role: 'button', name: 'Global name' },
    },
    {
      locator: "page.getByAltText('Canopy logo')",
      expected: { kind: 'alt', value: 'Canopy logo' },
    },
    {
      locator: 'page.getByAltText(\'mismatched")',
      expected: { kind: 'alt', value: 'mismatched' },
    },
    {
      locator: "page.getByAltText('incomplete'",
      expected: { kind: 'alt', value: 'incomplete' },
    },
    {
      locator: "getByAltText( 'Canopy logo' trailing",
      expected: { kind: 'alt', value: 'Canopy logo' },
    },
    {
      locator: "page.getByPlaceholder('Email address') trailing",
      expected: { kind: 'placeholder', value: 'Email address' },
    },
    {
      locator: "getByLabel('Email') trailing",
      expected: { kind: 'label', value: 'Email' },
    },
    {
      locator: "page.getByText('Save changes') trailing",
      expected: { kind: 'text', value: 'Save changes' },
    },
    {
      locator: "page.getByText('NCR', { exact: true })",
      expected: { kind: 'text', value: 'NCR', exact: true },
    },
    {
      locator: 'page.getByText("NCR", { exact: false })',
      expected: { kind: 'text', value: 'NCR' },
    },
    { locator: 'text=Search', expected: { kind: 'text', value: 'Search' } },
    {
      locator: 'text=',
      expected: { kind: 'css', selector: 'text=', explicit: false },
    },
    {
      locator: "page.frameLocator('iframe').locator('button')",
      expected: {
        kind: 'frame',
        frameSelector: 'iframe',
        inner: { kind: 'css', selector: 'button', explicit: true },
      },
    },
    {
      locator:
        'frameLocator("iframe[name=\\\"editor\\\"]").getByRole("textbox", { name: "Name" })',
      expected: {
        kind: 'frame',
        frameSelector: 'iframe[name="editor"]',
        inner: { kind: 'role', role: 'textbox', name: 'Name' },
      },
    },
    {
      locator:
        "page.frameLocator('iframe').frameLocator('iframe.inner').getByLabel('Name')",
      expected: {
        kind: 'frame',
        frameSelector: 'iframe',
        inner: {
          kind: 'frame',
          frameSelector: 'iframe.inner',
          inner: { kind: 'label', value: 'Name' },
        },
      },
    },
    {
      locator:
        "page.frameLocator('iframe').page.frameLocator('iframe.inner').page.getByRole('button')",
      expected: {
        kind: 'frame',
        frameSelector: 'iframe',
        inner: {
          kind: 'frame',
          frameSelector: 'iframe.inner',
          inner: { kind: 'role', role: 'button' },
        },
      },
    },
    {
      locator: "page.frameLocator('iframe').locator('button'",
      expected: {
        kind: 'frame',
        frameSelector: 'iframe',
        inner: { kind: 'css', selector: 'button', explicit: true },
      },
    },
  ];

  for (const { locator, expected } of cases) {
    it(`parses ${JSON.stringify(locator)}`, () => {
      expect(parseLocator(locator)).toEqual(expected);
    });
  }

  it('preserves legacy precedence between explicit CSS, helper locators, and raw CSS', () => {
    expect(
      parseLocator("page.locator('#missing') getByTestId('save')"),
    ).toEqual({
      kind: 'css',
      selector: '#missing',
      explicit: true,
      testIdFallback: 'save',
    });
    expect(parseLocator("getByTestId('save') locator('#fallback')")).toEqual({
      kind: 'css',
      selector: '#fallback',
      explicit: true,
      testIdFallback: 'save',
    });
    expect(parseLocator("getByTestId('save')")).toEqual({
      kind: 'testId',
      value: 'save',
    });
    expect(parseLocator('button')).toEqual({
      kind: 'css',
      selector: 'button',
      explicit: false,
    });
  });

  it.each([
    "page.locator('')",
    "page.getByTestId('')",
    "page.getByRole('')",
    "page.getByAltText('')",
    "page.getByPlaceholder('')",
    "page.getByLabel('')",
    "page.getByText('')",
    "page.getByTestId('save'",
    "page.getByPlaceholder('Email'",
    "page.getByLabel('Email'",
    "page.getByText('Search'",
    "page.getByPlaceholder( 'Email')",
    "page.getByLabel( 'Email')",
    "page.getByText( 'Search')",
    "page.getByFoo('x')",
    "page.locator ('#submit')",
    "page.locator('#submit",
    'page.locator(\'#a")',
    "page.frameLocator('iframe')",
    "page.frameLocator('iframe').",
    "page.frameLocator ('iframe').locator('button')",
    "frameLocator ('iframe').locator('button')",
    "page.frameLocator(iframe).locator('button')",
    "page.frameLocator('iframe'.locator('button')",
    "frameLocator('iframe').",
  ])('returns the exact unsupported result for %s', (locator) => {
    expect(parseLocator(locator)).toEqual(unsupported);
  });

  it('requires frame locators to be anchored, quoted, and followed by an inner locator', () => {
    expect(
      parseLocator("prefix page.frameLocator('iframe').locator('button')"),
    ).toEqual({
      kind: 'css',
      selector: 'button',
      explicit: true,
    });
    expect(parseLocator("frameLocator('iframe').locator('button')")).toEqual({
      kind: 'frame',
      frameSelector: 'iframe',
      inner: { kind: 'css', selector: 'button', explicit: true },
    });
  });

  it('uses the exported legacy unsupported message', () => {
    expect(unsupported.message).toBe(UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE);
    expect(parseLocator("page.getByFoo('x')")).toEqual({
      kind: 'invalid',
      message: UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
    });
  });
});

describe('parseTestIdLocator', () => {
  it.each([
    ["page.getByTestId('save')", 'save'],
    ['prefix getByTestId("save-button") suffix', 'save-button'],
    ["css=#missing getByTestId('x')", 'x'],
    ["page.locator('#missing').getByTestId('x')", 'x'],
    ["getByTestId('mixed\"quote')", 'mixed"quote'],
    ['getByTestId(\'mismatched")', 'mismatched'],
  ])('parses the legacy test-id form %s', (locator, value) => {
    expect(parseTestIdLocator(locator)).toBe(value);
  });

  it.each([
    "getByTestId('')",
    "getByTestId( 'save')",
    "getByTestId ('save')",
    "getByTestId('save'",
  ])('does not parse the legacy test-id form %s', (locator) => {
    expect(parseTestIdLocator(locator)).toBeUndefined();
  });
});

describe('parseSemanticLocator', () => {
  it.each([
    ["page.getByRole('button')", { kind: 'role', role: 'button' }],
    ["page.getByAltText('Logo')", { kind: 'alt', value: 'Logo' }],
    ['page.getByAltText(\'mismatched")', { kind: 'alt', value: 'mismatched' }],
    ["page.getByAltText('incomplete'", { kind: 'alt', value: 'incomplete' }],
    ["page.getByPlaceholder('Email')", { kind: 'placeholder', value: 'Email' }],
    ["page.getByLabel('Name')", { kind: 'label', value: 'Name' }],
    ["page.getByText('Search')", { kind: 'text', value: 'Search' }],
    ['text=Search', { kind: 'text', value: 'Search' }],
  ])('extracts semantic locator %s', (locator, expected) => {
    expect(parseSemanticLocator(locator)).toEqual(expected);
  });

  it('scans the original string for semantic fallback while ignoring CSS and test-id forms', () => {
    expect(
      parseSemanticLocator("page.locator('#missing') getByRole('button')"),
    ).toEqual({ kind: 'role', role: 'button' });
    expect(parseSemanticLocator("page.locator('#missing')")).toBeUndefined();
    expect(parseSemanticLocator('css=#missing')).toBeUndefined();
    expect(parseSemanticLocator("page.getByTestId('missing')")).toBeUndefined();
  });

  it('keeps semantic priority and the global role-name regex behavior', () => {
    expect(
      parseSemanticLocator(
        "page.getByRole('button') getByAltText('Logo') name: 'Global name'",
      ),
    ).toEqual({ kind: 'role', role: 'button', name: 'Global name' });
  });

  it.each([
    "page.getByPlaceholder('Email'",
    "page.getByLabel('Name'",
    "page.getByText('Search'",
    "page.getByPlaceholder( 'Email')",
    "page.getByLabel( 'Name')",
    "page.getByText( 'Search')",
    'text=',
  ])('does not recognize incomplete or empty semantic forms %s', (locator) => {
    expect(parseSemanticLocator(locator)).toBeUndefined();
  });
});
