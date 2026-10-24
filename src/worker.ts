
import "dotenv/config";
import { pool } from "./db/pool.js";
import { startWorker } from "./jobs/job.worker.js";

async function main() {
  await pool.query("SELECT 1");
  await startWorker();
}

main().catch(async (error) => {
  console.error("Worker failed to start:", error);
  await pool.end();
  process.exitCode = 1;
});
