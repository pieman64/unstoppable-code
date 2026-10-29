import type { ScriptOverrides } from '@canopy/desktop-shared/scripts';
import { normalizeLegacyScriptFields } from '../lib/script-config';

describe('normalizeLegacyScriptFields', () => {
  it('returns undefined for empty input', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({});
    expect(result).toBeUndefined();
  });

  it('maps setupScript to setup', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      setupScript: 'npm install',
    });
    expect(result).toEqual({ setup: 'npm install' });
  });

  it('maps teardownScript to teardown', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      teardownScript: 'npm run clean',
    });
    expect(result).toEqual({ teardown: 'npm run clean' });
  });

  it('maps launchScript to launch', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      launchScript: 'npm run dev',
    });
    expect(result).toEqual({ launch: 'npm run dev' });
  });

  it('maps runScript to launch when launchScript is absent', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      runScript: 'npm start',
    });
    expect(result).toEqual({ launch: 'npm start' });
  });

  it('prefers launchScript over runScript', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      launchScript: 'npm run dev',
      runScript: 'npm start',
    });
    expect(result).toEqual({ launch: 'npm run dev' });
  });

  it('embedded scripts override legacy fields', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: { setup: 'from-map' },
      setupScript: 'from-legacy',
    });
    expect(result).toEqual({ setup: 'from-map' });
  });

  it('preserves null values (explicit script disable)', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      setupScript: null,
    });
    expect(result).toEqual({ setup: null });
  });

  it('strips whitespace-only values', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      setupScript: '   ',
    });
    expect(result).toBeUndefined();
  });

  it('strips empty string values', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      teardownScript: '',
    });
    expect(result).toBeUndefined();
  });

  it('keeps valid scripts and strips empty ones', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      setupScript: 'npm install',
      teardownScript: '',
    });
    expect(result).toEqual({ setup: 'npm install' });
  });

  it('ignores non-string, non-null values', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      setupScript: 42,
    });
    expect(result).toBeUndefined();
  });

  it('handles embedded scripts with null', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: { setup: null },
    });
    expect(result).toEqual({ setup: null });
  });

  it('preserves embedded object script definitions', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: {
        setup: {
          command: ' npm install ',
          timeoutSeconds: 900,
        },
      },
    });
    expect(result).toEqual({
      setup: {
        command: 'npm install',
        timeoutSeconds: 900,
      },
    });
  });

  it('drops embedded object scripts with invalid shapes', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: {
        setup: { command: '   ', timeoutSeconds: 900 },
        launch: { timeoutSeconds: 900 },
        teardown: 'npm run clean',
      },
    });
    expect(result).toEqual({ teardown: 'npm run clean' });
  });

  it('returns multiple fields in lifecycle sort order', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      teardownScript: 'npm run clean',
      setupScript: 'npm install',
      launchScript: 'npm start',
    });
    expect(result).toEqual({
      setup: 'npm install',
      launch: 'npm start',
      teardown: 'npm run clean',
    });
    // Verify key order matches lifecycle order
    const keys = Object.keys(result ?? {});
    expect(keys).toEqual(['setup', 'launch', 'teardown']);
  });

  it('embedded scripts can contain custom script names', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: { setup: 'npm install', 'dev-server': 'npm run dev' },
    });
    expect(result).toEqual({
      setup: 'npm install',
      'dev-server': 'npm run dev',
    });
  });

  it('ignores non-object scripts field', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: 'not-an-object',
    });
    expect(result).toBeUndefined();
  });

  it('ignores array scripts field', () => {
    const result: ScriptOverrides | undefined = normalizeLegacyScriptFields({
      scripts: ['npm install'],
    });
    expect(result).toBeUndefined();
  });
});
