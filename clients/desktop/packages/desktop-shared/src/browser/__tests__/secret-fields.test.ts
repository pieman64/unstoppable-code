import {
  INSPECT_RESOLVER_KEY,
  PASSWORD_HISTORY_RESOLVER_KEY,
  SECRET_AUTOCOMPLETE_TOKENS,
  classifySecretField,
  isSecretAutocomplete,
} from '../secret-fields';

const EXPECTED_SECRET_AUTOCOMPLETE_TOKENS = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
];

describe('secret autocomplete classification', () => {
  it('exports the exact secret autocomplete token set', () => {
    expect(new Set(SECRET_AUTOCOMPLETE_TOKENS)).toEqual(
      new Set(EXPECTED_SECRET_AUTOCOMPLETE_TOKENS),
    );
  });

  it.each(EXPECTED_SECRET_AUTOCOMPLETE_TOKENS)(
    'recognizes the %s token',
    (token) => {
      expect(isSecretAutocomplete(token)).toBe(true);
    },
  );

  it('matches lowercased tokens split across whitespace', () => {
    expect(
      isSecretAutocomplete('  CURRENT-PASSWORD\tcc-NUMBER\ncc-csc  '),
    ).toBe(true);
    expect(isSecretAutocomplete('text email username')).toBe(false);
  });

  it('does not classify whitespace-only values or comma-delimited tokens', () => {
    expect(isSecretAutocomplete(' \t\n  ')).toBe(false);
    expect(isSecretAutocomplete('current-password,one-time-code')).toBe(false);
  });

  it('requires complete tokens rather than matching token substrings', () => {
    expect(
      isSecretAutocomplete(
        'x-current-password current-password-extra cc-numberish new-passwordx',
      ),
    ).toBe(false);
  });

  it.each([null, undefined, ''])('handles empty autocomplete %s', (value) => {
    expect(isSecretAutocomplete(value)).toBe(false);
  });
});

describe('secret field classification', () => {
  it.each(['input', 'textarea', 'select'])(
    'treats omitted and null type/autocomplete as non-secret for %s',
    (tagName) => {
      for (const type of [undefined, null]) {
        for (const autocomplete of [undefined, null]) {
          expect(
            classifySecretField({
              tagName,
              type,
              autocomplete,
              insideSecretSelect: false,
              everPassword: false,
            }),
          ).toBe(false);
        }
      }
    },
  );

  it('classifies an element inside a secret select regardless of its tag', () => {
    expect(
      classifySecretField({
        tagName: 'OPTION',
        insideSecretSelect: true,
        everPassword: false,
      }),
    ).toBe(true);
    expect(
      classifySecretField({
        tagName: 'div',
        insideSecretSelect: true,
        everPassword: false,
      }),
    ).toBe(true);
  });

  it('classifies current and historical password inputs', () => {
    expect(
      classifySecretField({
        tagName: 'INPUT',
        type: 'PASSWORD',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(true);
    expect(
      classifySecretField({
        tagName: 'input',
        type: 'text',
        insideSecretSelect: false,
        everPassword: true,
      }),
    ).toBe(true);
  });

  it('uses autocomplete only for input, textarea, and select elements', () => {
    for (const tagName of ['input', 'textarea', 'select']) {
      expect(
        classifySecretField({
          tagName,
          autocomplete: 'ONE-TIME-CODE',
          insideSecretSelect: false,
          everPassword: false,
        }),
      ).toBe(true);
    }

    for (const tagName of ['button', 'option', 'div', 'form']) {
      expect(
        classifySecretField({
          tagName,
          autocomplete: 'current-password',
          insideSecretSelect: false,
          everPassword: false,
        }),
      ).toBe(false);
    }
  });

  it('classifies every secret autocomplete token on each supported control', () => {
    for (const tagName of ['input', 'textarea', 'select']) {
      for (const autocomplete of EXPECTED_SECRET_AUTOCOMPLETE_TOKENS) {
        expect(
          classifySecretField({
            tagName,
            autocomplete,
            insideSecretSelect: false,
            everPassword: false,
          }),
        ).toBe(true);
      }
    }
  });

  it('does not apply password history to non-input elements', () => {
    expect(
      classifySecretField({
        tagName: 'textarea',
        type: 'password',
        insideSecretSelect: false,
        everPassword: true,
      }),
    ).toBe(false);
  });

  it('normalizes tag and type case like the DOM', () => {
    expect(
      classifySecretField({
        tagName: 'InPuT',
        type: 'PaSsWoRd',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(true);
    expect(
      classifySecretField({
        tagName: 'input',
        type: ' password ',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(false);
    expect(
      classifySecretField({
        tagName: 'TeXtArEa',
        autocomplete: 'cc-number',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(true);
  });

  it('does not mark ordinary form fields or unsupported tags as secret', () => {
    expect(
      classifySecretField({
        tagName: 'input',
        type: 'text',
        autocomplete: 'username',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(false);
    expect(
      classifySecretField({
        tagName: 'button',
        type: 'password',
        insideSecretSelect: false,
        everPassword: false,
      }),
    ).toBe(false);
  });
});

describe('secret field resolver keys', () => {
  it('exports stable versioned resolver key names', () => {
    expect(PASSWORD_HISTORY_RESOLVER_KEY).toBe(
      '__canopyBrowserPasswordHistoryResolver_v1',
    );
    expect(INSPECT_RESOLVER_KEY).toBe('__canopyBrowserInspectResolver_v1');
  });
});
