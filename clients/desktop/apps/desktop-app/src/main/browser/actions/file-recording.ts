import { randomUUID } from 'node:crypto';
import type { BrowserRecordingStep } from '@canopy/desktop-shared/types/browser';

const BY_NAME =
  '// Files by name only: put them beside the script, or use their paths.';

/**
 * A JavaScript literal for a page-chosen name. JSON leaves U+2028 and U+2029
 * as they are, and either one ends a `//` comment, so a name could otherwise
 * add code to the script.
 */
function literal(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function recordingStep(
  step: Omit<BrowserRecordingStep, 'id' | 'timestamp'>,
): BrowserRecordingStep {
  return { id: randomUUID(), timestamp: Date.now(), ...step };
}

/**
 * Files an upload attached, by name only: a recording never holds a host or
 * workspace path. `chooser` answers the file chooser the step before opened.
 */
export function uploadRecording(options: {
  names: string[];
  locator?: string;
  via: 'input' | 'chooser' | 'drop';
}): BrowserRecordingStep {
  const files = literal(options.names);
  let playwright: string;
  if (options.via === 'chooser')
    playwright = [
      "const fileChooser = await page.waitForEvent('filechooser');",
      BY_NAME,
      `await fileChooser.setFiles(${files});`,
    ].join('\n');
  else if (options.via === 'drop')
    playwright = `// Files ${files} were dropped on ${options.locator ?? 'the page'}; Playwright cannot replay a file drop.`;
  else if (options.locator)
    playwright = [
      BY_NAME,
      `await ${options.locator}.setInputFiles(${files});`,
    ].join('\n');
  else
    playwright = `// The file input has no replayable locator. Files: ${files}.`;
  return recordingStep({
    action: 'upload',
    ...(options.locator ? { locator: options.locator } : {}),
    values: options.names,
    ...(options.via === 'chooser' ? { value: 'filechooser' } : {}),
    playwright,
  });
}

/** A download a step started, by the name the task file got. */
export function downloadRecording(name: string): BrowserRecordingStep {
  return recordingStep({
    action: 'download',
    value: name,
    playwright: `const download = await page.waitForEvent('download'); // ${literal(name)}`,
  });
}

/** `save_pdf`, with Playwright's names for its options. */
export function printRecording(
  options: Record<string, unknown>,
): BrowserRecordingStep {
  return recordingStep({
    action: 'print',
    playwright: [
      '// page.pdf() runs only in headless Chromium.',
      `await page.pdf(${literal(options)});`,
    ].join('\n'),
  });
}

/** The event a step waits for, which starts during the step before it. */
function awaitedEvent(
  step: BrowserRecordingStep,
): 'download' | 'filechooser' | undefined {
  if (step.action === 'download') return 'download';
  if (step.action === 'upload' && step.value === 'filechooser')
    return 'filechooser';
  return undefined;
}

/**
 * The steps as one script body. A download fires during the step before it,
 * and a chooser during the step that opened it, so each wait starts before
 * that step, as Playwright's own code generator writes it. A chooser
 * upload's opener is the last step recorded by the time its chooser opened;
 * an upload is itself a step a download can come from. A wait with no
 * recorded step to start it is a comment.
 */
export function recordingScriptBody(steps: BrowserRecordingStep[]): string {
  const blocks = steps.map((step) => step.playwright);
  const before: string[][] = steps.map(() => []);
  /** Per step, the last wait for each event started before it, to chain. */
  const hoisted = new Map<number, Map<string, string>>();
  /** The last step a download can come from: anything but a download. */
  let trigger = -1;
  let count = 0;
  const hoist = (at: number, event: string, name: string): void => {
    const waits = hoisted.get(at) ?? new Map<string, string>();
    hoisted.set(at, waits);
    // Each wait would take the first event, so a later one starts after it.
    const earlier = waits.get(event);
    waits.set(event, name);
    const wait = `page.waitForEvent('${event}')`;
    before[at]?.push(
      `const ${name}Promise = ${earlier ? `${earlier}Promise.then(() => ${wait})` : wait};`,
    );
  };
  steps.forEach((step, index) => {
    const event = awaitedEvent(step);
    if (event === 'download') {
      if (trigger < 0) {
        blocks[index] =
          `// A download started here with no recorded step before it: ${literal(step.value ?? '')}.`;
        return;
      }
      count += 1;
      const name = `download${count}`;
      hoist(trigger, 'download', name);
      blocks[index] =
        `const ${name} = await ${name}Promise; // ${literal(step.value ?? '')}`;
      return;
    }
    if (event === 'filechooser') {
      const opener = chooserOpener(steps, index);
      if (opener < 0)
        blocks[index] =
          `// A file chooser was answered here with no recorded step before it: ${literal(step.values ?? [])}.`;
      else {
        count += 1;
        const name = `fileChooser${count}`;
        hoist(opener, 'filechooser', name);
        blocks[index] = [
          `const ${name} = await ${name}Promise;`,
          BY_NAME,
          `await ${name}.setFiles(${literal(step.values ?? [])});`,
        ].join('\n');
      }
    }
    trigger = index;
  });
  return blocks
    .map((block, index) => [...(before[index] ?? []), block].join('\n'))
    .join('\n');
}

/**
 * The step that opened a chooser upload's chooser: the last action recorded
 * by the time the chooser opened, or before the upload when that time is
 * not known; -1 when there is none.
 */
function chooserOpener(steps: BrowserRecordingStep[], index: number): number {
  const openedAt = steps[index]?.chooserOpenedAt;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const step = steps[candidate];
    if (!step || awaitedEvent(step)) continue;
    if (openedAt === undefined || step.timestamp <= openedAt) return candidate;
  }
  return -1;
}
