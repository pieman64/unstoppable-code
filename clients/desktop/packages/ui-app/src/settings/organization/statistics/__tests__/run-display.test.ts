import {
  formatEventTypeLabel,
  formatProviderLabel,
  formatTurnStatusLabel,
  turnStatusBadgeVariant,
} from '../run-display';

describe('formatEventTypeLabel', () => {
  it('maps known event types to friendly labels', () => {
    expect(formatEventTypeLabel('WORKTREE_CHAT')).toBe('Worktree chat');
    expect(formatEventTypeLabel('PIPELINE_AGENT_TURN')).toBe('Pipeline');
    expect(formatEventTypeLabel('PR_GENERATION')).toBe('PR generation');
  });

  it('title-cases unknown event types as a fallback', () => {
    expect(formatEventTypeLabel('SOME_NEW_EVENT')).toBe('Some New Event');
    expect(formatEventTypeLabel('SOLO')).toBe('Solo');
  });
});

describe('formatTurnStatusLabel', () => {
  it('maps known statuses to friendly labels', () => {
    expect(formatTurnStatusLabel('SUCCESS')).toBe('Success');
    expect(formatTurnStatusLabel('FAILURE')).toBe('Failure');
    expect(formatTurnStatusLabel('INTERRUPTED')).toBe('Interrupted');
  });

  it('title-cases unknown statuses as a fallback', () => {
    expect(formatTurnStatusLabel('MYSTERY_STATE')).toBe('Mystery State');
  });
});

describe('turnStatusBadgeVariant', () => {
  it('maps statuses to badge variants', () => {
    expect(turnStatusBadgeVariant('SUCCESS')).toBe('success');
    expect(turnStatusBadgeVariant('FAILURE')).toBe('destructive');
    expect(turnStatusBadgeVariant('CANCELLED')).toBe('warning');
    expect(turnStatusBadgeVariant('INTERRUPTED')).toBe('warning');
    expect(turnStatusBadgeVariant('RUNNING')).toBe('active');
  });

  it('falls back to muted for unknown statuses', () => {
    expect(turnStatusBadgeVariant('WHATEVER')).toBe('muted');
  });
});

describe('formatProviderLabel', () => {
  it('maps known providers', () => {
    expect(formatProviderLabel('claude')).toBe('Claude');
    expect(formatProviderLabel('codex')).toBe('Codex');
    expect(formatProviderLabel('ollama')).toBe('Ollama');
  });

  it('is case-insensitive for known providers', () => {
    expect(formatProviderLabel('CLAUDE')).toBe('Claude');
  });

  it('capitalizes unknown providers as a fallback', () => {
    expect(formatProviderLabel('mistral')).toBe('Mistral');
  });

  it('returns empty input unchanged', () => {
    expect(formatProviderLabel('')).toBe('');
  });
});
