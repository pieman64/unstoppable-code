import { buildSync } from 'esbuild';

function bundle(exports: string): string {
  const result = buildSync({
    stdin: {
      contents: `export { ${exports} } from "../index";`,
      resolveDir: __dirname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  return result.outputFiles?.[0]?.text ?? '';
}

describe('Portal browser bundle', () => {
  it('omits unrelated lookup tables when importing reported usage', () => {
    const output = bundle('parseOpenCodeReportedUsage');

    expect(output).toContain('parseOpenCodeReportedUsage');
    expect(output).not.toContain('portal.auth.validate_code');
    expect(output).not.toContain('PORTAL_ENTITY_TYPES_SET');
    expect(output).not.toContain('PORTAL_SNAPSHOT_SCOPES_SET');
    expect(output).not.toContain('PORTAL_PR_MERGE_QUEUE_PHASE_SET');
  });

  it('retains command validation tables when requested', () => {
    const output = bundle('PORTAL_COMMAND_TYPES_SET');

    expect(output).toContain('portal.auth.validate_code');
    expect(output).toContain('new Set');
  });
});
