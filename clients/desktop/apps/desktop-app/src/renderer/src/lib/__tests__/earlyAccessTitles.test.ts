import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';
import {
  currentEarlyAccessTitle,
  earlyAccessTitle,
} from '@/lib/earlyAccessTitles';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

describe('earlyAccessTitle', () => {
  it('uses sentence case without an experiment choice', () => {
    expect(earlyAccessTitle('Changed Files')).toBe('Changed files');
    expect(earlyAccessTitle('Dispatch Pipeline')).toBe('Dispatch pipeline');
  });

  it.each([
    ['Change Diagram', 'Change diagram'],
    ['File Explorer', 'File explorer'],
    ['Changed Files', 'Changed files'],
    ['Pull Request', 'Pull request'],
    ['Agent Background Processes', 'Agent background processes'],
    ['MCP Servers', 'MCP servers'],
    ['Agent Tasks', 'Agent tasks'],
    ['Pipeline Runs', 'Pipeline runs'],
    ['Dispatch Pipeline', 'Dispatch pipeline'],
    ['Browse MCP Servers', 'Browse MCP servers'],
  ])('shows %s as %s with early access on', (title, sentence) => {
    expect(earlyAccessTitle(title)).toBe(sentence);
  });

  it('passes names without a sentence-case form through', () => {
    expect(earlyAccessTitle('Terminal')).toBe('Terminal');
    expect(earlyAccessTitle('Scripts')).toBe('Scripts');
  });
});

describe('currentEarlyAccessTitle', () => {
  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
  });

  it('keeps sentence case across legacy preference changes', () => {
    expect(currentEarlyAccessTitle('MCP Servers')).toBe('MCP servers');
    setTestEarlyAccessFeatures({ enabled: true });
    expect(currentEarlyAccessTitle('MCP Servers')).toBe('MCP servers');
  });
});
