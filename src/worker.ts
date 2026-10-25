
import "dotenv/config";
import { pool } from "./db/pool.js";
import { startWorker, stopWorker } from "./jobs/job.worker.js";

async function main() {
  await pool.query("SELECT 1");
  console.log("Database connection established.");

  const workerPromise = startWorker();
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${signal} received. Shutting down worker...`);
    stopWorker();

    const shutdownTimeout = setTimeout(() => {
      console.error("Graceful shutdown timed out. Forcing process exit.");
      process.exit(1);
    }, 30_000);

    shutdownTimeout.unref();

    try {
      await workerPromise;
      console.log("Worker stopped successfully.");
    } catch (error) {
      console.error("Worker stopped with an error:", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(shutdownTimeout);

      try {
        await pool.end();
        console.log("Database connection pool closed.");
      } catch (error) {
        console.error("Failed to close database pool:", error);
        process.exitCode = 1;
      }
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

main().catch(async (error: unknown) => {
  console.error("Worker failed:", error);

  try {
    await pool.end();
  } catch (closeError) {
    console.error("Failed to close database pool:", closeError);
  }

  process.exitCode = 1;
});
