// apps/desktop-app/src/__tests__/viteWorkerUrlMock.ts
// Stand-in for Vite `?worker&url` imports: the bundler would emit the built
// worker asset URL relative to the renderer's base.
const workerUrl = './assets/office-parse.worker-mock.js';
export default workerUrl;
