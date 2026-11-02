import type { Stats } from 'node:fs';

let mockPlatform: string | null = 'linux';
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string | null => mockPlatform,
}));
const mockRealpath = jest.fn((file: string) => Promise.resolve(file));
const mockLstat = jest.fn<
  Promise<Pick<Stats, 'isFile' | 'nlink' | 'size' | 'mode'>>,
  [file: string]
>(() =>
  Promise.resolve({
    isFile: () => true,
    nlink: 1,
    size: 42,
    mode: 0o100755,
  }),
);
jest.mock('node:fs/promises', () => ({
  realpath: (file: string): Promise<string> => mockRealpath(file),
  lstat: (file: string): ReturnType<typeof mockLstat> => mockLstat(file),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: (): string => '/bundled/bin/codex',
}));
import {
  DELEGATION_RUNTIME_CODEX_SANDBOX_MISSING_REASON,
  DELEGATION_RUNTIME_NO_PIN_REASON,
  delegationRuntimeUnavailableReason,
} from '../agents/delegation/runtime-support';

// Literals, not the exported constants, and `await` rather than `.resolves`, so
// the intended RED for the new Linux Codex sandbox gate is a real assertion
// failure against the committed (synchronous) function — which returned
// undefined for Codex — never a missing-export or non-Promise error.
const CODEX_SANDBOX_MISSING =
  'The bundled Linux sandbox helper for the managed runtime is missing or invalid. Reinstall the app to restore it.';
const NO_PIN =
  'This provider has no pinned managed runtime for Linux. Choose another provider.';
// realpath is identity here, so the sibling is beside the canonical binary.
const SIBLING_BWRAP = '/bundled/bin/bwrap';

beforeEach(() => {
  mockPlatform = 'linux';
  mockRealpath.mockReset().mockImplementation((file) => Promise.resolve(file));
  mockLstat.mockReset().mockResolvedValue({
    isFile: () => true,
    nlink: 1,
    size: 42,
    mode: 0o100755,
  });
});

it('exports the actionable reasons it returns', () => {
  expect(DELEGATION_RUNTIME_CODEX_SANDBOX_MISSING_REASON).toBe(
    CODEX_SANDBOX_MISSING,
  );
  expect(DELEGATION_RUNTIME_NO_PIN_REASON).toBe(NO_PIN);
});

it('reports Linux Codex unavailable when the sibling bwrap is absent', async () => {
  mockLstat.mockRejectedValueOnce(new Error('ENOENT'));
  expect(await delegationRuntimeUnavailableReason('codex')).toBe(
    CODEX_SANDBOX_MISSING,
  );
  // Resolved and statted beside the canonical bundled Codex binary, not an
  // arbitrary path.
  expect(mockRealpath).toHaveBeenCalledWith('/bundled/bin/codex');
  expect(mockLstat).toHaveBeenCalledWith(SIBLING_BWRAP);
});

it('reports Linux Codex unavailable when the sibling bwrap is not executable', async () => {
  mockLstat.mockResolvedValueOnce({
    isFile: () => true,
    nlink: 1,
    size: 42,
    mode: 0o100644,
  });
  expect(await delegationRuntimeUnavailableReason('codex')).toBe(
    CODEX_SANDBOX_MISSING,
  );
  expect(mockLstat).toHaveBeenCalledWith(SIBLING_BWRAP);
});

it('rejects a sibling bwrap that is a symlink or hard-linked, matching the staged helper contract', async () => {
  mockLstat.mockResolvedValueOnce({
    isFile: () => false,
    nlink: 1,
    size: 42,
    mode: 0o120777,
  });
  expect(await delegationRuntimeUnavailableReason('codex')).toBe(
    CODEX_SANDBOX_MISSING,
  );
  mockLstat.mockResolvedValueOnce({
    isFile: () => true,
    nlink: 2,
    size: 42,
    mode: 0o100755,
  });
  expect(await delegationRuntimeUnavailableReason('codex')).toBe(
    CODEX_SANDBOX_MISSING,
  );
});

it('treats Linux Codex as available when the staged executable bwrap sibling is present', async () => {
  expect(await delegationRuntimeUnavailableReason('codex')).toBeUndefined();
  expect(mockRealpath).toHaveBeenCalledWith('/bundled/bin/codex');
  expect(mockLstat).toHaveBeenCalledWith(SIBLING_BWRAP);
});

it('checks the helper beside the canonical binary rather than its staging link', async () => {
  mockRealpath.mockResolvedValueOnce('/canonical/runtime/codex');
  expect(await delegationRuntimeUnavailableReason('codex')).toBeUndefined();
  expect(mockLstat).toHaveBeenCalledWith('/canonical/runtime/bwrap');
});

it('treats Linux Claude as available without requiring a sandbox sibling', async () => {
  expect(await delegationRuntimeUnavailableReason('claude')).toBeUndefined();
  expect(mockLstat).not.toHaveBeenCalled();
});

it.each(['cursor', 'copilot', 'opencode'] as const)(
  'reports no pinned Linux managed runtime for %s via the real static pin check',
  async (harness) => {
    expect(await delegationRuntimeUnavailableReason(harness)).toBe(NO_PIN);
    // Static pin only — never resolves or stats a sandbox sibling.
    expect(mockLstat).not.toHaveBeenCalled();
  },
);

it.each(['darwin', 'win32'] as const)(
  'treats every harness as available on %s',
  async (platform) => {
    mockPlatform = platform;
    for (const harness of ['codex', 'claude', 'cursor', 'copilot', 'opencode'])
      expect(await delegationRuntimeUnavailableReason(harness)).toBeUndefined();
    expect(mockLstat).not.toHaveBeenCalled();
  },
);

it('treats an unsupported host as available here (handled by the host gate upstream)', async () => {
  mockPlatform = null;
  expect(await delegationRuntimeUnavailableReason('codex')).toBeUndefined();
});
