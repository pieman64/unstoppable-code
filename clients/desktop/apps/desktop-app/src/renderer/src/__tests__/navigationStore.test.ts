import { useNavigationStore } from '@/stores/navigationStore';

function resetNavigationStore(): void {
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    settingsInitialSection: undefined,
    commandPaletteOpen: false,
    commandPaletteInitialQuery: '',
    fileSearchPaletteOpen: false,
    fileSearchPaletteInitialQuery: '',
    workflowEdit: undefined,
  });
}

describe('navigationStore overlay exclusivity', () => {
  beforeEach(() => {
    resetNavigationStore();
  });

  it('closes the command palette when settings opens', () => {
    useNavigationStore.getState().openCommandPalette('new worktree');

    useNavigationStore.getState().openSettings('shortcuts');

    expect(useNavigationStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsInitialSection: 'shortcuts',
      commandPaletteOpen: false,
      commandPaletteInitialQuery: '',
    });
  });

  it('closes settings when the command palette opens', () => {
    useNavigationStore.getState().openSettings('shortcuts');

    useNavigationStore.getState().openCommandPalette('new worktree');

    expect(useNavigationStore.getState()).toMatchObject({
      settingsOpen: false,
      settingsInitialSection: undefined,
      commandPaletteOpen: true,
      commandPaletteInitialQuery: 'new worktree',
    });
  });

  it('closes other overlays when the file search palette opens', () => {
    useNavigationStore.getState().openCommandPalette('something');
    useNavigationStore.getState().openSettings('shortcuts');

    useNavigationStore.getState().openFileSearchPalette('init');

    expect(useNavigationStore.getState()).toMatchObject({
      settingsOpen: false,
      settingsInitialSection: undefined,
      commandPaletteOpen: false,
      commandPaletteInitialQuery: '',
      fileSearchPaletteOpen: true,
      fileSearchPaletteInitialQuery: 'init',
    });
  });

  it('closes the file search palette when settings opens', () => {
    useNavigationStore.getState().openFileSearchPalette('init');

    useNavigationStore.getState().openSettings();

    expect(useNavigationStore.getState()).toMatchObject({
      fileSearchPaletteOpen: false,
      fileSearchPaletteInitialQuery: '',
    });
  });

  it('opens Settings → Environments for the environment section', () => {
    useNavigationStore.setState({ activePage: 'overview' });
    useNavigationStore.getState().openCommandPalette('environment');

    useNavigationStore.getState().openSettings('environment');

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'overview',
      settingsOpen: true,
      settingsInitialSection: 'environment',
      commandPaletteOpen: false,
      commandPaletteInitialQuery: '',
    });
  });

  it('treats the environments page as an alias for Settings → Environments', () => {
    useNavigationStore.setState({
      activePage: 'overview',
      settingsOpen: false,
      settingsInitialSection: undefined,
    });

    useNavigationStore.getState().navigate('environments');

    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'overview',
      settingsOpen: true,
      settingsInitialSection: 'environment',
    });
  });

  it('closes the file search palette when the command palette opens', () => {
    useNavigationStore.getState().openFileSearchPalette('init');

    useNavigationStore.getState().openCommandPalette();

    expect(useNavigationStore.getState()).toMatchObject({
      fileSearchPaletteOpen: false,
      fileSearchPaletteInitialQuery: '',
    });
  });

  it('closeFileSearchPalette only resets file search state', () => {
    useNavigationStore.getState().openSettings('shortcuts');
    useNavigationStore.getState().openFileSearchPalette('init');

    useNavigationStore.getState().closeFileSearchPalette();

    // openFileSearchPalette closed settings, so it should still be closed.
    // closeFileSearchPalette must only touch fileSearchPalette* fields.
    expect(useNavigationStore.getState()).toMatchObject({
      fileSearchPaletteOpen: false,
      fileSearchPaletteInitialQuery: '',
      settingsOpen: false,
    });
  });
});

describe('navigationStore pipeline runs', () => {
  it('has no one-slot pending run link: runs open through the panel opener', () => {
    // Every live run entry point uses `openPipelineExecutionPanel`; the old
    // main-page pending link consumed by the Activity run list is gone.
    const state: Record<string, unknown> = { ...useNavigationStore.getState() };
    expect(state).not.toHaveProperty('openPipelineExecution');
    expect(state).not.toHaveProperty('consumePipelineExecution');
    expect(state).not.toHaveProperty('pendingPipelineExecution');
  });
});
