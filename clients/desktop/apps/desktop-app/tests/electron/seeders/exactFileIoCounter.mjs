/**
 * Temporary Electron-main attribution for deterministic I/O workloads.
 * Counts logical API bytes, not physical disk traffic. Install around one
 * operation at a time and always stop in a finally block.
 */
export async function installExactFileIoCounter(electronApp, trackedPaths) {
  await electronApp.evaluate((_electron, paths) => {
    if (globalThis.__exactFileIoCounter) {
      throw new Error('Exact file I/O counter is already installed');
    }
    const { createRequire, syncBuiltinESMExports } =
      process.getBuiltinModule('node:module');
    const require = createRequire(`${process.cwd()}/package.json`);
    const fsPromises = require('node:fs/promises');
    const path = require('node:path');
    const tracked = new Set(paths.map((value) => path.resolve(value)));
    const counters = Object.fromEntries(
      Array.from(tracked, (value) => [
        value,
        {
          readFileCalls: 0,
          openCalls: 0,
          readCalls: 0,
          readBytes: 0,
          handleStatCalls: 0,
          writeFileCalls: 0,
          appendFileCalls: 0,
          writeBytes: 0,
          renameCalls: 0,
          statCalls: 0,
          mkdirCalls: 0,
        },
      ]),
    );
    const original = {
      readFile: fsPromises.readFile,
      open: fsPromises.open,
      writeFile: fsPromises.writeFile,
      appendFile: fsPromises.appendFile,
      rename: fsPromises.rename,
      stat: fsPromises.stat,
      mkdir: fsPromises.mkdir,
      stringify: JSON.stringify,
    };
    let activeTrackedHandles = 0;
    let activeTrackedOperations = 0;
    const trackedOperation = async (key, work) => {
      if (key) activeTrackedOperations += 1;
      try {
        return await work();
      } finally {
        if (key) activeTrackedOperations -= 1;
      }
    };
    const pathKey = (value) => {
      if (typeof value !== 'string' && !(value instanceof URL)) return null;
      const key = path.resolve(value instanceof URL ? value.pathname : value);
      if (tracked.has(key)) return key;
      for (const canonical of tracked) {
        if (key.startsWith(`${canonical}.`) && key.endsWith('.tmp')) {
          return canonical;
        }
      }
      return null;
    };
    const directoryKey = (value) => {
      if (typeof value !== 'string') return null;
      const directory = path.resolve(value);
      for (const canonical of tracked) {
        if (path.dirname(canonical) === directory) return canonical;
      }
      return null;
    };
    const bytesOf = (value) =>
      typeof value === 'string'
        ? Buffer.byteLength(value)
        : (value?.byteLength ?? 0);
    fsPromises.readFile = async (filePath, ...args) => {
      const key = pathKey(filePath);
      if (key) counters[key].readFileCalls += 1;
      const result = await trackedOperation(key, () =>
        original.readFile(filePath, ...args),
      );
      if (key) counters[key].readBytes += bytesOf(result);
      return result;
    };
    fsPromises.open = async (filePath, ...args) => {
      const key = pathKey(filePath);
      if (key) counters[key].openCalls += 1;
      const handle = await trackedOperation(key, () =>
        original.open(filePath, ...args),
      );
      if (key) {
        activeTrackedHandles += 1;
        const read = handle.read.bind(handle);
        const stat = handle.stat.bind(handle);
        const close = handle.close.bind(handle);
        handle.read = async (...readArgs) => {
          counters[key].readCalls += 1;
          const result = await trackedOperation(key, () => read(...readArgs));
          counters[key].readBytes += result.bytesRead;
          return result;
        };
        handle.stat = async (...statArgs) => {
          counters[key].handleStatCalls += 1;
          return trackedOperation(key, () => stat(...statArgs));
        };
        handle.close = async (...closeArgs) => {
          try {
            return await close(...closeArgs);
          } finally {
            activeTrackedHandles -= 1;
          }
        };
      }
      return handle;
    };
    fsPromises.writeFile = async (filePath, value, ...args) => {
      const key = pathKey(filePath);
      const result = await trackedOperation(key, () =>
        original.writeFile(filePath, value, ...args),
      );
      if (key) {
        counters[key].writeFileCalls += 1;
        counters[key].writeBytes += bytesOf(value);
      }
      return result;
    };
    fsPromises.appendFile = async (filePath, value, ...args) => {
      const key = pathKey(filePath);
      const result = await trackedOperation(key, () =>
        original.appendFile(filePath, value, ...args),
      );
      if (key) {
        counters[key].appendFileCalls += 1;
        counters[key].writeBytes += bytesOf(value);
      }
      return result;
    };
    fsPromises.rename = async (from, to) => {
      const key = pathKey(to);
      const result = await trackedOperation(key, () =>
        original.rename(from, to),
      );
      if (key) counters[key].renameCalls += 1;
      return result;
    };
    fsPromises.stat = async (filePath, ...args) => {
      const key = pathKey(filePath);
      if (key) counters[key].statCalls += 1;
      return trackedOperation(key, () => original.stat(filePath, ...args));
    };
    fsPromises.mkdir = async (directoryPath, ...args) => {
      const key = directoryKey(directoryPath);
      if (key) counters[key].mkdirCalls += 1;
      return trackedOperation(key, () =>
        original.mkdir(directoryPath, ...args),
      );
    };
    const stringify = {
      calls: 0,
      cpuMicroseconds: 0,
      wallNanoseconds: 0,
    };
    const startedProcessCpu = process.cpuUsage();
    const startedProcessWall = process.hrtime.bigint();
    JSON.stringify = function (value, ...args) {
      const snapshot =
        value &&
        typeof value === 'object' &&
        value.version === 1 &&
        value.historicalMode === 'forward-only' &&
        Array.isArray(value.recentEntries) &&
        value.usage;
      if (!snapshot) return original.stringify.call(JSON, value, ...args);
      const wallStart = process.hrtime.bigint();
      const cpuStart = process.cpuUsage();
      try {
        return original.stringify.call(JSON, value, ...args);
      } finally {
        const cpu = process.cpuUsage(cpuStart);
        stringify.calls += 1;
        stringify.cpuMicroseconds += cpu.user + cpu.system;
        stringify.wallNanoseconds += Number(
          process.hrtime.bigint() - wallStart,
        );
      }
    };
    syncBuiltinESMExports();
    globalThis.__exactFileIoCounter = {
      counters,
      stringify,
      read() {
        const processCpu = process.cpuUsage(startedProcessCpu);
        return {
          paths: structuredClone(counters),
          snapshotStringify: { ...stringify },
          processCpuMicroseconds: {
            user: processCpu.user,
            system: processCpu.system,
            total: processCpu.user + processCpu.system,
          },
          processWallNanoseconds: Number(
            process.hrtime.bigint() - startedProcessWall,
          ),
          activeTrackedOperations,
          activeTrackedHandles,
        };
      },
      stop() {
        if (activeTrackedHandles !== 0 || activeTrackedOperations !== 0) {
          throw new Error(
            `Exact file I/O counter is active: ${activeTrackedHandles} handles, ${activeTrackedOperations} operations`,
          );
        }
        Object.assign(fsPromises, {
          readFile: original.readFile,
          open: original.open,
          writeFile: original.writeFile,
          appendFile: original.appendFile,
          rename: original.rename,
          stat: original.stat,
          mkdir: original.mkdir,
        });
        JSON.stringify = original.stringify;
        syncBuiltinESMExports();
        return this.read();
      },
    };
  }, trackedPaths);
}

export async function readExactFileIoCounter(electronApp) {
  return electronApp.evaluate(() => {
    const active = globalThis.__exactFileIoCounter;
    if (!active) throw new Error('Exact file I/O counter was not installed');
    return active.read();
  });
}

export async function stopExactFileIoCounter(electronApp) {
  return electronApp.evaluate(() => {
    const active = globalThis.__exactFileIoCounter;
    if (!active) throw new Error('Exact file I/O counter was not installed');
    const result = active.stop();
    delete globalThis.__exactFileIoCounter;
    return result;
  });
}
