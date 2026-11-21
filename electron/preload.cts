import { contextBridge, ipcRenderer } from "electron";

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("pointweaver", {
  load: call("store:load"),
  write: call("store:write"),
  remove: call("store:delete"),
  rename: call("store:rename"),
  writeSettings: call("store:writeSettings"),
  reveal: call("store:reveal"),
  copy: call("clipboard:write"),
  setTheme: call("theme:set"),
  /** Synchronous: for writes still pending while the window unloads. */
  flushSync: (writes: unknown) => ipcRenderer.sendSync("store:flushSync", writes) as boolean,
});
