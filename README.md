# WEB API COURSE WORK

Student Index: COBSCCOMP251P-004

Requires Node.js 24 or later. Install dependencies with `npm ci`, copy `.env.example`
to `.env`, and run `npm run dev` (or `npm start`). Existing process environment
variables override `.env`. `API_BASE_URL=/api/v1.0` is the shared API path prefix;
`PORT=3000` controls the local HTTP listener. Production HTTPS terminates at the
deployment proxy.

Set `MONGODB_URI` in `.env` to your MongoDB Atlas connection string, including
the intended database name. Startup connects through Mongoose before opening
the HTTP listener. The terminal prints `Connecting to MongoDB...`, then
`MongoDB connected` and the endpoint URLs on success. If configuration or
connection fails, the API does not start and exits with a failure status.
Stopping with Ctrl+C closes the HTTP server and database connection. Database
credentials and connection strings are not printed in connection errors.

For a manual connection check, run `npm run dev` and watch for `MongoDB connected`,
then request the health URL below. No collections or seed records are created
by the connection module. The actual Atlas connection has not been verified here.

`GET http://localhost:3000/api/v1.0/health` returns `200` with `{"status":"ok"}`.
This public liveness check does not query MongoDB. It returns a stable strong
ETag; a matching `If-None-Match` returns bodyless `304`. An Accept header that
excludes JSON returns bodyless `406`.

The implemented OpenAPI contract is served at `/api/v1.0/openapi.json`, with its
server path derived from configuration. Swagger UI and shared rate limits are
planned and are not implemented in this initial health feature.

Structure: `src/config` owns environment configuration, `src/routes` defines
relative resource paths, `src/controllers` handles HTTP responses, and
`src/middleware` handles common request behavior. `src/app.js` mounts the API
router using the imported `apiBaseUrl`; `src/index.js` starts the listener.
New features should add relative routes to the API router, controllers, and
services/models as business logic and persistence are introduced. Import shared
configuration for URLs instead of hardcoding the prefix in features.

Run `npm test` to verify the health and configuration contracts.

Mongoose models live in `src/models`, with shared UUID validation and public
JSON serialization in `shared.js`. References store parent `publicId` strings,
not MongoDB ObjectIds. Normal validated document writes check parent existence;
future services must coordinate concurrent ingestion/deletion with transactions
as described in the architecture. Reading model updates and deletions are
blocked, except insert-only upserts. Raw collection access bypasses Mongoose
guards and must not be used for API writes. Validate complete User documents
when changing roles/jurisdictions; partial query validators cannot enforce
cross-field jurisdiction rules.

Run `npm run seed` to connect using `MONGODB_URI`, create declared indexes, and
seed a small fixture in a transaction. On an empty database, totals are one
province, one district, one substation, two installations, six readings (three
per installation), and zero users. It prints collection totals and disconnects
on completion or failure. Existing unrelated records are included in totals.
The full coursework dataset is deferred.

The fixture generates random UUID v4 IDs for missing records and uses fixed
measurement timestamps at 08:30, 08:40, and 08:50 Sri Lankan time on 2026-10-07.
Reruns reuse geography by name within its parent and installations by meter ID.
Public reading JSON uses `+05:30`; MongoDB stores the same instants as UTC dates,
so Compass may display `Z` (for example, 03:00 UTC is 08:30 Sri Lankan time).
Reruns insert only missing records: existing installation status, credentials,
geography, reading values, and reading IDs are preserved. No users or admin
accounts are provisioned. Optional local `SEED_DEVICE_SECRET_1` and
`SEED_DEVICE_SECRET_2` environment values are salted and scrypt-hashed only when
creating the installations. Without them, random disposable secrets are used
and never printed or retained. Changing these values does not rotate existing
credentials. The seed is setup data and may restore missing historical fixture
readings for an inactive installation; it is not a device ingestion endpoint.
