import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Autons and paths live in Documents/PointWeaver, one JSON file each:
 *   paths/<name>.json    a path: points and LemLib settings
 *   autons/<name>.json   an auton: the paths it runs, in order
 *   settings.json        robot size and speed for the ghost
 */

type Kind = "path" | "auton";

const here = path.dirname(fileURLToPath(import.meta.url));
const devServer = process.argv.includes("--dev") ? "http://localhost:5173" : null;
const NAME_RE = /^[A-Za-z0-9_\- ]+$/;
const FOLDERS: Record<Kind, string> = { path: "paths", auton: "autons" };

let win: BrowserWindow | null = null;

const storeDir = (): string => path.join(app.getPath("documents"), "PointWeaver");
const folder = (kind: Kind): string => path.join(storeDir(), FOLDERS[kind]);
const settingsFile = (): string => path.join(storeDir(), "settings.json");

function fileFor(kind: unknown, name: unknown): string {
  if (kind !== "path" && kind !== "auton") throw new Error(`Unknown kind: ${String(kind)}`);
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`Invalid name: ${String(name)}`);
  return path.join(folder(kind), `${name}.json`);
}

const writeJson = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

function readAll(kind: Kind, skipped: string[]): Record<string, unknown> {
  const dir = folder(kind);
  const out: Record<string, unknown> = {};
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort()) {
    const name = file.slice(0, -5);
    if (!NAME_RE.test(name)) continue;
    try {
      out[name] = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (e) {
      skipped.push(`${FOLDERS[kind]}/${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Wrap a handler so it always resolves to its result or { error }. */
function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return (await fn(...args)) ?? { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
}

handle("store:load", () => {
  const skipped: string[] = [];
  const paths = readAll("path", skipped);
  const autons = readAll("auton", skipped);
  let settings: unknown = null;
  if (existsSync(settingsFile())) {
    try {
      settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
    } catch (e) {
      skipped.push(`settings.json: ${(e as Error).message}`);
    }
  }
  return { dir: storeDir(), paths, autons, settings, skipped };
});

handle("store:write", (kind, name, data) => writeJson(fileFor(kind, name), data));

handle("store:delete", (kind, name) => {
  const file = fileFor(kind, name);
  if (existsSync(file)) unlinkSync(file);
});

handle("store:rename", (kind, from, to) => {
  const src = fileFor(kind, from);
  const dst = fileFor(kind, to);
  if (existsSync(dst)) throw new Error("That name is already taken.");
  if (existsSync(src)) renameSync(src, dst);
});

handle("store:writeSettings", (data) => writeJson(settingsFile(), data));

handle("store:reveal", async () => {
  mkdirSync(storeDir(), { recursive: true });
  const err = await shell.openPath(storeDir());
  if (err) throw new Error(err);
});

handle("clipboard:write", (text) => {
  if (typeof text === "string") clipboard.writeText(text);
});

handle("theme:set", (source) => {
  if (source === "light" || source === "dark" || source === "system") nativeTheme.themeSource = source;
});

// Writes still waiting when the window closes: done synchronously so nothing is lost.
ipcMain.on("store:flushSync", (event, writes: unknown) => {
  try {
    if (Array.isArray(writes)) {
      for (const w of writes as Array<{ kind: unknown; name: unknown; data: unknown }>) {
        writeJson(fileFor(w.kind, w.name), w.data);
      }
    }
    event.returnValue = true;
  } catch {
    event.returnValue = false;
  }
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: "PointWeaver",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
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
    if (input.type !== "keyDown") return;
    if (input.key === "F12") {
      win?.webContents.toggleDevTools();
      event.preventDefault();
    } else if (devServer && input.key.toLowerCase() === "r" && input.control) {
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
    if (process.platform !== "darwin") app.quit();
  });
}
