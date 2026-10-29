/**
 * macOS names crash reports after the process name. Main and helper processes
 * derive from the stable packaged display name plus release flavor.
 */
import { BRAND } from '@canopy/brand/current';

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/tmp'),
    getVersion: jest.fn(() => '0.0.0-test'),
    isPackaged: false,
  },
}));

describe('isCanopyDiagnosticReport', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function loadPredicate(
    displayName: string,
  ): Promise<(filename: string) => boolean> {
    jest.resetModules();
    // Override only the display name on the real BRAND. Other modules in the
    // import graph read BRAND at load time, so a minimal stub is not enough.
    // `doMock` is not hoisted, so referencing BRAND here is safe.
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: { ...BRAND, displayName },
    }));
    const loaded = await import('../feedback/feedback-bundle');
    return loaded.isCanopyDiagnosticReport;
  }

  it('collects main and helper reports named after the packaged display name', async () => {
    const isReport = await loadPredicate('Unstoppable Code');

    expect(
      isReport('Unstoppable Code Helper (Renderer)-2026-08-18-120000.ips'),
    ).toBe(true);
    expect(isReport('Unstoppable Code-2026-08-18-120000.ips')).toBe(true);
    expect(isReport('Unstoppable-2026-08-18-120000.ips')).toBe(false);
  });

  it('ignores unrelated processes and non-crash files', async () => {
    const isReport = await loadPredicate('Unstoppable Code');

    expect(isReport('Safari-2026-08-18-120000.ips')).toBe(false);
    expect(isReport('Unstoppable Code-2026-08-18-120000.txt')).toBe(false);
  });

  it('does not collect other vendors that merely share the name prefix', async () => {
    // These files are uploaded in a user feedback bundle, so an unanchored
    // prefix match is a privacy leak, not just noise. macOS names reports
    // `<process>-<YYYY-MM-DD>-...`, so the separator makes the match exact.
    const isReport = await loadPredicate('Unstoppable Code');

    expect(isReport('Unstoppable Code Wallet-2026-08-18-120000.ips')).toBe(
      false,
    );
    expect(
      isReport('Unstoppable Code Wallet Helper (GPU)-2026-08-18-120000.ips'),
    ).toBe(false);
  });

  it('collects helper reports from flavored internal and RC builds', async () => {
    // electron-builder sets productName to `${displayName} (Internal)` for the
    // internal flavor and names helpers `${productName} Helper (<Type>)`.
    // Internal is the dogfood channel, so dropping these would silently gut
    // crash triage on exactly the builds that crash most.
    const isReport = await loadPredicate('Unstoppable Code');

    expect(
      isReport(
        'Unstoppable Code (Internal) Helper (Renderer)-2026-08-18-120000.ips',
      ),
    ).toBe(true);
    expect(
      isReport(
        'Unstoppable Code (Internal) Helper (GPU)-2026-08-18-120000.ips',
      ),
    ).toBe(true);
    expect(
      isReport('Unstoppable Code (RC) Helper (Renderer)-2026-08-18-120000.ips'),
    ).toBe(true);
    // The flavored main process uses the same packaged product name.
    expect(isReport('Unstoppable Code (Internal)-2026-08-18-120000.ips')).toBe(
      true,
    );
  });

  it('still rejects prefix-sharing vendors once flavors are allowed', async () => {
    // The optional flavor segment must be a parenthesized group, so it cannot
    // become a wildcard that re-opens the over-match.
    const isReport = await loadPredicate('Unstoppable Code');

    expect(
      isReport(
        'Unstoppable Code Extra Helper (Renderer)-2026-08-18-120000.ips',
      ),
    ).toBe(false);
    expect(isReport('Unstoppable Code Extra-2026-08-18-120000.ips')).toBe(
      false,
    );
  });

  it('fails closed when the brand supplies no usable names', async () => {
    // Unreachable through brand loading (empty names are rejected), but the
    // predicate must not degrade to `^(?:)-` and sweep in any `-*.ips`.
    const isReport = await loadPredicate('');

    expect(isReport('-2026-08-18-120000.ips')).toBe(false);
    expect(isReport('Safari-2026-08-18-120000.ips')).toBe(false);
    expect(isReport('Canopy-2026-08-18-120000.ips')).toBe(false);
  });

  it('treats regex metacharacters in brand names literally', async () => {
    // Brand names may contain "." (SAFE_DISPLAY_REGEX allows it), which must
    // not become a wildcard in the generated matcher.
    const isReport = await loadPredicate('A.B Editor');

    expect(isReport('A.B Editor-2026-08-18-120000.ips')).toBe(true);
    expect(isReport('AXB Editor-2026-08-18-120000.ips')).toBe(false);
  });
});
