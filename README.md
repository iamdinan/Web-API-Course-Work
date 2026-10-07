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

Run `npm test` to verify health/configuration, models, full seed profiles, batch
idempotence, and status/credential preservation.

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
seed 9 provinces, 25 districts, 25 synthetic substations, 220 installations,
and 147,840 readings. Each installation has seven complete days of 15-minute
samples: 2026-09-30 00:00 through 2026-10-06 23:45 Sri Lankan time.
Power follows a daytime solar curve and is zero overnight; cumulative kWh is
integrated from consecutive power samples. Hierarchy writes use per-district
transactions; readings use one batch of 672 insert-only upserts per installation.
It prints collection totals and disconnects on completion or failure.

New records get random UUID v4 IDs. Reruns reuse geography by name within its
parent and installations by meter ID; existing IDs, references, installation
status, credentials and reading values are preserved. Unrelated records are
retained and included in reported totals. No database clear is performed.
Public reading JSON uses `+05:30`; MongoDB stores the same instants as UTC dates,
so Compass may display `Z` (for example, 03:00 UTC is 08:30 Sri Lankan time).
No users or admin accounts are provisioned. Optional local `SEED_DEVICE_SECRET_1`
through `SEED_DEVICE_SECRET_220` values are salted and scrypt-hashed only when
creating the corresponding new installations. Without them, random disposable secrets are used
and never printed or retained. Changing these values does not rotate existing
credentials. The seed is setup data and may restore missing historical fixture
readings for an inactive installation; it is not a device ingestion endpoint.

Substation names are district-based, such as `Colombo Grid Substation`; meter IDs
use `METER-01-01`. The seed consists of two files: `scripts/seed.js` handles
persistence, and `scripts/seed-data.js` defines geography and reading profiles.

The original demo was already preserved separately in `seed_fixture_archive`,
and the naming correction was completed. Those one-time migration tools and the
obsolete small fixture have been removed. The archive is untouched by the seed.
The last completed Atlas verification is retained in
[docs/seed-verification.json](docs/seed-verification.json): exact full counts,
zero new readings on rerun, and unchanged document hashes. This is historical
verification evidence, not a check that automatically runs with the seed.
