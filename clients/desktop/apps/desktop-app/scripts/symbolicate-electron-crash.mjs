#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const DEFAULT_CACHE_DIR = resolve(REPO_ROOT, '.cache/electron-symbols');
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);
const ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_PATTERN = /^0x[0-9a-f]+$/i;

function normalizeUuid(uuid) {
  const normalized = uuid.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return normalized;
}

function assertSupportedArch(arch) {
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error('Electron symbolication arch must be arm64 or x64');
  }
}

function assertAddress(address, label) {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error(`${label} must be a hexadecimal address`);
  }
}

export function buildElectronSymbolsArtifactRequest({ version, arch }) {
  if (!ELECTRON_VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a valid Electron version, received: ${version}`);
  }
  assertSupportedArch(arch);

  return {
    version,
    platform: 'darwin',
    arch,
    artifactName: 'electron',
    artifactSuffix: 'symbols',
  };
}

export function parseElectronCrashFrames(stack) {
  const frames = [];
  const loadAddresses = new Set();
  const framePattern =
    /^\s*\d+\s+Electron Framework\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+\+\s+\d+\s*$/i;

  for (const line of stack.split(/\r?\n/)) {
    const match = line.match(framePattern);
    if (!match) {
      continue;
    }
    frames.push(match[1]);
    loadAddresses.add(match[2]);
  }

  if (frames.length === 0) {
    throw new Error('Crash stack does not contain Electron Framework frames');
  }
  if (loadAddresses.size !== 1) {
    throw new Error(
      'Crash stack contains multiple Electron Framework load addresses',
    );
  }

  return {
    loadAddress: [...loadAddresses][0],
    addresses: frames,
  };
}

export function parseBreakpadModule(line) {
  const match = line.match(/^MODULE\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+(.+)$/i);
  if (!match || match[3].length < 32) {
    throw new Error(
      'Electron Breakpad symbols do not contain a valid MODULE record',
    );
  }

  const rawUuid = match[3].slice(0, 32);
  const uuid = [
    rawUuid.slice(0, 8),
    rawUuid.slice(8, 12),
    rawUuid.slice(12, 16),
    rawUuid.slice(16, 20),
    rawUuid.slice(20),
  ].join('-');

  return {
    os: match[1],
    arch: match[2],
    uuid: normalizeUuid(uuid),
    name: match[4],
  };
}

export function assertMatchingUuid({ expectedUuid, arch, module }) {
  assertSupportedArch(arch);
  const normalizedExpected = normalizeUuid(expectedUuid);
  const expectedModuleArch = arch === 'x64' ? 'x86_64' : arch;
  if (
    module.arch !== expectedModuleArch ||
    module.uuid !== normalizedExpected
  ) {
    throw new Error(
      `Electron symbol module does not contain expected UUID ${normalizedExpected} (${arch}); available: ${module.uuid} (${module.arch})`,
    );
  }
}

function createBreakpadResolver(offsets) {
  const frames = offsets.map((offset) => {
    assertAddress(offset, 'Electron Framework offset');
    return {
      offset,
      numericOffset: BigInt(offset),
      function: '',
      functionOffset: null,
      fileId: null,
      file: '',
      line: null,
    };
  });
  const files = new Map();
  let module = null;
  let currentFunction = null;

  function consume(line) {
    if (line.startsWith('MODULE ')) {
      module = parseBreakpadModule(line);
      return;
    }

    const fileMatch = line.match(/^FILE\s+(\d+)\s+(.+)$/);
    if (fileMatch) {
      files.set(Number(fileMatch[1]), fileMatch[2]);
      return;
    }

    const functionMatch = line.match(
      /^FUNC\s+(?:m\s+)?([0-9a-f]+)\s+([0-9a-f]+)\s+[0-9a-f]+\s+(.+)$/i,
    );
    if (functionMatch) {
      const start = BigInt(`0x${functionMatch[1]}`);
      const size = BigInt(`0x${functionMatch[2]}`);
      currentFunction = { start, end: start + size };
      for (const frame of frames) {
        if (
          frame.numericOffset >= start &&
          frame.numericOffset < start + size
        ) {
          frame.function = functionMatch[3];
          frame.functionOffset = Number(frame.numericOffset - start);
        }
      }
      return;
    }

    if (!currentFunction) {
      return;
    }
    const lineMatch = line.match(
      /^([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+)\s+(\d+)$/i,
    );
    if (!lineMatch) {
      return;
    }
    const start = BigInt(`0x${lineMatch[1]}`);
    const end = start + BigInt(`0x${lineMatch[2]}`);
    for (const frame of frames) {
      if (
        frame.numericOffset >= currentFunction.start &&
        frame.numericOffset < currentFunction.end &&
        frame.numericOffset >= start &&
        frame.numericOffset < end
      ) {
        frame.line = Number(lineMatch[3]);
        frame.fileId = Number(lineMatch[4]);
      }
    }
  }

  function finish() {
    if (!module) {
      throw new Error(
        'Electron Breakpad symbols are missing their MODULE record',
      );
    }
    return {
      module,
      frames: frames.map((frame) => ({
        offset: frame.offset,
        function: frame.function,
        functionOffset: frame.functionOffset,
        file: frame.fileId === null ? '' : (files.get(frame.fileId) ?? ''),
        line: frame.line,
      })),
    };
  }

  return { consume, finish };
}

export function resolveBreakpadSymbolText({ text, offsets }) {
  const resolver = createBreakpadResolver(offsets);
  for (const line of text.split(/\r?\n/)) {
    resolver.consume(line);
  }
  return resolver.finish().frames;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(
      `${basename(command)} failed to start: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.signal) {
    throw new Error(
      `${basename(command)} terminated by signal ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} exited with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function findElectronBreakpadSymbols(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (
        entry.isFile() &&
        entry.name === 'Electron Framework.sym' &&
        current.includes(`${join('breakpad_symbols', 'Electron Framework')}`)
      ) {
        return entryPath;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      pending.push(entryPath);
    }
  }
  return null;
}

async function loadElectronArtifactDownloader() {
  const require = createRequire(import.meta.url);
  const electronPackageJsonPath = require.resolve('electron/package.json');
  const electronRequire = createRequire(electronPackageJsonPath);
  const electronGetPath = electronRequire.resolve('@electron/get');
  return import(pathToFileURL(electronGetPath).href);
}

function readInstalledElectronVersion() {
  const require = createRequire(import.meta.url);
  const packageJson = JSON.parse(
    readFileSync(require.resolve('electron/package.json'), 'utf8'),
  );
  if (typeof packageJson.version !== 'string') {
    throw new Error('Installed electron package does not declare a version');
  }
  return packageJson.version;
}

async function prepareElectronBreakpadSymbols({ version, arch, cacheDir }) {
  const destination = resolve(cacheDir, version, `darwin-${arch}`);
  if (existsSync(destination)) {
    const cachedSymbols = findElectronBreakpadSymbols(destination);
    if (!cachedSymbols) {
      throw new Error(
        `Electron symbols cache exists without Electron Framework.sym: ${destination}`,
      );
    }
    return cachedSymbols;
  }

  const request = buildElectronSymbolsArtifactRequest({ version, arch });
  const { downloadArtifact } = await loadElectronArtifactDownloader();
  const archivePath = await downloadArtifact(request);
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDirectory = mkdtempSync(
    join(dirname(destination), '.extract-'),
  );

  try {
    const archiveEntries = runCommand('/usr/bin/unzip', ['-Z1', archivePath]);
    const symbolEntry = archiveEntries
      .split(/\r?\n/)
      .find((entry) =>
        entry.match(
          /^breakpad_symbols\/Electron Framework\/[^/]+\/Electron Framework\.sym$/,
        ),
      );
    if (!symbolEntry) {
      throw new Error(
        `Electron symbols archive did not contain Electron Framework.sym: ${archivePath}`,
      );
    }
    runCommand('/usr/bin/unzip', [
      '-qq',
      archivePath,
      symbolEntry,
      '-d',
      temporaryDirectory,
    ]);
    const extractedSymbols = findElectronBreakpadSymbols(temporaryDirectory);
    if (!extractedSymbols) {
      throw new Error(
        `Failed to extract Electron Framework.sym: ${archivePath}`,
      );
    }
    const relativeSymbols = extractedSymbols.slice(
      temporaryDirectory.length + 1,
    );
    renameSync(temporaryDirectory, destination);
    return join(destination, relativeSymbols);
  } finally {
    if (existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function resolveBreakpadSymbolFile({ symbolFilePath, offsets }) {
  const resolver = createBreakpadResolver(offsets);
  const lines = createInterface({
    input: createReadStream(symbolFilePath),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    resolver.consume(line);
  }
  return resolver.finish();
}

function relativeOffset(address, loadAddress) {
  assertAddress(address, 'Electron Framework frame');
  assertAddress(loadAddress, 'Electron Framework load address');
  const offset = BigInt(address) - BigInt(loadAddress);
  if (offset < 0n) {
    throw new Error(
      `Electron Framework frame ${address} is below load address ${loadAddress}`,
    );
  }
  return `0x${offset.toString(16)}`;
}

function parseArguments(argv) {
  const options = {
    version: '',
    arch: process.arch,
    expectedUuid: '',
    stackFile: '',
    loadAddress: '',
    addresses: [],
    cacheDir: DEFAULT_CACHE_DIR,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--version') {
      options.version = argv[++index] ?? '';
    } else if (argument === '--arch') {
      options.arch = argv[++index] ?? '';
    } else if (argument === '--uuid') {
      options.expectedUuid = argv[++index] ?? '';
    } else if (argument === '--stack-file') {
      options.stackFile = argv[++index] ?? '';
    } else if (argument === '--load-address') {
      options.loadAddress = argv[++index] ?? '';
    } else if (argument === '--cache-dir') {
      options.cacheDir = resolve(argv[++index] ?? '');
    } else if (argument === '--address') {
      options.addresses.push(argv[++index] ?? '');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function usage() {
  return `Usage:
  pnpm run crash:symbolicate:electron \\
    --version 42.3.0 \\
    --arch arm64 \\
    --uuid 4C4C4416-5555-3144-A1EA-B6C25F353230 \\
    --stack-file /path/to/crash-stack.txt

Alternatively, pass --load-address once and repeat --address for each Electron
Framework runtime address. Symbols are cached under .cache/electron-symbols.`;
}

function writeStdout(message) {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    writeStdout(usage());
    return;
  }
  if (!options.expectedUuid) {
    throw new Error('--uuid is required for Electron symbol verification');
  }

  const version = options.version || readInstalledElectronVersion();
  buildElectronSymbolsArtifactRequest({ version, arch: options.arch });

  let loadAddress = options.loadAddress;
  let addresses = options.addresses;
  if (options.stackFile) {
    const parsed = parseElectronCrashFrames(
      readFileSync(resolve(options.stackFile), 'utf8'),
    );
    loadAddress = parsed.loadAddress;
    addresses = parsed.addresses;
  }
  if (!loadAddress || addresses.length === 0) {
    throw new Error(
      'Provide --stack-file, or provide --load-address with at least one --address',
    );
  }

  const symbolFilePath = await prepareElectronBreakpadSymbols({
    version,
    arch: options.arch,
    cacheDir: options.cacheDir,
  });
  const offsets = addresses.map((address) =>
    relativeOffset(address, loadAddress),
  );
  const resolved = await resolveBreakpadSymbolFile({
    symbolFilePath,
    offsets,
  });
  assertMatchingUuid({
    expectedUuid: options.expectedUuid,
    arch: options.arch,
    module: resolved.module,
  });
  const frames = addresses.map((address, index) => ({
    address,
    ...resolved.frames[index],
  }));

  if (options.json) {
    writeStdout(
      JSON.stringify(
        {
          version,
          arch: options.arch,
          symbolFilePath,
          module: resolved.module,
          loadAddress,
          frames,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdout(`Electron ${version} ${options.arch}`);
  writeStdout(`Symbols: ${symbolFilePath}`);
  writeStdout(`UUID: ${resolved.module.uuid}`);
  for (const frame of frames) {
    const source = frame.file ? ` (${frame.file}:${frame.line ?? '?'})` : '';
    const symbol = frame.function
      ? `${frame.function} + ${frame.functionOffset}${source}`
      : '<unresolved>';
    writeStdout(`${frame.address}  ${symbol}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeStderr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
