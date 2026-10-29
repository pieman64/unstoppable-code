import { isImportablePlanFile } from '@canopy/desktop-shared/importable-plan-file';

describe('isImportablePlanFile', () => {
  it('allows .md and .txt (case-insensitive, multi-dot)', () => {
    expect(isImportablePlanFile('plan.md')).toBe(true);
    expect(isImportablePlanFile('notes.txt')).toBe(true);
    expect(isImportablePlanFile('PLAN.MD')).toBe(true);
    expect(isImportablePlanFile('a.b.txt')).toBe(true);
  });
  it('rejects extension-less files', () => {
    expect(isImportablePlanFile('README')).toBe(false);
    expect(isImportablePlanFile('Makefile')).toBe(false);
  });
  it('rejects other extensions and dotfiles', () => {
    expect(isImportablePlanFile('image.png')).toBe(false);
    expect(isImportablePlanFile('script.ts')).toBe(false);
    expect(isImportablePlanFile('.gitignore')).toBe(false);
    expect(isImportablePlanFile('.env')).toBe(false);
  });
});
