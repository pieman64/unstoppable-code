import { buildComposerCommands, getComposerAction } from '../composerCommands';

describe('composer capability catalog', () => {
  it('keeps provider commands distinct from composer actions and groups plugin members', () => {
    const providerPlan = {
      name: 'plan',
      description: 'Provider plan',
      insertText: '/plan ',
    };
    const commands = buildComposerCommands(
      [
        providerPlan,
        { name: 'linear:create-issue', description: 'Create a ticket' },
      ],
      { home: false },
    );
    const plans = commands.filter((command) => command.name === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans.map(getComposerAction)).toEqual([null, 'plan']);
    expect(commands.some((command) => command.browseNamespace)).toBe(false);
    expect(
      commands.find((command) => command.name === 'linear:create-issue')
        ?.namespace,
    ).toBe('linear');
    expect(
      commands.find((command) => command.name === 'workspace')?.disabledReason,
    ).toBeTruthy();
  });
  it('offers workspace and fast controls only when the host supports them', () => {
    const commands = buildComposerCommands([], { home: true, fast: true });
    expect(
      commands.find((command) => command.name === 'workspace')?.disabledReason,
    ).toBeUndefined();
    expect(
      commands.find((command) => command.name === 'fast')?.disabledReason,
    ).toBeUndefined();
    expect(
      getComposerAction({ name: 'constructor', description: '' }),
    ).toBeNull();
  });

  it('describes /fast as the Codex speed cycle rather than a boolean toggle', () => {
    const offered = buildComposerCommands([], { home: false, fast: true });
    const fast = offered.find((command) => command.name === 'fast');
    expect(fast?.description).toBe('Cycle the Codex speed');
    expect(fast?.description).not.toMatch(/toggle/i);
    const unavailable = buildComposerCommands([], { home: false, fast: false });
    expect(
      unavailable.find((command) => command.name === 'fast')?.disabledReason,
    ).toBe('Speed options are available for Codex models.');
  });

  it('omits actions that a configuration host cannot perform', () => {
    const commands = buildComposerCommands(
      [{ name: 'project-skill', description: 'Project skill' }],
      {
        home: false,
        fast: true,
        supportedActions: ['plugins', 'model', 'thinking', 'fast', 'plan'],
      },
    );

    expect(commands.filter(getComposerAction).map(getComposerAction)).toEqual([
      'plugins',
      'model',
      'thinking',
      'plan',
      'fast',
    ]);
    expect(commands.some((command) => command.name === 'project-skill')).toBe(
      true,
    );
    expect(commands.some((command) => command.name === 'attach')).toBe(false);
    expect(commands.some((command) => command.name === 'pipeline')).toBe(false);
    expect(commands.some((command) => command.name === 'schedule')).toBe(false);
  });
});
