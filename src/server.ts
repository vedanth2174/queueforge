
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);

const server = app.listen(PORT, () => {
  console.log(`QueueForge running on http://localhost:${PORT}`);
});

async function shutdown() {
  console.log("Shutting down API server...");

  server.close(async () => {
    const { pool } = await import("./db/pool.js");
    await pool.end();
    process.exitCode = 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
