import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { ADVISORY_WORKSPACE_PROJECT_IDS } from '@canopy/protocol/telemetry';

import { getSentinelTelemetryWorkspace } from '../sentinel-telemetry-workspaces';

describe('getSentinelTelemetryWorkspace', () => {
  it('resolves App Advisor, which has no workspaces/index.json row', () => {
    const resolved = getSentinelTelemetryWorkspace(APP_ADVISOR_PROJECT_ID);

    expect(resolved).toEqual({ name: 'App Advisor', type: 'cowork' });
  });

  it.each([
    [PLAN_EXPLORE_CHAT_PROJECT_ID, 'Plan Explore'],
    [CODE_REVIEW_CHAT_PROJECT_ID, 'Code Review Chat'],
    [PIPELINE_EDITOR_PROJECT_ID, 'Pipeline Assistant'],
  ])('resolves the %s chat surface', (projectId, name) => {
    expect(getSentinelTelemetryWorkspace(projectId)).toEqual({
      name,
      type: 'cowork',
    });
  });

  it('does not claim the cowork chat sentinels', () => {
    // Those entries represent delivered work, not advice; enabling them is a
    // separate decision and they must keep counting as authored work areas.
    expect(
      getSentinelTelemetryWorkspace(STANDALONE_CHAT_PROJECT_ID),
    ).toBeNull();
  });

  it('matches the shared advisory id list exactly', () => {
    // The server excludes this same list from worktree counts; drift would
    // silently start counting an advisory scope as an authored worktree.
    for (const projectId of ADVISORY_WORKSPACE_PROJECT_IDS) {
      expect(getSentinelTelemetryWorkspace(projectId)).not.toBeNull();
    }
  });

  it('returns null for an ordinary project id', () => {
    // Ordinary workspaces must fall through to their index entry, whose
    // user-chosen name and type are authoritative.
    expect(getSentinelTelemetryWorkspace('canopy')).toBeNull();
  });

  it('reports every sentinel surface as repo-less', () => {
    for (const projectId of [
      APP_ADVISOR_PROJECT_ID,
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      CODE_REVIEW_CHAT_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
    ]) {
      expect(getSentinelTelemetryWorkspace(projectId)?.type).toBe('cowork');
    }
  });
});
