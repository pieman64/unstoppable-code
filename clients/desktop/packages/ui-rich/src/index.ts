// `@canopy/ui-rich` is a Slate-backed rich editor used by both the desktop
// renderer and the hosted web portal. It owns no IO, no Zustand stores, no
// IPC, and no Electron/Next/Prisma imports — hosts provide every callback.
export * from './editor';
export * from './plugins';
export * from './types';
