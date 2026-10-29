/**
 * The CAN-4051 parity fixtures. Each one is a single recorded scenario with
 * its desktop-native form and its Agentic Core form, both derived from the
 * same source in its scenario module.
 */
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  claudeCloudRecording,
  claudeDesktopEvents,
  claudeExpectedCloudBackgroundTasks,
} from './claude-scenario';
import {
  CODEX_V1_SCENARIO,
  CODEX_V2_SCENARIO,
  codexCloudRecording,
  codexDesktopEvents,
} from './codex-scenario';
import type { CloudRecording, DesktopRecordedEvent } from './recording';

export type ParityFixtureName = 'claude' | 'codex-v2' | 'codex-v1';

export interface ParityFixture {
  readonly name: ParityFixtureName;
  /** The root chat; desktop's tab label and the cloud chat title. */
  readonly root: { readonly id: string; readonly title: string };
  readonly desktopEvents: () => readonly DesktopRecordedEvent[];
  readonly cloudRecording: () => CloudRecording;
  /** What cloud should list as background tasks once CAN-4050 lands. */
  readonly expectedCloudBackgroundTasks: () => readonly BackgroundTask[];
}

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  {
    name: 'claude',
    root: { id: 'parity-claude-chat', title: 'Ship the API audit' },
    desktopEvents: claudeDesktopEvents,
    cloudRecording: claudeCloudRecording,
    expectedCloudBackgroundTasks: claudeExpectedCloudBackgroundTasks,
  },
  {
    name: 'codex-v2',
    root: { id: 'parity-codex-v2-chat', title: 'Lint and test in parallel' },
    desktopEvents: () => codexDesktopEvents(CODEX_V2_SCENARIO),
    cloudRecording: () => codexCloudRecording(CODEX_V2_SCENARIO),
    expectedCloudBackgroundTasks: () => [],
  },
  {
    name: 'codex-v1',
    root: { id: 'parity-codex-v1-chat', title: 'Check docs and types' },
    desktopEvents: () => codexDesktopEvents(CODEX_V1_SCENARIO),
    cloudRecording: () => codexCloudRecording(CODEX_V1_SCENARIO),
    expectedCloudBackgroundTasks: () => [],
  },
];
