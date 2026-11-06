import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLegacyPatGenerationReader,
  legacyPatCiphertextGeneration,
} from '../legacy-pat-generation';
import { resolveLegacyPatPaths } from '../../secure-data-dir';

const identity = { brandId: 'canopy', build: 'internal' };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pat-generation-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const names = {
  prod: '.secure',
  rc: '.secure-rc',
  internal: '.secure-internal',
  dev: '.secure-dev',
};
const dataDirNames = {
  prod: ['.data'],
  rc: ['.data-rc', '.data'],
  dev: ['.data-dev'],
};

it('mirrors current, internal-shared, then legacy lookup, without decrypting or rewriting', async () => {
  const paths = resolveLegacyPatPaths({
    home: root,
    names,
    dataDirNames,
    mode: 'internal',
    runtimeMode: 'prod',
    environment: {},
  });
  expect(paths).toEqual([
    join(root, '.secure-internal/github-pat.enc'),
    join(root, '.secure/github-pat.enc'),
    join(root, '.data/secure/github-pat.enc'),
  ]);
  const read = createLegacyPatGenerationReader({ identity, paths });
  expect(await read(identity)).toBeNull();
  for (const [index, file] of [...paths.entries()].reverse()) {
    await mkdir(join(file, '..'), { recursive: true });
    const ciphertext = Buffer.from([index, 255, 0, 128]);
    await writeFile(file, ciphertext);
    expect(await read(identity)).toBe(
      legacyPatCiphertextGeneration(ciphertext),
    );
  }
  await writeFile(paths[0], Buffer.from('rotated ciphertext'));
  expect(await read(identity)).toBe(
    legacyPatCiphertextGeneration(Buffer.from('rotated ciphertext')),
  );
  await rm(paths[0]);
  expect(await read(identity)).toBe(
    legacyPatCiphertextGeneration(Buffer.from([1, 255, 0, 128])),
  );
  await rm(paths[1]);
  await rm(paths[2]);
  expect(await read(identity)).toBeNull();
});

it('isolates builds and brands before any read, including unbound identities', async () => {
  const file = join(root, 'ciphertext');
  await writeFile(file, Buffer.from('ciphertext'));
  const read = createLegacyPatGenerationReader({ identity, paths: [file] });
  for (const source of [
    { ...identity, build: 'stable' },
    { ...identity, brandId: 'unstoppable-code' },
    { ...identity, build: '' },
  ])
    await expect(read(source)).rejects.toThrow('identity mismatch');
});

it('does not fall through a read error and hashes empty ciphertext distinctly from absence', async () => {
  const first = join(root, 'first');
  const last = join(root, 'last');
  await mkdir(first);
  await writeFile(last, Buffer.from('older ciphertext'));
  const read = createLegacyPatGenerationReader({
    identity,
    paths: [first, last],
  });
  await expect(read(identity)).rejects.toThrow('generation unavailable');
  await rm(first, { recursive: true });
  await writeFile(first, Buffer.alloc(0));
  expect(await read(identity)).toBe(
    legacyPatCiphertextGeneration(Buffer.alloc(0)),
  );
});

it.each(['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR'])(
  'test override %s disables shared-home fallback',
  (key) => {
    const paths = resolveLegacyPatPaths({
      home: root,
      names,
      dataDirNames,
      mode: 'internal',
      runtimeMode: 'prod',
      environment: { [key]: join(root, 'override') },
    });
    expect(paths).toHaveLength(2);
    expect(paths).not.toContain(join(root, '.secure/github-pat.enc'));
    expect(paths[0]).toBe(
      join(
        root,
        key === 'CANOPY_DATA_DIR'
          ? 'override-secure/github-pat.enc'
          : 'override/github-pat.enc',
      ),
    );
    expect(paths[1]).toBe(
      join(
        root,
        key === 'CANOPY_DATA_DIR'
          ? 'override/secure/github-pat.enc'
          : '.data/secure/github-pat.enc',
      ),
    );
  },
);
