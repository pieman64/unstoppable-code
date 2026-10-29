import type { GitHubCloudConnectStepProps } from '../GitHubCloudConnectStep';

// Compile-time contract for the selected account: by installation id or by
// owner login, never both. `tsc` (typecheck:web) enforces each annotation
// below; the single runtime assertion only keeps the values used. Nothing is
// suppressed: if the props ever allowed both, `both` would read `true` and the
// `false` annotation would stop compiling.

type Base = Pick<GitHubCloudConnectStepProps, 'controller' | 'onReady'>;
type Accepts<Props> = Props extends GitHubCloudConnectStepProps ? true : false;

const none: Accepts<Base> = true;
const byInstallation: Accepts<Base & { selectedInstallationId: string }> = true;
const byLogin: Accepts<Base & { selectedAccountLogin: string }> = true;
const both: Accepts<
  Base & { selectedInstallationId: string; selectedAccountLogin: string }
> = false;

describe('GitHubCloudConnectStep selection props (compile-time)', () => {
  it('accepts no selection, an installation id, or a login, and rejects both', () => {
    const accepted: readonly [true, true, true, false] = [
      none,
      byInstallation,
      byLogin,
      both,
    ];

    expect(accepted).toEqual([true, true, true, false]);
  });
});
