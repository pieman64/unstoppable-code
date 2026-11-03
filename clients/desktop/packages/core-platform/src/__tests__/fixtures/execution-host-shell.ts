import { runRequestedExecutionHostShell } from '../../execution-host/shell';

// The shell runner for the shell suite: what a shell-capable executable such
// as the core daemon does with these arguments before its own startup. A
// suite may stretch the sampling interval to show what the heap sampler does
// between two of its ticks.
const sampleIntervalMs = Number(
  process.env.EXECUTION_HOST_SHELL_TEST_SAMPLE_INTERVAL_MS,
);
if (
  !runRequestedExecutionHostShell(
    process.argv.slice(2),
    { directory: __dirname, names: ['channel-host.js'] },
    Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0
      ? { sampleIntervalMs }
      : {},
  )
)
  throw new Error('Launched without execution host shell arguments.');
