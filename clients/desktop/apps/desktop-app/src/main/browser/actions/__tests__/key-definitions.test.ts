import {
  buildKeyEventSequence,
  isChordRefused,
  keyDefinition,
  parseKeyCombo,
  type KeyEvent,
  type ParsedKeyCombo,
} from '../key-definitions';

function combo(
  input: string,
  platform: NodeJS.Platform = 'darwin',
): ParsedKeyCombo {
  const parsed = parseKeyCombo(input, platform);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed;
}

function expectOnlyKeyDownCarriesText(
  events: KeyEvent[],
  expectedText?: string,
): void {
  for (const event of events) {
    if (event.type !== 'keyDown') expect(event).not.toHaveProperty('text');
  }
  const withText = events.filter((event) => event.text !== undefined);
  expect(withText).toHaveLength(expectedText === undefined ? 0 : 1);
  if (expectedText !== undefined)
    expect(withText[0]).toMatchObject({ type: 'keyDown', text: expectedText });
}

describe('parseKeyCombo', () => {
  it('parses Playwright chords and browser-use aliases case-insensitively', () => {
    expect(combo('Shift+Tab')).toEqual({
      ok: true,
      key: 'Tab',
      modifiers: ['Shift'],
    });
    expect(combo('cMd+OpT+Esc')).toEqual({
      ok: true,
      key: 'Escape',
      modifiers: ['Meta', 'Alt'],
    });
    expect(combo('command+return')).toEqual({
      ok: true,
      key: 'Enter',
      modifiers: ['Meta'],
    });
    expect(combo('ctrl+del', 'win32')).toEqual({
      ok: true,
      key: 'Delete',
      modifiers: ['Control'],
    });
    expect(combo('control+option+f12')).toEqual({
      ok: true,
      key: 'F12',
      modifiers: ['Control', 'Alt'],
    });
    expect(combo('Meta+Shift+K')).toEqual({
      ok: true,
      key: 'K',
      modifiers: ['Meta', 'Shift'],
    });
  });

  it.each([
    ['+', []],
    ['Control++', ['Control']],
    ['Shift++', ['Shift']],
  ])('parses literal plus in %s', (input, modifiers) => {
    expect(parseKeyCombo(String(input), 'darwin')).toEqual({
      ok: true,
      key: '+',
      modifiers,
    });
  });
  it('rejects Control+ without a main key', () => {
    expect(parseKeyCombo('Control+', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'missing_key' },
    });
  });

  it('resolves ControlOrMeta per platform', () => {
    expect(combo('ControlOrMeta+a', 'darwin').modifiers).toEqual(['Meta']);
    expect(combo('ControlOrMeta+a', 'win32').modifiers).toEqual(['Control']);
    expect(combo('ControlOrMeta+a', 'linux').modifiers).toEqual(['Control']);
  });

  it('returns typed errors for malformed and unknown combos', () => {
    expect(parseKeyCombo('', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'empty' },
    });
    expect(parseKeyCombo('Shift+', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'missing_key' },
    });
    expect(parseKeyCombo('Meta+Shift', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'missing_key' },
    });
    expect(parseKeyCombo('Meta+Meta+A', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'duplicate_modifier' },
    });
    expect(parseKeyCombo('A+B', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'multiple_keys' },
    });
    expect(parseKeyCombo('Meta+NotAKey', 'darwin')).toMatchObject({
      ok: false,
      error: { code: 'unknown_key' },
    });
  });
});

describe('keyDefinition', () => {
  it('maps named, function, letter, digit and US punctuation keys', () => {
    expect(keyDefinition('Enter')).toEqual({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    expect(keyDefinition('Tab')).not.toHaveProperty('text');
    expect(keyDefinition('F12')).toMatchObject({
      code: 'F12',
      windowsVirtualKeyCode: 123,
    });
    expect(keyDefinition('ArrowLeft')).toMatchObject({
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
    });
    expect(keyDefinition('a')).toMatchObject({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'a',
    });
    expect(keyDefinition('7')).toMatchObject({
      code: 'Digit7',
      windowsVirtualKeyCode: 55,
      text: '7',
    });
    expect(keyDefinition('?')).toMatchObject({
      code: 'Slash',
      windowsVirtualKeyCode: 191,
      text: '?',
    });
    expect(keyDefinition('Space')).toMatchObject({
      key: ' ',
      code: 'Space',
      text: ' ',
    });
  });

  it('falls back for an unknown single character', () => {
    expect(keyDefinition('é')).toEqual({
      key: 'é',
      code: 'é',
      windowsVirtualKeyCode: 0,
      text: 'é',
    });
    expect(combo('😀').key).toBe('😀');
  });
});

describe('buildKeyEventSequence', () => {
  // A separate char event is inserted even when the page cancels the keydown,
  // so an editor that handles Enter itself got a second line break.
  it('sends Enter as a keyDown carrying a carriage return, and Tab without text', () => {
    const enter = buildKeyEventSequence(combo('Enter'), 'darwin');
    expect(enter.map((item) => item.type)).toEqual(['keyDown', 'keyUp']);
    expect(enter[0]).toMatchObject({
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      modifiers: 0,
    });
    expectOnlyKeyDownCarriesText(enter, '\r');
    const tab = buildKeyEventSequence(combo('Tab'), 'darwin');
    expect(tab.map((item) => item.type)).toEqual(['rawKeyDown', 'keyUp']);
    expectOnlyKeyDownCarriesText(tab);
  });

  it('sends lower- and upper-case letters as a keyDown carrying their text', () => {
    const lower = buildKeyEventSequence(combo('a'), 'linux');
    expect(lower.map((item) => item.type)).toEqual(['keyDown', 'keyUp']);
    expect(lower[0]).toMatchObject({
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
    });
    expectOnlyKeyDownCarriesText(lower, 'a');
    expect(lower[0]).not.toHaveProperty('unmodifiedText');
    const upper = buildKeyEventSequence(combo('Shift+a'), 'linux');
    expect(upper.map((item) => item.type)).toEqual([
      'rawKeyDown',
      'keyDown',
      'keyUp',
      'keyUp',
    ]);
    expect(upper[1]).toMatchObject({
      key: 'A',
      text: 'A',
      unmodifiedText: 'a',
      modifiers: 8,
    });
    expectOnlyKeyDownCarriesText(upper, 'A');
    const capital = buildKeyEventSequence(combo('A'), 'linux');
    expect(capital[0]).toMatchObject({ key: 'A' });
    expectOnlyKeyDownCarriesText(capital, 'A');
    const symbol = buildKeyEventSequence(combo('Shift+1'), 'linux');
    expect(symbol[1]).toMatchObject({
      key: '!',
      code: 'Digit1',
      text: '!',
      unmodifiedText: '1',
    });
    expectOnlyKeyDownCarriesText(symbol, '!');
  });

  // Chromium turns a nonzero native key code into a real NSEvent, which macOS
  // offers to the app menu when the page does not handle it. Agent typing
  // then ran app menu items, resizing the window.
  it.each(['darwin', 'win32', 'linux'] as NodeJS.Platform[])(
    'never sends a native key code on %s',
    (platform) => {
      for (const input of [
        'a',
        'Shift+a',
        'Enter',
        'Tab',
        'é',
        'Control+Alt+F12',
        'Meta+A',
      ])
        for (const event of buildKeyEventSequence(
          combo(input, platform),
          platform,
        ))
          expect(event).not.toHaveProperty('nativeVirtualKeyCode');
    },
  );

  it('sends Shift+Tab without text', () => {
    const events = buildKeyEventSequence(combo('Shift+Tab'), 'darwin');
    expect(
      events.map((item) => [item.type, item.code, item.modifiers]),
    ).toEqual([
      ['rawKeyDown', 'ShiftLeft', 8],
      ['rawKeyDown', 'Tab', 8],
      ['keyUp', 'Tab', 8],
      ['keyUp', 'ShiftLeft', 0],
    ]);
    expectOnlyKeyDownCarriesText(events);
  });

  it.each(['win32', 'linux'] as NodeJS.Platform[])(
    'sends Control+A as a raw chord on %s',
    (platform) => {
      const events = buildKeyEventSequence(
        combo('Control+A', platform),
        platform,
      );
      expect(events.map((item) => item.type)).toEqual([
        'rawKeyDown',
        'rawKeyDown',
        'keyUp',
        'keyUp',
      ]);
      expect(events[1]).toMatchObject({ code: 'KeyA', modifiers: 2 });
      expect(events[1]).not.toHaveProperty('text');
      expect(events[2]).not.toHaveProperty('text');
      expect(events[1]).not.toHaveProperty('commands');
      expectOnlyKeyDownCarriesText(events);
    },
  );

  it('adds macOS Chromium editing commands to Meta+A', () => {
    const events = buildKeyEventSequence(combo('Meta+A'), 'darwin');
    expect(events[1]).toMatchObject({
      type: 'rawKeyDown',
      code: 'KeyA',
      modifiers: 4,
      commands: ['selectAll'],
    });
    expect(events.map((item) => item.type)).toEqual([
      'rawKeyDown',
      'rawKeyDown',
      'keyUp',
      'keyUp',
    ]);
    expectOnlyKeyDownCarriesText(events);
    expect(
      buildKeyEventSequence(combo('Meta+Shift+Z'), 'darwin')[2].commands,
    ).toEqual(['redo']);
    expect(
      buildKeyEventSequence(combo('Alt+Backspace'), 'darwin')[1].commands,
    ).toEqual(['deleteWordBackward']);
    expect(
      buildKeyEventSequence(combo('Shift+Alt+ArrowRight'), 'darwin')[2]
        .commands,
    ).toEqual(['moveWordRightAndModifySelection']);
  });

  it('releases multiple modifiers in reverse order with declining masks', () => {
    const events = buildKeyEventSequence(
      combo('Control+Alt+Shift+X', 'linux'),
      'linux',
    );
    expect(
      events.map((item) => [item.type, item.code, item.modifiers]),
    ).toEqual([
      ['rawKeyDown', 'ControlLeft', 2],
      ['rawKeyDown', 'AltLeft', 3],
      ['rawKeyDown', 'ShiftLeft', 11],
      ['rawKeyDown', 'KeyX', 11],
      ['keyUp', 'KeyX', 11],
      ['keyUp', 'ShiftLeft', 3],
      ['keyUp', 'AltLeft', 2],
      ['keyUp', 'ControlLeft', 0],
    ]);
    expectOnlyKeyDownCarriesText(events);
  });
});

describe('isChordRefused', () => {
  it.each(['darwin', 'win32', 'linux'] as NodeJS.Platform[])(
    'refuses paste chords on %s',
    (platform) => {
      for (const input of [
        'Meta+V',
        'Control+V',
        'Meta+Shift+V',
        'Control+Shift+V',
        'Shift+Insert',
      ]) {
        expect(isChordRefused(combo(input, platform), platform)).toMatch(
          /Paste/,
        );
      }
    },
  );

  it('refuses macOS app browser shortcuts, but not unmapped chords', () => {
    for (const input of [
      'Meta+T',
      'Meta+L',
      'Meta+B',
      'Meta+ArrowLeft',
      'Meta+ArrowRight',
    ]) {
      expect(isChordRefused(combo(input), 'darwin')).toMatch(
        /App browser shortcut/,
      );
    }
    expect(isChordRefused(combo('T'), 'darwin')).toBeNull();
    expect(isChordRefused(combo('Shift+Meta+T'), 'darwin')).toBeNull();
  });

  it.each(['win32', 'linux'] as NodeJS.Platform[])(
    'refuses mapped browser shortcuts on %s',
    (platform) => {
      for (const input of [
        'Control+T',
        'Control+L',
        'Control+B',
        'Alt+ArrowLeft',
        'Alt+ArrowRight',
      ]) {
        expect(isChordRefused(combo(input, platform), platform)).toMatch(
          /App browser shortcut/,
        );
      }
      expect(
        isChordRefused(combo('Control+ArrowLeft', platform), platform),
      ).toBeNull();
    },
  );
});
