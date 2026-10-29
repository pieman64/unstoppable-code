// Diagnostic only: launched by the final packaged Electron, never shipped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function probe(appDir, outputDir) {
  appDir = fs.realpathSync(appDir);
  const result = {
    schemaVersion: 1,
    status: 'failed',
    stage: 'target',
    platform: process.platform,
    arch: process.arch,
    target: null,
    versions: { ...process.versions },
    loadedPaths: [],
    loadErrors: [],
    pty: null,
    ffi: null,
    diagnostic: null,
  };
  let terminal;
  const timer = setTimeout(() => {
    result.diagnostic = 'Native runtime probe timed out';
    finish(1);
  }, 60000);
  function finish(code) {
    clearTimeout(timer);
    try {
      terminal?.kill();
    } catch {
      // PTY exit can race failure cleanup.
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const temp = path.join(outputDir, `runtime-${process.pid}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
    fs.renameSync(temp, path.join(outputDir, 'runtime.json'));
    if (code !== 0) {
      console.error(result.diagnostic);
      for (const entry of result.loadErrors)
        console.error(`Native load ${entry.logicalPath}: ${entry.diagnostic}`);
    }
    process.exit(code);
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(appDir, 'resources/native-modules.json'),
        'utf8',
      ),
    );
    if (!['linux-x64', 'linux-arm64'].includes(manifest.target))
      throw new Error(`Unsupported native runtime target: ${manifest.target}`);
    const arch = manifest.target === 'linux-arm64' ? 'arm64' : 'x64';
    if (process.platform !== 'linux' || process.arch !== arch)
      throw new Error(`Native runtime requires Linux ${arch}`);
    result.target = `linux-${arch}`;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.target !== result.target ||
      manifest.electron.version !== process.versions.electron ||
      manifest.electron.node !== process.versions.node ||
      manifest.electron.modules !== process.versions.modules ||
      manifest.electron.napi !== process.versions.napi
    )
      throw new Error('Packaged Electron version/ABI mismatch');
    result.stage = 'load';
    const loaded = [];
    const originalDlopen = process.dlopen;
    process.dlopen = function (module, filename, ...options) {
      const expected = manifest.modules.find(
        (entry) =>
          path.resolve(appDir, entry.archivePath, entry.logicalPath) ===
            path.resolve(filename) ||
          path.resolve(appDir, entry.physicalPath) === path.resolve(filename),
      );
      if (!expected || /prebuilds|@koromix/.test(filename))
        throw new Error(`Unexpected native addon loaded: ${filename}`);
      const physical = path.resolve(appDir, expected.physicalPath);
      if (fs.realpathSync(physical) !== physical)
        throw new Error(`Native addon follows a symlink: ${physical}`);
      const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(physical))
        .digest('hex');
      if (digest !== expected.sha256)
        throw new Error(`Loaded native hash mismatch: ${filename}`);
      let value;
      try {
        // Omitted flags must stay omitted: forwarding undefined as a third
        // argument coerces to mode 0, which Linux dlopen rejects.
        value = originalDlopen.call(this, module, filename, ...options);
      } catch (error) {
        if (result.loadErrors.length < 16)
          result.loadErrors.push({
            logicalPath: expected.logicalPath,
            diagnostic: String(error.message).slice(0, 4096),
          });
        throw error;
      }
      loaded.push({
        name: expected.name,
        logicalPath: expected.logicalPath,
        physicalPath: expected.physicalPath,
        sha256: digest,
      });
      return value;
    };
    let pty;
    let koffi;
    try {
      pty = require(
        path.join(appDir, 'resources/app.asar/node_modules/node-pty'),
      );
      koffi = require(
        path.join(appDir, 'resources/app.asar/node_modules/koffi'),
      );
    } finally {
      process.dlopen = originalDlopen;
    }
    if (
      loaded.length !== manifest.modules.length ||
      manifest.modules.some(
        (entry) =>
          loaded.filter((item) => item.name === entry.name).length !== 1,
      )
    )
      throw new Error(
        'Packaged loaders did not load exactly the inventoried addons',
      );
    result.loadedPaths = loaded;
    result.stage = 'ffi';
    const library = koffi.load('libc.so.6');
    const pid = library.func('int getpid(void)')();
    result.ffi = { passed: pid === process.pid, pid, expectedPid: process.pid };
    if (!result.ffi.passed) throw new Error('Koffi libc getpid() failed');
    result.stage = 'pty';
    const marker = 'CAN3208_NATIVE_PTY_OK';
    result.pty = await new Promise((resolve, reject) => {
      let output = '';
      terminal = pty.spawn(
        '/bin/sh',
        [
          '-c',
          `[ -t 0 ] || exit 31; printf 'CAN3208_READY\\n'; IFS= read -r line; [ "$line" = 'can3208-input' ] || exit 32; printf '${marker}\\n'`,
        ],
        {
          name: 'xterm',
          cols: 80,
          rows: 24,
          cwd: outputDir,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
      );
      let written = false;
      terminal.onData((data) => {
        output += data;
        if (output.length > 65536) {
          terminal.kill();
          reject(new Error('PTY output exceeded limit'));
          return;
        }
        if (!written && output.includes('CAN3208_READY')) {
          written = true;
          terminal.write('can3208-input\r');
        }
      });
      terminal.onExit(({ exitCode, signal }) => {
        const value = {
          passed:
            written && output.includes(marker) && exitCode === 0 && !signal,
          inputWritten: written,
          marker,
          output,
          exitCode,
          signal: signal ?? null,
        };
        if (!value.passed)
          reject(new Error(`Packaged PTY failed: ${JSON.stringify(value)}`));
        else resolve(value);
      });
    });
    terminal = undefined;
    result.status = 'passed';
    result.stage = 'complete';
    finish(0);
  } catch (error) {
    result.diagnostic = error.message;
    finish(1);
  }
}

if (require.main === module)
  probe(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
