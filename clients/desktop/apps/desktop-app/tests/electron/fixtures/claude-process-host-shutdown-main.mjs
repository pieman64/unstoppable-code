import { app } from 'electron';

// Keep a windowless Electron host alive for the production utility shutdown test.
app.on('window-all-closed', () => {});
