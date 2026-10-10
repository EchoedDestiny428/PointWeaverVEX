import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectWatcher, scanProject } from "./project.js";
import type { ProjectSnapshot } from "./project.js";

type ThemeSource = "system" | "light" | "dark";

interface DesktopSettings {
  lastFolder?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const devServer = process.argv.includes("--dev") ? "http://localhost:5173" : null;
const BAR_HEIGHT = 48;

let win: BrowserWindow | null = null;
let currentRoot: string | null = null;

const settingsFile = (): string => path.join(app.getPath("userData"), "settings.json");

async function readSettings(): Promise<DesktopSettings> {
  try {
    return JSON.parse(await readFile(settingsFile(), "utf8")) as DesktopSettings;
  } catch {
    return {};
  }
}

async function writeSettings(settings: DesktopSettings): Promise<void> {
  try {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    return;
  }
}

function overlayColors(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#09090b", symbolColor: "#fafafa", height: BAR_HEIGHT }
    : { color: "#ffffff", symbolColor: "#09090b", height: BAR_HEIGHT };
}

const watcher = new ProjectWatcher((snapshot) => {
  if (snapshot.root === currentRoot) win?.webContents.send("project:changed", snapshot);
});

async function openRoot(root: string): Promise<ProjectSnapshot> {
  currentRoot = root;
  const snapshot = await scanProject(root);
  await watcher.start(root);
  await writeSettings({ ...(await readSettings()), lastFolder: root });
  return snapshot;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: "PointWeaver",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff",
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (!devServer || input.type !== "keyDown") return;
    if (input.key === "F12") {
      win?.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key.toLowerCase() === "r" && input.control) {
      win?.webContents.reload();
      event.preventDefault();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(path.join(here, "..", "dist", "index.html"));
}

ipcMain.handle("project:open", async () => {
  const options = { title: "Open a PROS project folder", properties: ["openDirectory" as const] };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return openRoot(picked.filePaths[0]);
});

ipcMain.handle("project:restore", async () => {
  const { lastFolder } = await readSettings();
  if (!lastFolder) return null;
  try {
    return await openRoot(lastFolder);
  } catch {
    return null;
  }
});

ipcMain.handle("project:reveal", async (_event, relative: unknown) => {
  if (!currentRoot || typeof relative !== "string") return false;
  const target = path.resolve(currentRoot, relative);
  if (!isInside(currentRoot, target)) return false;
  return (await shell.openPath(target)) === "";
});

ipcMain.handle("theme:set", (_event, source: unknown) => {
  if (source === "system" || source === "light" || source === "dark") {
    nativeTheme.themeSource = source as ThemeSource;
  }
});

nativeTheme.on("updated", () => {
  if (win && !win.isDestroyed()) {
    win.setTitleBarOverlay(overlayColors());
    win.setBackgroundColor(overlayColors().color);
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    watcher.stop();
    if (process.platform !== "darwin") app.quit();
  });
}
