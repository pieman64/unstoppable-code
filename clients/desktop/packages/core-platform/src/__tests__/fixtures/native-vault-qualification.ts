/** Trusted qualification producer only. Release bundles replace the global with a literal. */
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createNativeArtifactAuthorizer,
  loadPreparedNativeArtifact,
  type PreparedNativeArtifact,
} from '../../secret-protection/authorization';
import { createSecureFileServices } from '../../secure-files';
import {
  NATIVE_CATALOG_PREFIX,
  NATIVE_CATALOG_SUFFIX,
  NATIVE_DEPENDENCY_POLICIES,
  type NativeArtifactCatalog,
} from '../../secret-protection/catalog';

export async function prepareNativeQualification(
  source: string,
  root: string,
  snapshotDataRoot = join(root, 'qualified-application-data'),
): Promise<{
  capability: PreparedNativeArtifact;
  native: unknown;
  dispose: () => Promise<void>;
}> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
    throw new Error('Unsupported qualification host');
  const bytes = readFileSync(source);
  const catalog: NativeArtifactCatalog = {
    schema: 1,
    generation: 'qualification-product',
    brandId: 'canopy',
    build: 'dev',
    version: 'qualification',
    buildId: '',
    member: {
      id: 'vault-key-slots',
      filename: 'core-secret-protection.node',
      platform,
      architectures: platform === 'darwin' ? ['arm64', 'x64'] : [process.arch],
      compatibility: 'node-api-8-product-v1',
      dependencyPolicy: NATIVE_DEPENDENCY_POLICIES[platform],
      state: 'present',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  Reflect.set(
    globalThis,
    '__CANOPY_NATIVE_ARTIFACT_CATALOG__',
    `${NATIVE_CATALOG_PREFIX}${Buffer.from(JSON.stringify(catalog)).toString('base64')}${NATIVE_CATALOG_SUFFIX}`,
  );
  const distribution = join(root, 'qualified-distribution');
  const data = snapshotDataRoot;
  mkdirSync(distribution, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700, recursive: true });
  copyFileSync(source, join(distribution, catalog.member.filename));
  const authorizer = createNativeArtifactAuthorizer({
    canonicalDataRoot: realpathSync(data),
    distributionDirectory: realpathSync(distribution),
    secureFiles: createSecureFileServices(platform),
    supervision: {
      inspectProcess: ({ pid }) =>
        Promise.resolve(
          pid === process.pid
            ? {
                state: 'running',
                startIdentity: `qualification:${process.pid}`,
              }
            : { state: 'unverifiable', reason: 'not the fixture process' },
        ),
    },
  });
  const capability = await authorizer.prepare();
  if (!capability) throw new Error('Qualification native preparation refused');
  return {
    capability,
    native: loadPreparedNativeArtifact(capability),
    dispose: () => authorizer.dispose(),
  };
}
