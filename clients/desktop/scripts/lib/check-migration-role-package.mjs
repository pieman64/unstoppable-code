#!/usr/bin/env node
/*
 * Migration-role package check (CAN-4504 VA-5; plan C-10, C-11, W6, W10, W14).
 * Reports whether a packaged macOS app may host the vault migration role and
 * fails only on contradictory or unreadable evidence: a staged daemon carrying
 * the main app's library-validation-off or dyld entitlement, or a daemon whose
 * recorded flavor or build ID differs from the bundle's. Anything merely
 * missing (no staged daemon, no bundle build ID, an unclosed fuse) disables
 * the role and is reported. macOS packages stage a development-build daemon
 * (CAN-4950), so the role stays disabled until CAN-4507 adds the build ID.
 * It reads a finished app: the afterSign hook runs it after fuses and release
 * signing. Usage: node scripts/lib/check-migration-role-package.mjs <App.app>
 */
import { isMigrationRolePackageEligible } from '../../packages/core-platform/src/migration-package-eligibility.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIGRATION_SIGNING_PATTERNS } from '../../packages/core-runtime/src/node/vault/migration-evidence.ts';
import {
  brandBuildIdentity,
  buildIdentityDefines,
  daemonName,
} from '../../packages/protocol/src/brand.ts';
import { listBrandIds, loadBrand } from '../brand/load-brand.mjs';

// Mirrors generate-electron-builder-config.mjs and canopy-paths.ts (W6).
const RELEASE_FLAVORS = Object.freeze({
  stable: { suffix: '', secureMode: 'prod' },
  rc: { suffix: '.rc', secureMode: 'rc' },
  internal: { suffix: '.dev', secureMode: 'internal' },
});

/** A daemon built without `CANOPY_BUILD_ID`; it never migrates. */
export const DEVELOPMENT_FLAVOR = 'development';

/** The launcher identifier and secure mode for one brand and release flavor (C-11). */
export function migrationFlavorIdentity(brand, flavor) {
  if (!Object.hasOwn(RELEASE_FLAVORS, flavor))
    throw new Error(`Unsupported release flavor: ${flavor}`);
  const { suffix, secureMode } = RELEASE_FLAVORS[flavor];
  return Object.freeze({
    flavor,
    identifier: `${brand.appId}${suffix}`,
    secureMode,
  });
}

/**
 * The identity a daemon build compiles in. `CANOPY_BUILD_ID` makes it a
 * release build and then needs an explicit `CANOPY_RELEASE_FLAVOR`. Without a
 * build ID it is a development build, whatever identifier its bundle has: the
 * dev rule is keyed on the build, never on a `.dev` suffix (W6).
 */
export function daemonBuildIdentity({ brand, version, env = process.env }) {
  const base = {
    brandId: brand.id,
    version,
    productIdentity: brandBuildIdentity(
      brand.id,
      env.CANOPY_RELEASE_FLAVOR ?? 'dev',
    ),
    testDataOverrides:
      env.CANOPY_E2E_BUILD === '1' || env.CANOPY_TEST_DATA_OVERRIDES === '1',
  };
  const buildId = env.CANOPY_BUILD_ID ?? '';
  if (buildId === '')
    return Object.freeze({
      ...base,
      flavor: DEVELOPMENT_FLAVOR,
      buildId: '',
      identifier: '',
      secureMode: '',
    });
  if (!MIGRATION_SIGNING_PATTERNS.buildId.test(buildId))
    throw new Error(
      `CANOPY_BUILD_ID must match ${MIGRATION_SIGNING_PATTERNS.buildId}; found ${JSON.stringify(buildId)}.`,
    );
  if (env.CANOPY_RELEASE_FLAVOR === undefined)
    throw new Error('CANOPY_BUILD_ID needs an explicit CANOPY_RELEASE_FLAVOR.');
  return Object.freeze({
    ...base,
    buildId,
    ...migrationFlavorIdentity(brand, env.CANOPY_RELEASE_FLAVOR),
  });
}

/** esbuild defines for the daemon's own flavor; read by the VA-6b wiring. */
export function daemonIdentityDefines(identity) {
  return {
    ...buildIdentityDefines(
      identity.productIdentity.brandId,
      identity.productIdentity.build,
      identity.testDataOverrides,
    ),
    __CANOPY_DAEMON_BUILD_ID__: JSON.stringify(identity.buildId),
    __CANOPY_DAEMON_BUILD_FLAVOR__: JSON.stringify(identity.flavor),
    __CANOPY_DAEMON_BUILD_LAUNCHER_IDENTIFIER__: JSON.stringify(
      identity.identifier,
    ),
    __CANOPY_DAEMON_BUILD_SECURE_MODE__: JSON.stringify(identity.secureMode),
  };
}

/** The build writes the compiled identity beside the executable. */
export function daemonIdentityPath(executablePath) {
  return `${executablePath}.identity.json`;
}

/** Electron fuse wire V1 order, named as in electron-builder's `electronFuses`. */
export const ELECTRON_FUSES = Object.freeze([
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
]);

/**
 * What the migration role needs of main (C-10 option (ii), W14). No waiver
 * input exists: option (i) needs one recorded next to C3 first.
 */
const MIGRATION_FUSE_REQUIREMENTS = Object.freeze({
  runAsNode: 'off',
  enableNodeOptionsEnvironmentVariable: 'off',
  enableNodeCliInspectArguments: 'off',
  enableEmbeddedAsarIntegrityValidation: 'on',
  onlyLoadAppFromAsar: 'on',
});

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const FUSE_STATES = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' };

/** Fuse states from Electron Framework bytes; every slice must agree. */
export function readFuseWire(bytes) {
  const wires = [];
  for (
    let at = bytes.indexOf(FUSE_SENTINEL);
    at !== -1;
    at = bytes.indexOf(FUSE_SENTINEL, at + 1)
  ) {
    const start = at + FUSE_SENTINEL.length;
    if (bytes[start] !== 1)
      throw new Error(`Unsupported Electron fuse wire version ${bytes[start]}`);
    const end = start + 2 + bytes[start + 1];
    if (end > bytes.length) throw new Error('Truncated Electron fuse wire');
    wires.push(bytes.subarray(start + 2, end).toString('latin1'));
  }
  if (wires.length === 0) throw new Error('No Electron fuse wire found');
  if (new Set(wires).size !== 1)
    throw new Error('Electron fuse wires differ between slices');
  return Object.fromEntries(
    ELECTRON_FUSES.map((name, index) => [
      name,
      index < wires[0].length
        ? (FUSE_STATES[wires[0].charCodeAt(index)] ?? 'unknown')
        : 'absent',
    ]),
  );
}

/** W10: the main plist's keys a daemon must never carry. */
export const FORBIDDEN_DAEMON_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
]);

function plistJson(input, path) {
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', path], {
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    }),
  );
}

/** Reads a plist file through `plutil`. */
function readPlist(path) {
  return plistJson(undefined, path);
}

/** Signed entitlements of a Mach-O; throws when it is not signed. */
export function readCodeSignEntitlements(path, arch) {
  const xml = execFileSync(
    'codesign',
    [
      '-d',
      '--entitlements',
      '-',
      '--xml',
      ...(arch ? ['--arch', arch] : []),
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return xml.length === 0 ? {} : plistJson(xml, '-');
}

/** Every (brand, flavor) whose launcher identifier is `identifier`. */
export function bundleFlavors(identifier, brands) {
  return brands.flatMap((brand) =>
    Object.keys(RELEASE_FLAVORS)
      .map((flavor) => ({
        brandId: brand.id,
        ...migrationFlavorIdentity(brand, flavor),
      }))
      .filter((identity) => identity.identifier === identifier),
  );
}

function loadBrands() {
  return listBrandIds().map((id) => loadBrand(id));
}

// Anywhere in the bundle, though staging puts it in Resources/bin (CAN-4950):
// a stray copy elsewhere still counts.
function findStagedDaemons(appPath, brands) {
  const names = new Set(brands.map((brand) => daemonName(brand)));
  return readdirSync(join(appPath, 'Contents'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && names.has(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const IDENTITY_FIELDS = ['buildId', 'flavor', 'identifier'];

/** `null` when absent; `undefined` (with a violation) when present but bad. */
function readDaemonIdentity(path, violations) {
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    violations.push(`daemon identity is unreadable: ${error.message}`);
    return undefined;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    IDENTITY_FIELDS.every((field) => typeof value[field] === 'string')
  )
    return value;
  violations.push(`daemon identity is malformed: ${path}`);
  return undefined;
}

function inspectDaemon(path, bundle, readEntitlements, disabled, violations) {
  let entitlements;
  try {
    entitlements = readEntitlements(path);
  } catch (error) {
    violations.push(`daemon entitlements are unreadable: ${error.message}`);
    entitlements = {};
  }
  // Presence alone fails: the inherit plist reached the daemon (W10).
  for (const key of FORBIDDEN_DAEMON_ENTITLEMENTS)
    if (Object.hasOwn(entitlements, key))
      violations.push(`daemon carries the main-app entitlement ${key}`);

  const identity = readDaemonIdentity(daemonIdentityPath(path), violations);
  if (identity === null) disabled.push('daemon:identity-missing');
  else if (identity === undefined) {
    // Present but unusable: already a violation.
  } else if (identity.flavor === DEVELOPMENT_FLAVOR)
    disabled.push('daemon:development-build');
  else {
    if (identity.identifier !== bundle.identifier)
      violations.push(
        `daemon expects launcher ${identity.identifier} (${identity.flavor}); bundle is ${bundle.identifier}`,
      );
    if (bundle.buildId === null) disabled.push('bundle:no-build-id');
    else if (identity.buildId !== bundle.buildId)
      violations.push(
        `daemon build ${identity.buildId} differs from bundle build ${bundle.buildId}`,
      );
  }
  return {
    path,
    entitlements: Object.keys(entitlements).sort(),
    identity: identity ?? null,
  };
}

/** Inspects a packaged `.app`; `fuses.states` is a `readFuseWire` result. */
export function inspectMigrationRolePackage({
  appPath,
  fuses,
  brands = loadBrands(),
  readInfoPlist = readPlist,
  readEntitlements = readCodeSignEntitlements,
}) {
  const info = readInfoPlist(join(appPath, 'Contents', 'Info.plist'));
  const identifier = String(info.CFBundleIdentifier ?? '');
  const flavors = bundleFlavors(identifier, brands);
  const bundle = {
    identifier,
    buildId: typeof info.CanopyBuildId === 'string' ? info.CanopyBuildId : null,
    flavor: flavors.length === 1 ? flavors[0] : null,
  };
  const disabled = [];
  const violations = [];
  if (flavors.length === 0) disabled.push('bundle:unknown-flavor');
  if (flavors.length > 1) disabled.push('bundle:ambiguous-flavor');

  for (const [name, required] of Object.entries(MIGRATION_FUSE_REQUIREMENTS))
    if (fuses.states[name] !== required) disabled.push(`fuse:${name}`);

  const staged = findStagedDaemons(appPath, brands);
  if (staged.length > 1)
    violations.push(`more than one staged daemon: ${staged.join(', ')}`);
  const daemon =
    staged.length === 0
      ? null
      : inspectDaemon(
          staged[0],
          bundle,
          readEntitlements,
          disabled,
          violations,
        );
  if (daemon === null) disabled.push('daemon:not-staged');

  return {
    appPath,
    bundle,
    fuses,
    daemon,
    migrationRole:
      disabled.length === 0 && violations.length === 0
        ? 'eligible'
        : 'disabled',
    disabledReasons: disabled,
    violations,
  };
}

/** Inspects a fused and signed `.app`, reading its Electron fuse wire. */
export function inspectFinishedApp(appPath, options = {}) {
  const framework = join(
    appPath,
    'Contents/Frameworks/Electron Framework.framework/Electron Framework',
  );
  return inspectMigrationRolePackage({
    ...options,
    appPath,
    fuses: { source: 'binary', states: readFuseWire(readFileSync(framework)) },
  });
}

export function formatMigrationRoleReport(report) {
  const { bundle, fuses, daemon } = report;
  const flavor = bundle.flavor
    ? `${bundle.flavor.flavor}, secure mode ${bundle.flavor.secureMode}`
    : 'unknown flavor';
  return [
    `Migration role: ${report.migrationRole}`,
    `  bundle: ${bundle.identifier} (${flavor}), build ${bundle.buildId ?? 'none'}`,
    `  fuses (${fuses.source}): ${ELECTRON_FUSES.map((name) => `${name}=${fuses.states[name]}`).join(' ')}`,
    `  daemon: ${daemon ? `${daemon.path}; entitlements [${daemon.entitlements.join(', ')}]` : 'not staged'}`,
    ...report.disabledReasons.map((reason) => `  disabled: ${reason}`),
    ...report.violations.map((violation) => `  violation: ${violation}`),
  ].join('\n');
}

// Reporting remains permissive for intentionally inert packages. Admission must
// separately require positive eligibility and authenticated runtime verification.
export function assertMigrationRolePackageEligible(report) {
  if (!isMigrationRolePackageEligible(report))
    throw new Error('Migration-role package is not eligible.');
}

export function assertMigrationRolePackage(report) {
  if (report.violations.length > 0)
    throw new Error(
      `Migration-role package check failed:\n${report.violations.map((v) => `- ${v}`).join('\n')}`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const appPath = process.argv[2] ? resolve(process.argv[2]) : '';
    if (!appPath.endsWith('.app')) throw new Error('Usage: <App.app>');
    const report = inspectFinishedApp(appPath);
    console.log(formatMigrationRoleReport(report));
    assertMigrationRolePackage(report);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
