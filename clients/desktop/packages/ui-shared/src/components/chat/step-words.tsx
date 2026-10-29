import type { JSX } from 'react';
import {
  DocumentIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  TaskIcon,
  TerminalIcon,
  WrenchIcon,
} from '../../icons';
import { DocumentPencilIcon, LightbulbIcon } from '../../icons/AppIcons';

/** The kinds of agent step a plain-words summary counts. */
export type StepKind =
  | 'thinking'
  | 'search'
  | 'read'
  | 'edit'
  | 'command'
  | 'graph'
  | 'web'
  | 'tasks'
  | 'other';

function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function timesSuffix(count: number): string {
  return count === 1 ? '' : ` ${count} times`;
}

const STEP_PHRASES: Record<StepKind, (count: number) => string> = {
  thinking: (count) => `thought${timesSuffix(count)}`,
  search: (count) => `searched ${countOf(count, 'time', 'times')}`,
  read: (count) => `read ${countOf(count, 'file', 'files')}`,
  edit: (count) => `edited ${countOf(count, 'file', 'files')}`,
  command: (count) => `ran ${countOf(count, 'command', 'commands')}`,
  graph: (count) => `checked the code graph${timesSuffix(count)}`,
  web: (count) => `used the web${timesSuffix(count)}`,
  tasks: (count) => `updated the task list${timesSuffix(count)}`,
  other: (count) => `used ${countOf(count, 'tool', 'tools')}`,
};

/**
 * Plain-words summary of agent steps, kinds in the order given: "Searched 3
 * times, read 4 files, checked the code graph". Live step groups and, under
 * the clean chat look, finished turns read the same way on every host.
 */
export function describeStepCounts(
  counts: Iterable<readonly [StepKind, number]>,
): string {
  const merged = new Map<StepKind, number>();
  for (const [kind, count] of counts) {
    if (count > 0) merged.set(kind, (merged.get(kind) ?? 0) + count);
  }
  const sentence = Array.from(merged, ([kind, count]) =>
    STEP_PHRASES[kind](count),
  ).join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function oneOrMany(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

const STEP_KIND_PHRASES: Record<StepKind, (count: number) => string> = {
  thinking: () => 'thought',
  search: () => 'searched the code',
  read: (count) => oneOrMany(count, 'read a file', 'read files'),
  edit: (count) => oneOrMany(count, 'edited a file', 'edited files'),
  command: (count) => oneOrMany(count, 'ran a command', 'ran commands'),
  graph: () => 'checked the code graph',
  web: () => 'searched the web',
  tasks: () => 'updated the task list',
  other: (count) => oneOrMany(count, 'used a tool', 'used tools'),
};

/**
 * The clean chat look's summary of a run of steps: what was done, without
 * counting it, like "Ran commands, read a file, searched the code". Thinking
 * only shows when the run did nothing else ("Thought").
 */
export function describeStepKinds(
  counts: Iterable<readonly [StepKind, number]>,
): string {
  const merged = new Map<StepKind, number>();
  for (const [kind, count] of counts) {
    if (count > 0) merged.set(kind, (merged.get(kind) ?? 0) + count);
  }
  if (merged.size > 1) merged.delete('thinking');
  const sentence = Array.from(merged, ([kind, count]) =>
    STEP_KIND_PHRASES[kind](count),
  ).join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The icon a step row of this kind leads with. */
export function stepKindIcon(kind: StepKind): JSX.Element {
  switch (kind) {
    case 'thinking':
      return <LightbulbIcon />;
    case 'search':
      return <MagnifyingGlassIcon />;
    case 'read':
      return <DocumentIcon />;
    case 'edit':
      return <DocumentPencilIcon />;
    case 'command':
      return <TerminalIcon />;
    case 'graph':
      return <GraphIcon />;
    case 'web':
      return <GlobeIcon />;
    case 'tasks':
      return <TaskIcon />;
    default:
      return <WrenchIcon />;
  }
}
