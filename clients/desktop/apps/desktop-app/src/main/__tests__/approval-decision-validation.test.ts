import { isApprovalPromptDecision } from '../approvals/approval-decision-validation';

describe('isApprovalPromptDecision', () => {
  it.each([
    { behavior: 'allow', scope: 'once' },
    { behavior: 'deny', scope: 'once', message: 'No', stopTurn: true },
    {
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'command', pattern: 'npm test *' },
    },
    {
      behavior: 'allow',
      scope: 'session',
      target: { kind: 'browser-upload', origin: 'https://upload.example' },
    },
    {
      behavior: 'deny',
      scope: 'global',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'exports/**',
      },
    },
  ])('accepts valid decision %#', (decision) => {
    expect(isApprovalPromptDecision(decision)).toBe(true);
  });

  it.each([
    null,
    { behavior: 'permit', scope: 'once' },
    { behavior: 'allow', scope: 'forever' },
    { behavior: 'allow', scope: 'project' },
    {
      behavior: 'allow',
      scope: 'once',
      target: { kind: 'tool', toolName: 'x' },
    },
    {
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'command', pattern: '' },
    },
    {
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'browser-upload', origin: '' },
    },
    {
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'browser-upload', origin: 'https://a.example', path: 3 },
    },
    { behavior: 'allow', scope: 'once', stopTurn: true },
    { behavior: 'deny', scope: 'once', message: 42 },
  ])('rejects malformed decision %#', (decision) => {
    expect(isApprovalPromptDecision(decision)).toBe(false);
  });
});
