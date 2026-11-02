import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import {
  CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID,
  chatAutomationPipelinesEnabledIn,
} from '../chat-automation-experiment';

type Entry = LabsExperimentsSnapshot['experiments'][number];

function snapshot(
  ready: boolean,
  entries: Array<Pick<Entry, 'id' | 'enabled'>>,
): Pick<LabsExperimentsSnapshot, 'ready' | 'experiments'> {
  return {
    ready,
    experiments: entries.map((entry) => ({ ...entry }) as Entry),
  };
}

// CAN-4551: conversion fails closed to the native save.
describe('chatAutomationPipelinesEnabledIn', () => {
  const on = { id: CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID, enabled: true };

  it('is on only for a ready snapshot that enables the experiment', () => {
    expect(chatAutomationPipelinesEnabledIn(snapshot(true, [on]))).toBe(true);
  });

  it.each([
    ['an unready snapshot', snapshot(false, [on])],
    ['the experiment off', snapshot(true, [{ ...on, enabled: false }])],
    ['no entry for it', snapshot(true, [{ id: 'kanban-page', enabled: true }])],
  ])('is off for %s', (_label, value) => {
    expect(chatAutomationPipelinesEnabledIn(value)).toBe(false);
  });
});
