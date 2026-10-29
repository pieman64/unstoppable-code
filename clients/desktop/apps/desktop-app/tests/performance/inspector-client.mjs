import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

export async function reserveInspectorPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error('Could not reserve a main-process inspector port');
  return port;
}

async function waitForInspectorTarget(port) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Electron main-process inspector did not become available on port ${port}${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function connectInspector(port) {
  const target = await waitForInspectorTarget(port);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out opening inspector WebSocket')),
      CONNECT_TIMEOUT_MS,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('Main-process inspector WebSocket failed to open'));
      },
      { once: true },
    );
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(
        new Error(
          `Inspector ${request.method} failed: ${message.error.message}`,
        ),
      );
    } else {
      request.resolve(message.result ?? {});
    }
  });

  return {
    target: {
      id: target.id,
      title: target.title,
      type: target.type,
      url: target.url,
    },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Inspector ${method} timed out`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { method, resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error('Inspector connection closed'));
      }
      pending.clear();
      socket.close();
    },
  };
}
