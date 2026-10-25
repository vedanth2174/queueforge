
import "dotenv/config";
import { pool } from "./db/pool.js";
import { startWorker, stopWorker } from "./jobs/job.worker.js";

async function main() {
  await pool.query("SELECT 1");
  console.log("Database connection established.");

  const workerPromise = startWorker();
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${signal} received. Shutting down worker...`);

    stopWorker();

    try {
      await workerPromise;
      console.log("Worker stopped successfully.");
    } finally {
      await pool.end();
      console.log("Database connection pool closed.");
    }
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await workerPromise;
}

main().catch(async (error) => {
  console.error("Worker failed:", error);

  try {
    await pool.end();
  } finally {
    process.exitCode = 1;
  }
});
