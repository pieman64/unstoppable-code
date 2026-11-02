import type {
  PlatformExecutionOutcome,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
  PlatformPowerAcquireResult,
  PlatformPowerAssertion,
  PlatformPowerAssertionEnd,
  PlatformPowerServices,
} from '@canopy/core-runtime';

const SHELL = '/bin/sh';
/**
 * Prints the marker once the helper holds the assertion, then waits on
 * stdin. Only the host holds stdin's other end, so a host exit, crashed or
 * not, ends the script and the helper drops the assertion with it.
 */
const HOLD_SCRIPT = "printf 'held\\n'; read -r _; exit 0";
const MARKER = 'held\n';
/** The held command every helper runs; exported for the native crash suite. */
export const HOLD_COMMAND: readonly string[] = [SHELL, '-c', HOLD_SCRIPT];
const ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
};

const NOT_STARTED = 'Sleep helper could not start.';
const STOPPED = 'Sleep helper was stopped.';
const NOT_CONFIRMED = 'Sleep helper release could not be confirmed.';

/** One helper that holds an assertion while the command it runs is alive. */
export interface PowerHelper {
  readonly mechanism: 'power-assertion' | 'logind-inhibitor';
  /** The helper and its arguments before the held command, or null when absent. */
  command(reason: string): {
    readonly executable: string;
    readonly args: readonly string[];
  } | null;
  /** Fixed text for a host without the helper. */
  readonly unavailable: string;
}

/**
 * `caffeinate -i`: an idle system-sleep assertion while its command runs.
 * It execs the command and asserts from a forked child that watches it, so
 * the marker can precede the assertion by moments.
 */
export const DARWIN_POWER_HELPER: PowerHelper = {
  mechanism: 'power-assertion',
  command: () => ({ executable: '/usr/bin/caffeinate', args: ['-i'] }),
  unavailable: 'Power assertions are unavailable on this host.',
};

const SYSTEMD_INHIBIT = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'];

/** A systemd-logind sleep inhibitor in block mode while its command runs. */
export function linuxPowerHelper(options: {
  readonly applicationName: string;
  readonly exists: (path: string) => boolean;
}): PowerHelper {
  let executable: string | null | undefined;
  return {
    mechanism: 'logind-inhibitor',
    command: (reason): ReturnType<PowerHelper['command']> => {
      executable ??= SYSTEMD_INHIBIT.find(options.exists) ?? null;
      if (executable === null) return null;
      return {
        executable,
        args: [
          '--what=sleep',
          '--mode=block',
          `--who=${options.applicationName}`,
          `--why=${reason}`,
        ],
      };
    },
    unavailable: 'Sleep inhibition needs systemd-inhibit, which is missing.',
  };
}

function outcomeReason(outcome: PlatformExecutionOutcome): string {
  if (outcome.kind === 'exited')
    return `Sleep helper exited (code ${outcome.code ?? 'unknown'}).`;
  if (outcome.kind === 'crashed')
    return `Sleep helper ended (${outcome.signal ?? 'crashed'}).`;
  if (outcome.kind === 'lost') return NOT_CONFIRMED;
  return STOPPED;
}

/** Reads until the marker; `false` once the stream ends without it. */
async function awaitMarker(child: PlatformExecutionProcess): Promise<boolean> {
  const decoder = new TextDecoder();
  let seen = '';
  for (;;) {
    const bytes = await child.stdout.read();
    if (bytes === null) return false;
    child.stdout.acknowledge(bytes.byteLength);
    seen += decoder.decode(bytes, { stream: true });
    if (seen.includes(MARKER)) {
      child.stdout.discard();
      return true;
    }
    if (seen.length > MARKER.length * 4) return false;
  }
}

/**
 * Power assertions held by a helper process under execution-process custody.
 * The helper's tree is stopped on release, and on handled host exit by the
 * custody; a host crash closes its stdin, which ends the helper.
 */
export function createHelperPowerServices(
  helper: PowerHelper,
  processes: () => PlatformExecutionProcessServices,
): PlatformPowerServices {
  let nextId = 1;

  return {
    mechanism: helper.mechanism,
    preventSystemSleep: ({ reason }): PlatformPowerAcquireResult => {
      const command = helper.command(reason);
      if (command === null)
        return { kind: 'unavailable', reason: helper.unavailable };
      const id = nextId++;
      let state: 'starting' | 'held' | 'ended' = 'starting';
      let releasing = false;
      /** The helper's tree is known to be gone; `lost` leaves it unknown. */
      let stopped = false;
      let settleHeld: (held: boolean) => void = () => undefined;
      let settleEnded: (end: PlatformPowerAssertionEnd) => void = () =>
        undefined;
      const held = new Promise<boolean>((resolve) => {
        settleHeld = resolve;
      });
      const ended = new Promise<PlatformPowerAssertionEnd>((resolve) => {
        settleEnded = resolve;
      });
      const end = (value: PlatformPowerAssertionEnd): void => {
        if (state === 'ended') return;
        state = 'ended';
        settleHeld(false);
        settleEnded(value);
      };

      const started = Promise.resolve()
        .then(() =>
          processes().start({
            executable: command.executable,
            args: [...command.args, ...HOLD_COMMAND],
            cwd: '/',
            environment: ENVIRONMENT,
            stdin: 'pipe',
            stderr: 'discard',
            outputWindowBytes: 256,
          }),
        )
        .then(
          (child) => {
            void child.outcome.then((outcome) => {
              stopped = outcome.kind !== 'lost';
              end(
                releasing && stopped
                  ? { kind: 'released' }
                  : { kind: 'lost', reason: outcomeReason(outcome) },
              );
            });
            void awaitMarker(child).then(
              (marked) => {
                if (!marked || state !== 'starting') return;
                state = 'held';
                settleHeld(true);
              },
              () => undefined,
            );
            return child;
          },
          () => {
            end({ kind: 'lost', reason: NOT_STARTED });
            return null;
          },
        );

      const assertion: PlatformPowerAssertion = {
        id,
        isHeld: () => state === 'held',
        held,
        ended,
        release: async (): Promise<void> => {
          releasing = true;
          const child = await started;
          if (child === null || stopped) return;
          // A stop that could not be confirmed is retried; its tree may live.
          try {
            await child.terminate({ mode: 'graceful' });
          } catch {
            throw new Error(NOT_CONFIRMED);
          }
          stopped = true;
          await ended;
        },
      };
      return { kind: 'acquired', assertion };
    },
  };
}
