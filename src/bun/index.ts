import Electrobun, { ApplicationMenu, BrowserWindow, Updater } from "electrobun/bun";
import { startApiServer } from "./api";
import { ManagerStore } from "./store";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const API_PORT = 8765;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR.");
    }
  }
  return "views://mainview/index.html";
}

const store = new ManagerStore(process.cwd());
const apiServer = startApiServer(store, API_PORT);
console.log(`Codex Agents Composer API listening on ${apiServer.url}`);

const url = await getMainViewUrl();

// setApplicationMenu must be called immediately before BrowserWindow with no
// await in between — an Electrobun bug (GH #136/#160/#191) causes the native
// dispatch_async to read a GC'd buffer if an async gap exists between the two calls.
ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      { label: "Toggle DevTools", action: "toggle-devtools", accelerator: "i" },
    ],
  },
  {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
  },
]);

const win = new BrowserWindow({
  title: "Codex Agents Composer",
  url,
  frame: {
    width: 1320,
    height: 860,
    x: 120,
    y: 80,
  },
});

Electrobun.events.on("application-menu-clicked", (e: { data: { action: string } }) => {
  if (e.data.action === "toggle-devtools") {
    win.webview.toggleDevTools();
  }
});
