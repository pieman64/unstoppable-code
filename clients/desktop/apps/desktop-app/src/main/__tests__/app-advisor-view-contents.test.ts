import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A `WebContentsView` reads its `webContents` as `undefined` once its page is
 * destroyed (Electron 42). Quit closes App Advisor's page before its window,
 * so a `closed` listener that read `view.webContents.isDestroyed()` threw and
 * main exited 1 (CAN-4863). Main is not loadable here, so this checks that
 * App Advisor reads its view's page once, when the view is made.
 */
describe('App Advisor view page', () => {
  const source = readFileSync(
    path.resolve(__dirname, '..', 'index.ts'),
    'utf8',
  );

  function slice(from: string, to: string): string {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('is read once when the view is made, not again at close', () => {
    const create = slice(
      'async function createAppAdvisorWindowIfMissing(',
      'async function openAppAdvisorWindow(',
    );
    expect(create.match(/\bview\.webContents\b/g) ?? []).toEqual([]);
    expect(create).toContain('const contents = view?.webContents ??');
    expect(create).toMatch(
      /win\.on\('closed', \(\) => \{[\s\S]*?!contents\.isDestroyed\(\)\) contents\.close\(\);/,
    );
  });

  it('is closed at quit through the page read when the view was made', () => {
    const cleanup = slice(
      'async function cleanupRuntimeResources(',
      'function isRecord(',
    );
    expect(cleanup.match(/appAdvisorView\.webContents/g) ?? []).toEqual([]);
    expect(cleanup).toContain(
      'appAdvisorViewContents && !appAdvisorViewContents.isDestroyed()',
    );
  });
});
