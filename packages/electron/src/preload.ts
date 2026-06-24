import { contextBridge } from 'electron';

// Expose a minimal API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});
