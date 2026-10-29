/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CODEX_SPEED_USAGE_HELP,
  buildCodexSpeedChip,
  codexSpeedSelectionLabel,
  nextCodexSpeed,
  nextCodexSpeedSelection,
  type CodexSpeedChoiceStates,
} from '../CodexSpeedControl';
import { ChatComposerToolbarChip } from '../ChatComposerToolbar';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ALL_AVAILABLE: CodexSpeedChoiceStates = {
  standard: { selectable: true },
  fast: { selectable: true },
  ultrafast: { selectable: true },
};

const ULTRA_UNAVAILABLE: CodexSpeedChoiceStates = {
  standard: { selectable: true },
  fast: { selectable: true },
  ultrafast: {
    selectable: false,
    shortReason: 'Not offered for this model',
    reason:
      "This Codex connection doesn't offer Ultra fast for this model. Choose Regular or Fast.",
  },
};

describe('Codex speed labels and quick cycle', () => {
  it('names every speed, including Regular and the inherited choice', () => {
    expect(codexSpeedSelectionLabel('standard')).toBe('Regular');
    expect(codexSpeedSelectionLabel('fast')).toBe('Fast');
    expect(codexSpeedSelectionLabel('ultrafast')).toBe('Ultra fast');
    expect(codexSpeedSelectionLabel('default')).toBe('Use default');
  });

  it('cycles Regular → Fast → Ultra fast → Regular when Ultra fast can run', () => {
    expect(nextCodexSpeedSelection('standard', ALL_AVAILABLE)).toBe('fast');
    expect(nextCodexSpeedSelection('fast', ALL_AVAILABLE)).toBe('ultrafast');
    expect(nextCodexSpeedSelection('ultrafast', ALL_AVAILABLE)).toBe(
      'standard',
    );
  });

  it('skips Ultra fast when it is unavailable or unconfirmed', () => {
    expect(nextCodexSpeedSelection('fast', ULTRA_UNAVAILABLE)).toBe('standard');
    // A blocked Ultra fast selection leaves through Regular, the user's choice.
    expect(nextCodexSpeedSelection('ultrafast', ULTRA_UNAVAILABLE)).toBe(
      'standard',
    );
  });

  it('cycles runtime speeds only, for chat and Home composers', () => {
    expect(nextCodexSpeed('fast', ALL_AVAILABLE)).toBe('ultrafast');
    expect(nextCodexSpeed('fast', ULTRA_UNAVAILABLE)).toBe('standard');
    expect(nextCodexSpeed('ultrafast', ULTRA_UNAVAILABLE)).toBe('standard');
  });

  it('includes the inherited choice only for configuration composers', () => {
    const options = { includeDefault: true };
    expect(nextCodexSpeedSelection('default', ALL_AVAILABLE, options)).toBe(
      'standard',
    );
    expect(nextCodexSpeedSelection('ultrafast', ALL_AVAILABLE, options)).toBe(
      'default',
    );
    expect(nextCodexSpeedSelection('fast', ULTRA_UNAVAILABLE, options)).toBe(
      'default',
    );
  });
});

describe('buildCodexSpeedChip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderChip(
    input: Parameters<typeof buildCodexSpeedChip>[0],
  ): HTMLButtonElement | null {
    act(() =>
      root.render(<ChatComposerToolbarChip {...buildCodexSpeedChip(input)} />),
    );
    return container.querySelector('button');
  }

  it('always shows the current speed label, including Regular', () => {
    const chip = renderChip({
      selection: 'standard',
      effectiveSpeed: 'standard',
      next: 'fast',
      onClick: jest.fn(),
      dataTestId: 'speed',
    });
    expect(chip?.textContent).toBe('Regular');
    expect(chip?.getAttribute('data-testid')).toBe('speed');
  });

  it('announces the current and next speed without a boolean pressed state', () => {
    const chip = renderChip({
      selection: 'fast',
      effectiveSpeed: 'fast',
      next: 'ultrafast',
      onClick: jest.fn(),
    });
    expect(chip?.hasAttribute('aria-pressed')).toBe(false);
    expect(chip?.getAttribute('aria-label')).toBe(
      'Speed: Fast. Select to use Ultra fast.',
    );
    expect(chip?.hasAttribute('title')).toBe(false);
  });

  it('keeps a blocked Ultra fast selection visible with its reason', () => {
    const config = buildCodexSpeedChip({
      selection: 'ultrafast',
      effectiveSpeed: 'ultrafast',
      next: 'standard',
      blockedReason: ULTRA_UNAVAILABLE.ultrafast.reason,
      onClick: jest.fn(),
    });
    expect(config.label).toBe('Ultra fast');
    expect(config.activeTone).toBe('warning');
    expect(config.title).toBe(ULTRA_UNAVAILABLE.ultrafast.reason);
    expect(config.ariaLabel).toBe(
      "Speed: Ultra fast, can't run now. Select to use Regular.",
    );
  });

  it('explains usage without a fixed multiplier', () => {
    const config = buildCodexSpeedChip({
      selection: 'standard',
      effectiveSpeed: 'standard',
      next: 'fast',
      onClick: jest.fn(),
    });
    expect(config.title).toBe(CODEX_SPEED_USAGE_HELP);
    expect(CODEX_SPEED_USAGE_HELP).not.toMatch(/\dx/);
  });

  it('names the inherited speed for configuration composers', () => {
    const config = buildCodexSpeedChip({
      selection: 'default',
      effectiveSpeed: 'fast',
      next: 'standard',
      onClick: jest.fn(),
    });
    expect(config.label).toBe('Use default');
    expect(config.ariaLabel).toBe(
      'Speed: Use default (Fast). Select to use Regular.',
    );
  });

  it('names the inherited target and an unresolved inherited speed plainly', () => {
    const toDefault = buildCodexSpeedChip({
      selection: 'ultrafast',
      effectiveSpeed: 'ultrafast',
      next: 'default',
      onClick: jest.fn(),
    });
    expect(toDefault.ariaLabel).toBe(
      'Speed: Ultra fast. Select to use the default speed.',
    );
    // Pipelines inherit the run's config, which the editor cannot resolve.
    const unresolved = buildCodexSpeedChip({
      selection: 'default',
      next: 'fast',
      onClick: jest.fn(),
    });
    expect(unresolved.ariaLabel).toBe(
      'Speed: Use default. Select to use Fast.',
    );
    expect(unresolved.active).toBe(false);
  });
});
