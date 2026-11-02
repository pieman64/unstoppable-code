import {
  ORCHESTRATOR_AGENT_NAME,
  ORCHESTRATOR_FORMER_LABEL,
  ORCHESTRATOR_LABEL,
  isOrchestratorLabel,
} from '../ui-labels';

describe('isOrchestratorLabel', () => {
  it('accepts the current and former names case-insensitively', () => {
    expect(isOrchestratorLabel(ORCHESTRATOR_LABEL)).toBe(true);
    expect(isOrchestratorLabel(ORCHESTRATOR_FORMER_LABEL)).toBe(true);
    expect(isOrchestratorLabel('App Advisor')).toBe(true);
    expect(isOrchestratorLabel('app advisor')).toBe(true);
    expect(isOrchestratorLabel('ORCHESTRATOR')).toBe(true);
    expect(isOrchestratorLabel('  orchestrator  ')).toBe(true);
  });

  it('rejects other names and missing values', () => {
    expect(isOrchestratorLabel('Advisor')).toBe(false);
    expect(isOrchestratorLabel('Pipeline Advisor')).toBe(false);
    expect(isOrchestratorLabel('Orchestrator chats')).toBe(false);
    expect(isOrchestratorLabel('')).toBe(false);
    expect(isOrchestratorLabel(null)).toBe(false);
    expect(isOrchestratorLabel(undefined)).toBe(false);
  });
});

describe('ORCHESTRATOR_AGENT_NAME', () => {
  it('introduces the current name with the former one', () => {
    expect(ORCHESTRATOR_AGENT_NAME).toBe('Orchestrator (formerly App Advisor)');
  });
});
