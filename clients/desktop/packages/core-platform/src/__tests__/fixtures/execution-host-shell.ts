import { runRequestedExecutionHostShell } from '../../execution-host/shell';

// The shell runner for the shell suite: what a shell-capable executable such
// as the core daemon does with these arguments before its own startup.
if (
  !runRequestedExecutionHostShell(process.argv.slice(2), {
    directory: __dirname,
    names: ['channel-host.js'],
  })
)
  throw new Error('Launched without execution host shell arguments.');
