/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/desktop-shared/types/plugins';
import type { ShareablePluginRef } from '@canopy/desktop-shared/plugin-refs';
import type {
  UnifiedTableRow,
  UseUnifiedTableDataReturn,
} from '@/hooks/useUnifiedTableData';

// Mock the data hook so we can hand the selector a deterministic row set
// without spinning up the marketplace IPC.
jest.mock('@/hooks/useUnifiedTableData', (): Record<string, unknown> => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/hooks/useUnifiedTableData',
  );
  return {
    ...actual,
    useUnifiedTableData: jest.fn(),
  };
});

import { ShareablePluginSelector } from '../ShareablePluginSelector';
import { useUnifiedTableData } from '@/hooks/useUnifiedTableData';

const mockUseUnifiedTableData =
  useUnifiedTableData as unknown as jest.MockedFunction<
    () => UseUnifiedTableDataReturn
  >;

const BUILT_IN_REF: ShareablePluginRef = {
  type: 'claude_plugin',
  marketplace: { type: 'builtin', id: 'app' },
  plugin_name: 'Built-in Plugin',
};

const PROVIDER_NEUTRAL_BUILT_IN_REF: ShareablePluginRef = {
  ...BUILT_IN_REF,
  type: 'plugin',
};

function makeBuiltInPluginRow(): UnifiedTableRow {
  const support: PluginProviderSupport = { claude: 'native', codex: 'native' };
  const original: PluginInfo = {
    name: 'Built-in Plugin',
    sourcePath: 'plugins/built-in',
    marketplaceId: 'builtin/app',
    builtIn: true,
    providerSupport: support,
    facets: {},
  };
  return {
    rowOrigin: 'catalog',
    kind: 'plugin',
    key: 'builtin/app/Built-in Plugin',
    name: 'Built-in Plugin',
    description: '',
    source: 'Canopy (built-in)',
    sourceSubtitle: 'Canopy Marketplace',
    sourceIcon: 'app',
    lastUpdated: '2026-05-01T00:00:00.000Z',
    original,
    shareableRef: BUILT_IN_REF,
    providerSupport: support,
  };
}

function makeProviderNeutralBuiltInPluginRow(): UnifiedTableRow {
  return {
    ...makeBuiltInPluginRow(),
    shareableRef: PROVIDER_NEUTRAL_BUILT_IN_REF,
  };
}

function requireCheckbox(
  node: Element | null,
  label: string,
): HTMLInputElement {
  if (!(node instanceof HTMLInputElement) || node.type !== 'checkbox') {
    throw new Error(`${label} not found or not a checkbox`);
  }
  return node;
}

describe('ShareablePluginSelector built-in plugins', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockUseUnifiedTableData.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('mentions built-in plugins in the default helper text', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <ShareablePluginSelector selections={[]} onChange={jest.fn()} />,
      );
    });
    expect(container.textContent).toContain(
      'Built-in and GitHub marketplace plugins are shareable',
    );
  });

  it('offers a catalog built-in plugin as a selectable shareable row', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [makeBuiltInPluginRow()],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    act(() => {
      root.render(
        <ShareablePluginSelector selections={[]} onChange={onChange} />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select Built-in Plugin"]',
      ),
      'Built-in plugin checkbox',
    );
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).toContain('Built-in Plugin');

    act(() => {
      checkbox.click();
    });
    expect(onChange).toHaveBeenCalledWith([BUILT_IN_REF]);
  });

  it('preserves a built-in selection that is missing from the local catalog', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <ShareablePluginSelector
          selections={[BUILT_IN_REF]}
          onChange={jest.fn()}
        />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select Built-in Plugin"]',
      ),
      'Missing built-in plugin checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(container.textContent).toContain('Built-in Plugin');
  });

  it('matches legacy selected plugin refs to provider-neutral catalog rows', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [makeProviderNeutralBuiltInPluginRow()],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    act(() => {
      root.render(
        <ShareablePluginSelector
          selections={[BUILT_IN_REF]}
          onChange={onChange}
        />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select Built-in Plugin"]',
      ),
      'Built-in plugin checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(container.textContent).not.toContain('Missing locally');

    act(() => {
      checkbox.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('renders only locked selected rows in manifest mode', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [makeBuiltInPluginRow()],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    act(() => {
      root.render(
        <ShareablePluginSelector
          selections={[BUILT_IN_REF]}
          onChange={onChange}
          manifestOnly
        />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select Built-in Plugin"]',
      ),
      'Built-in plugin checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    act(() => checkbox.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides unselected catalog rows in manifest mode', () => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [makeBuiltInPluginRow()],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <ShareablePluginSelector
          selections={[]}
          onChange={jest.fn()}
          manifestOnly
        />,
      );
    });

    expect(container.textContent).not.toContain('Built-in Plugin');
  });
});
