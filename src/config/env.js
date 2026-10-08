const path = require('node:path');

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const apiBaseUrl = process.env.API_BASE_URL ?? '/api/v1.0';
const port = Number(process.env.PORT ?? 3000);
const mongodbUri = process.env.MONGODB_URI;

if (!/^\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(apiBaseUrl)) {
  throw new Error('API_BASE_URL must be an absolute URL path without a trailing slash.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

module.exports = Object.freeze({ apiBaseUrl, port, mongodbUri });
