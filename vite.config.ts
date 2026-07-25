import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;

const ELECTRON_RESTART_DEBOUNCE_MS = 260;
const ELECTRON_STOP_TIMEOUT_MS = 5_000;
const electronDevUserDataDir = path.join(
  process.env.TEMP || process.env.TMP || __dirname,
  "cursor-studio-vite",
  String(process.pid),
);

interface ElectronDevState {
  child?: ChildProcess;
  restartQueue: Promise<void>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restartWaiters: Array<() => void>;
  exitHooked: boolean;
}

type ProcessWithElectronDevState = NodeJS.Process & {
  __cursorStudioElectronDevState__?: ElectronDevState;
};

// Vite re-evaluates this config when it changes. Keep the child reference on
// the long-lived Vite process so a config reload can still stop the app.
const viteProcess = process as ProcessWithElectronDevState;
const electronState = (viteProcess.__cursorStudioElectronDevState__ ??= {
  restartQueue: Promise.resolve(),
  restartWaiters: [],
  exitHooked: false,
});

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopElectron(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(stopped);
    };

    const onExit = () => finish(true);
    const onError = () => finish(true);
    child.once("exit", onExit);
    child.once("error", onError);
    timeout = setTimeout(() => finish(hasExited(child)), ELECTRON_STOP_TIMEOUT_MS);

    try {
      if (!child.kill()) finish(true);
    } catch (error) {
      console.warn("[studio] Electron development process already exited:", error);
      finish(hasExited(child));
    }
  });
}

function launchElectron() {
  const child = spawn(
    electronBinary,
    [".", "--no-sandbox", `--user-data-dir=${electronDevUserDataDir}`],
    {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    },
  );
  electronState.child = child;

  child.once("exit", () => {
    if (electronState.child === child) electronState.child = undefined;
  });
  child.once("error", (error) => {
    if (electronState.child === child) electronState.child = undefined;
    console.error("[studio] Electron development process failed:", error);
  });
}

async function restartElectronNow(): Promise<void> {
  const current = electronState.child;
  if (current) {
    const stopped = await stopElectron(current);
    if (!stopped) {
      console.warn("[studio] Electron is still shutting down; skipped duplicate restart.");
      return;
    }
    if (electronState.child === current) electronState.child = undefined;
  }

  launchElectron();
}

function restartElectron(): Promise<void> {
  return new Promise((resolve) => {
    electronState.restartWaiters.push(resolve);
    if (electronState.restartTimer) clearTimeout(electronState.restartTimer);

    electronState.restartTimer = setTimeout(() => {
      electronState.restartTimer = undefined;
      const waiters = electronState.restartWaiters.splice(0);
      electronState.restartQueue = electronState.restartQueue
        .catch(() => undefined)
        .then(restartElectronNow);

      void electronState.restartQueue
        .catch((error) => {
          console.error("[studio] Electron development restart failed:", error);
        })
        .finally(() => {
          for (const done of waiters) done();
        });
    }, ELECTRON_RESTART_DEBOUNCE_MS);
  });
}

if (!electronState.exitHooked) {
  electronState.exitHooked = true;
  process.once("exit", () => {
    const child = electronState.child;
    if (!child || hasExited(child)) return;
    try {
      child.kill();
    } catch {
      // The child can exit between the state check and kill on Windows.
    }
  });
}

export default defineConfig({
  // loadFile 生产包需要相对路径
  base: "./",
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart: () => restartElectron(),
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              // node:sqlite 为 Electron/Node 内置实验 API，不可打进 asar bundle
              external: ["electron", "node:sqlite", "sqlite"],
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        onstart: () => restartElectron(),
        vite: {
          build: {
            outDir: "dist-electron",
            // Electron preload 必须 CJS，否则白屏
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "cjs",
                entryFileNames: "preload.cjs",
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  clearScreen: false,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "framer-motion"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
});
