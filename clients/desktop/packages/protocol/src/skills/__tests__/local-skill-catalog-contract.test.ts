import type {
  AvailableSkill,
  FetchAvailableSkillsResponse,
  InstalledSkillInfo,
  SkillContentResponse,
  SkillRiskInfo,
  SkillUpdateProgress,
} from '../index';

describe('local skill catalog contract', () => {
  it('constructs installed skill rows with shareable source metadata', () => {
    const builtIn: InstalledSkillInfo = {
      name: 'commit-messages',
      sourceId: 'builtin:app',
      description: 'Write commit messages',
      source: 'Built-in',
      installedAt: '2026-08-27T00:00:00Z',
      updatedAt: '2026-08-27T00:00:00Z',
      updateAvailable: false,
      builtIn: true,
      shareableSource: { type: 'builtin', id: 'app' },
    };
    const custom: InstalledSkillInfo = {
      name: 'my-notes',
      sourceId: 'custom:app',
      description: 'Personal notes skill',
      source: 'Custom',
      installedAt: '2026-08-27T00:00:00Z',
      updatedAt: '2026-08-27T00:00:00Z',
      updateAvailable: false,
      custom: true,
    };
    const github: InstalledSkillInfo = {
      name: 'brainstorming',
      sourceId: 'github:acme/skills',
      description: 'Brainstorm ideas',
      source: 'acme/skills',
      installedAt: '2026-08-27T00:00:00Z',
      updatedAt: '2026-08-27T00:00:00Z',
      updateAvailable: true,
      shareableSource: { type: 'github', repo: 'acme/skills' },
    };
    for (const row of [builtIn, custom, github]) {
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    }
  });

  it('keeps fetch-available payloads serializable', () => {
    const skill: AvailableSkill = {
      name: 'brainstorming',
      description: 'Brainstorm ideas',
      sourcePath: 'skills/brainstorming',
    };
    const risk: SkillRiskInfo = { level: 'low', socketAlerts: 0 };
    const unknownRisk: SkillRiskInfo = { level: 'unknown', socketAlerts: null };
    const response: FetchAvailableSkillsResponse = {
      source: 'acme/skills',
      skills: [skill],
      riskInfo: { brainstorming: risk, other: unknownRisk },
      hasMarketplace: false,
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('keeps skill content and update progress serializable', () => {
    const content: SkillContentResponse = {
      frontmatter: { name: 'brainstorming', 'user-invocable': true },
      body: '# Brainstorming\n\nUse this skill…',
    };
    expect(JSON.parse(JSON.stringify(content))).toEqual(content);

    const progress: SkillUpdateProgress = {
      operation: 'check-updates',
      status: 'complete',
      message: 'Checked 3 skills',
      updateMap: { brainstorming: true, 'commit-messages': false },
    };
    expect(JSON.parse(JSON.stringify(progress))).toEqual(progress);
  });
});
