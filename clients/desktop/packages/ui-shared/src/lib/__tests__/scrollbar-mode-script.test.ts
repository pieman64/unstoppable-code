/**
 * @jest-environment jsdom
 */
import { buildScrollbarModeScript } from '../scrollbar-mode-script';

/** Runs the inline script as the browser would: a blocking script in body. */
function runScript(): void {
  const script = document.createElement('script');
  script.textContent = buildScrollbarModeScript();
  document.body.appendChild(script);
  script.remove();
}

function stubNativeScrollbarWidth(width: number): () => void {
  const offset = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  const client = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'clientWidth',
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 100,
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => 100 - width,
  });
  return (): void => {
    if (offset)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
    if (client) Object.defineProperty(Element.prototype, 'clientWidth', client);
  };
}

afterEach(() => {
  const root = document.documentElement;
  delete root.dataset.scrollbars;
  delete root.dataset.scrollbarBehavior;
  root.style.removeProperty('--canopy-native-scrollbar-width');
});

describe('buildScrollbarModeScript', () => {
  it('publishes "always" with the native width when scrollbars take space', () => {
    const restore = stubNativeScrollbarWidth(15);
    try {
      runScript();
    } finally {
      restore();
    }
    const root = document.documentElement;
    expect(root.dataset.scrollbars).toBe('always');
    expect(root.style.getPropertyValue('--canopy-native-scrollbar-width')).toBe(
      '15px',
    );
    // The probe never stays in the document.
    expect(document.querySelector('[data-native-scrollbar-probe]')).toBeNull();
  });

  it('publishes "overlay" when scrollbars overlay content', () => {
    const restore = stubNativeScrollbarWidth(0);
    try {
      runScript();
    } finally {
      restore();
    }
    expect(document.documentElement.dataset.scrollbars).toBe('overlay');
    expect(
      document.documentElement.style.getPropertyValue(
        '--canopy-native-scrollbar-width',
      ),
    ).toBe('');
  });

  it.each([
    ['always', 'always'],
    ['scroll', 'overlay'],
    ['hover', 'overlay'],
    ['never', 'overlay'],
  ])(
    'follows an explicit "%s" preference without probing',
    (behavior, mode) => {
      document.documentElement.dataset.scrollbarBehavior = behavior;
      const append = jest.spyOn(document.body, 'appendChild');
      runScript();
      expect(document.documentElement.dataset.scrollbars).toBe(mode);
      const probes = append.mock.calls.filter(
        ([node]) =>
          node instanceof Element &&
          node.hasAttribute('data-native-scrollbar-probe'),
      );
      expect(probes).toEqual([]);
      append.mockRestore();
    },
  );
});
