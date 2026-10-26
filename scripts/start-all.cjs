const { spawn } = require("node:child_process");
const path = require("node:path");

const children = new Map();
let stopping = false;
let exitCode = 0;
let shutdownTimer;

function finish() {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  process.exit(exitCode);
}

function stopAll(code = 0) {
  if (stopping) {
    if (code !== 0) exitCode = code;
    return;
  }

  stopping = true;
  exitCode = code;

  console.log("[QueueForge] Shutting down API and worker...");

  for (const child of children.values()) {
    if (
      child.pid &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGTERM");
    }
  }

  shutdownTimer = setTimeout(() => {
    console.error("[QueueForge] Shutdown timed out; forcing exit.");

    for (const child of children.values()) {
      if (
        child.pid &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill("SIGKILL");
      }
    }

    process.exit(exitCode || 1);
  }, 25000);

  if (children.size === 0) finish();
}

function launch(name, filename) {
  const file = path.resolve(__dirname, "..", "dist", filename);

  const child = spawn(process.execPath, [file], {
    stdio: "inherit",
    env: process.env,
  });

  children.set(name, child);

  child.on("error", (error) => {
    console.error(`[QueueForge] Could not start ${name}:`, error);
    stopAll(1);
  });

  child.on("close", (code, signal) => {
    children.delete(name);

    if (!stopping) {
      console.error(
        `[QueueForge] ${name} exited unexpectedly: code=${code}, signal=${signal}`
      );
      stopAll(code === 0 ? 1 : (code ?? 1));
      return;
    }

    if (children.size === 0) finish();
  });
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));

console.log("[QueueForge] Starting API and worker...");

launch("API", "server.js");
launch("Worker", "worker.js");