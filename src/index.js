const app = require("./app");
const { apiBaseUrl, port } = require("./config/env");
const { connectDatabase, disconnectDatabase } = require("./config/database");
const { once } = require("node:events");

async function startServer() {
  await connectDatabase();

  const server = app.listen(port);
  await once(server, "listening");

  console.log(
    [
      "Solar Generation API started",
      `  Listening on port ${port}`,
      `  API base:  ${apiBaseUrl}`,
      `  Health:    ${apiBaseUrl}/health`,
      `  OpenAPI:   ${apiBaseUrl}/openapi.json`,
      `  Docs:      ${apiBaseUrl}/docs`,
    ].join("\n"),
  );

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Stopping Solar Generation API...");
    server.close(async (error) => {
      try {
        await disconnectDatabase();
        if (error) process.exitCode = 1;
      } catch {
        console.error("Unable to close MongoDB connection.");
        process.exitCode = 1;
      }
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch(async (error) => {
  console.error(`Solar Generation API failed to start: ${error.message}`);
  process.exitCode = 1;
  try {
    await disconnectDatabase();
  } catch {
    console.error("Unable to close MongoDB connection.");
  }
});
