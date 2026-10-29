import {
  normalizeCanopyOrganizationSummaries,
  normalizeCanopyOrganizationSummary,
} from '../canopy-cloud/organization-summary';
import { parseAuthoritativeOrganizationSnapshot } from '../canopy-cloud/organization-snapshot';

const base = {
  id: 'org-1',
  name: 'Acme',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
};

describe('normalizeCanopyOrganizationSummary', () => {
  it('preserves the server automatic-conversion exclusion through account persistence', () => {
    for (const excluded of [true, false]) {
      expect(
        normalizeCanopyOrganizationSummary({
          ...base,
          automaticPersonalProjectConversionExcluded: excluded,
        }),
      ).toEqual({
        ...base,
        automaticPersonalProjectConversionExcluded: excluded,
      });
    }
    expect(
      normalizeCanopyOrganizationSummary({
        ...base,
        automaticPersonalProjectConversionExcluded: 'true',
      }),
    ).toEqual(base);
  });
  it('rejects entries missing the required fields', () => {
    expect(normalizeCanopyOrganizationSummary(null)).toBeNull();
    expect(normalizeCanopyOrganizationSummary({ ...base, id: 1 })).toBeNull();
    expect(
      normalizeCanopyOrganizationSummary({ ...base, updatedAt: undefined }),
    ).toBeNull();
  });

  it('strips unknown fields and tolerates an absent role', () => {
    expect(
      normalizeCanopyOrganizationSummary({ ...base, extra: 'ignored' }),
    ).toEqual(base);
  });

  it('preserves a valid role and drops an invalid one without rejecting the entry', () => {
    expect(
      normalizeCanopyOrganizationSummary({ ...base, role: 'OWNER' }),
    ).toEqual({ ...base, role: 'OWNER' });
    expect(
      normalizeCanopyOrganizationSummary({ ...base, role: 'superuser' }),
    ).toEqual(base);
    expect(normalizeCanopyOrganizationSummary({ ...base, role: 7 })).toEqual(
      base,
    );
  });

  it('keeps an http(s) branding logo so the switcher can show it (CAN-3522)', () => {
    const logoUrl = 'https://storage.googleapis.com/branding/acme.png';
    expect(normalizeCanopyOrganizationSummary({ ...base, logoUrl })).toEqual({
      ...base,
      logoUrl,
    });
    expect(
      normalizeCanopyOrganizationSummary({
        ...base,
        logoUrl: 'http://127.0.0.1:4010/org-logo/acme.svg',
      }),
    ).toEqual({ ...base, logoUrl: 'http://127.0.0.1:4010/org-logo/acme.svg' });
    for (const logoUrl of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'not a url',
      '',
      7,
      null,
    ]) {
      expect(normalizeCanopyOrganizationSummary({ ...base, logoUrl })).toEqual(
        base,
      );
    }
  });

  it('keeps a boolean external-sharing setting and drops a malformed one', () => {
    expect(
      normalizeCanopyOrganizationSummary({
        ...base,
        allowExternalContainerSharing: true,
      }),
    ).toEqual({ ...base, allowExternalContainerSharing: true });
    expect(
      normalizeCanopyOrganizationSummary({
        ...base,
        allowExternalContainerSharing: false,
      }),
    ).toEqual({ ...base, allowExternalContainerSharing: false });
    expect(
      normalizeCanopyOrganizationSummary({
        ...base,
        allowExternalContainerSharing: 'yes',
      }),
    ).toEqual(base);
  });

  it('normalizes lists by dropping malformed entries only', () => {
    expect(
      normalizeCanopyOrganizationSummaries([
        { ...base, role: 'MEMBER' },
        { id: 'broken' },
        'nope',
      ]),
    ).toEqual([{ ...base, role: 'MEMBER' }]);
    expect(normalizeCanopyOrganizationSummaries(undefined)).toEqual([]);
  });
});

describe('parseAuthoritativeOrganizationSnapshot role handling', () => {
  it('carries a valid role through the authoritative snapshot', () => {
    expect(
      parseAuthoritativeOrganizationSnapshot([{ ...base, role: 'ADMIN' }]),
    ).toEqual([{ ...base, role: 'ADMIN' }]);
  });

  it('carries an http(s) branding logo and drops any other scheme (CAN-3522)', () => {
    const logoUrl = 'https://storage.googleapis.com/branding/acme.png';
    expect(
      parseAuthoritativeOrganizationSnapshot([{ ...base, logoUrl }]),
    ).toEqual([{ ...base, logoUrl }]);
    expect(
      parseAuthoritativeOrganizationSnapshot([
        { ...base, logoUrl: 'file:///etc/passwd' },
      ]),
    ).toEqual([base]);
  });

  it('drops an invalid role but keeps the snapshot authoritative', () => {
    expect(
      parseAuthoritativeOrganizationSnapshot([{ ...base, role: 'owner' }]),
    ).toEqual([base]);
  });

  it('carries the external-sharing setting without making it required', () => {
    expect(
      parseAuthoritativeOrganizationSnapshot([
        { ...base, allowExternalContainerSharing: true },
        { ...base, id: 'org-2', allowExternalContainerSharing: 'on' },
      ]),
    ).toEqual([
      { ...base, allowExternalContainerSharing: true },
      { ...base, id: 'org-2' },
    ]);
  });

  it('still rejects the whole snapshot on a malformed entry', () => {
    expect(
      parseAuthoritativeOrganizationSnapshot([
        { ...base, role: 'ADMIN' },
        { ...base, id: ' padded ' },
      ]),
    ).toBeNull();
  });
});
