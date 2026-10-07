const app = require("./app");
const { apiBaseUrl, port } = require("./config/env");

const server = app.listen(port, () => {
  const apiUrl = `http://localhost:${port}${apiBaseUrl}`;

  console.log(
    [
      "Solar Generation API started",
      `  API base:  ${apiUrl}`,
      `  Health:    ${apiUrl}/health`,
      `  OpenAPI:   ${apiUrl}/openapi.json`,
    ].join("\n"),
  );
});

server.on("error", (error) => {
  console.error(`Solar Generation API failed to start: ${error.message}`);
  process.exitCode = 1;
});
