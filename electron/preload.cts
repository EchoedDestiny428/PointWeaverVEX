import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("pointweaver", {
  openFolder: () => ipcRenderer.invoke("project:open"),
  restore: () => ipcRenderer.invoke("project:restore"),
  reveal: (relative: string) => ipcRenderer.invoke("project:reveal", relative),
  setTheme: (source: string) => ipcRenderer.invoke("theme:set", source),
  openLog: () => ipcRenderer.invoke("log:open"),
  readLog: (file: string) => ipcRenderer.invoke("log:read", file),
  exportReport: (log: string, report: string, csv: string) => ipcRenderer.invoke("log:export", log, report, csv),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onChange: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on("project:changed", listener);
    return () => {
      ipcRenderer.off("project:changed", listener);
    };
  },
});
