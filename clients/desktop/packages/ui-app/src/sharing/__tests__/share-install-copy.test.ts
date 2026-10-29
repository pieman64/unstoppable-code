import {
  shareInstallActionLabel,
  shareInstallDefaultDescription,
  shareInstallEntityNoun,
  shareInstallPlaceholderTitle,
  shareInstallTypeLabel,
  type ShareInstallEntity,
} from '../share-install-copy';

const ENTITIES: readonly ShareInstallEntity[] = [
  'skill',
  'plugin',
  'pipeline',
  'automation',
  'agent',
  'collection',
  'workspace',
];

describe('shareInstallActionLabel', () => {
  it('says Install with no noun for every entity, Blueprints included', () => {
    for (const entity of ENTITIES) {
      expect(shareInstallActionLabel(entity, 'install')).toBe('Install');
      expect(shareInstallActionLabel(entity, 'installing')).toBe('Installing…');
      expect(shareInstallActionLabel(entity, 'update')).toBe('Update');
      expect(shareInstallActionLabel(entity, 'updating')).toBe('Updating…');
    }
  });

  it('names the destination once installed', () => {
    expect(shareInstallActionLabel('skill', 'open')).toBe('Open skill');
    expect(shareInstallActionLabel('plugin', 'open')).toBe('Open plugin');
    expect(shareInstallActionLabel('pipeline', 'open')).toBe('Open pipeline');
    expect(shareInstallActionLabel('automation', 'open')).toBe(
      'Open automation',
    );
    expect(shareInstallActionLabel('agent', 'open')).toBe('Open agent');
    expect(shareInstallActionLabel('collection', 'open')).toBe(
      'Open collection',
    );
    expect(shareInstallActionLabel('workspace', 'open')).toBe('Open project');
  });
});

describe('shareInstallDefaultDescription', () => {
  it('gives every entity its own one-line sentence', () => {
    const descriptions = ENTITIES.map(shareInstallDefaultDescription);
    expect(new Set(descriptions).size).toBe(ENTITIES.length);
    for (const description of descriptions) {
      expect(description).toMatch(/^[A-Z].*\.$/);
      expect(description).not.toContain('\n');
    }
  });

  it('describes an automation without assuming a pipeline or a project', () => {
    // Prompt and App Advisor automations run no pipeline, and App Advisor
    // needs no project.
    expect(shareInstallDefaultDescription('automation')).toBe(
      'An automation that runs a task for you on a schedule.',
    );
  });

  it('describes a Blueprint as a project template', () => {
    expect(shareInstallDefaultDescription('workspace')).toBe(
      'A project template with its setup ready to use.',
    );
  });
});

describe('shareInstallTypeLabel', () => {
  it('capitalizes the noun, and a Blueprint reads as a project template', () => {
    expect(shareInstallTypeLabel('skill')).toBe('Skill');
    expect(shareInstallTypeLabel('workspace')).toBe('Project template');
    expect(shareInstallEntityNoun('workspace')).toBe('project');
    expect(shareInstallEntityNoun('collection')).toBe('collection');
  });

  it('names the loading placeholder by type', () => {
    expect(shareInstallPlaceholderTitle('automation')).toBe(
      'Shared automation',
    );
    expect(shareInstallPlaceholderTitle('workspace')).toBe(
      'Shared project template',
    );
  });
});
