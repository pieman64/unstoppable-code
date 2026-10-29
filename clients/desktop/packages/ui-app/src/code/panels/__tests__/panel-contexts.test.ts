import {
  auxPanelHostState,
  DEFAULT_PANEL_HOST_STATE,
  type PanelHostState,
} from '../panel-contexts';

describe('auxPanelHostState', () => {
  it('never passes the main page’s hidden state to an auxiliary window', () => {
    const onOpenSettingsTab = jest.fn();
    const hidden: PanelHostState = {
      viewMode: 'kanban',
      viewModeReady: true,
      visible: false,
      onOpenSettingsTab,
    };
    const aux = auxPanelHostState(hidden);
    expect(aux).toEqual({
      viewMode: 'kanban',
      viewModeReady: true,
      visible: true,
      onOpenSettingsTab,
    });
    // Stable identity per input, so context consumers do not rerender.
    expect(auxPanelHostState(hidden)).toBe(aux);
  });

  it('returns a visible or unspecified host state unchanged', () => {
    const visible: PanelHostState = {
      ...DEFAULT_PANEL_HOST_STATE,
      visible: true,
    };
    expect(auxPanelHostState(visible)).toBe(visible);
    expect(auxPanelHostState(DEFAULT_PANEL_HOST_STATE)).toBe(
      DEFAULT_PANEL_HOST_STATE,
    );
  });
});
