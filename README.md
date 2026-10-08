# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

Node.js/Express, Mongoose and MongoDB Atlas API for Sri Lankan solar generation data.

## Current implementation

The API supports user/device authentication, jurisdiction-scoped geography and installation reads, reading ingestion/history, district summaries, admin installation management and database health checks. See [API endpoints](#api-endpoints) and [OpenAPI](docs/openapi.json) for implemented operations, [architecture](docs/architecture.md) for access/persistence, and [HTTP rules](docs/API_DESIGN_RULES.md) for limits and conditional requests. Public Swagger UI is available at `/docs`.

## Getting started

Requires Node.js 24 or later and MongoDB Atlas or a transaction-capable MongoDB replica set. Transactions are required for protected reads, reading ingestion, installation lifecycle writes and seeding; a standalone local MongoDB server is insufficient.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to your connection string, including the intended database name.
4. Set the JWT variables below; generate a private signing key locally, for example with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
5. Start the application: `npm run dev`.

For local development, configure MongoDB with `replication.replSetName: rs0` (or start `mongod` with `--replSet rs0`), then connect with `mongosh` and run `rs.initiate()` once. Wait for the member to become primary and set `MONGODB_URI=mongodb://127.0.0.1:27017/solar-generation?replicaSet=rs0`, adjusting the database name, port and replica-set name as needed. See MongoDB's [replica-set setup instructions](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/) for configuring an existing local instance.

| Setting | Purpose | Default |
| --- | --- | --- |
| `MONGODB_URI` | Database connection URI | Required; example file uses local MongoDB |
| `API_BASE_URL` | Shared API path prefix | `/api/v1.0` |
| `PORT` | Local HTTP listener port | `3000` |
| `JWT_SIGNING_KEY` | Private HS256 signing key; at least 32 bytes | Required |
| `JWT_ISSUER` | Token issuer (`iss`) | Required; example: `solar-generation-api` |
| `JWT_AUDIENCE` | Token audience (`aud`) | Required; example: `solar-generation-users` |
| `JWT_EXPIRES_IN_SECONDS` | Token lifetime, 60 to 3600 seconds | `900` |
| `DEVICE_HASH_COMMON_PREFIX` | Development installation password prefix; required for dataset seeding | Set locally; no default |

Existing process environment variables override `.env`. Keep credentials out of source control. Local development uses HTTP; production HTTPS is intended to terminate at the deployment proxy.

Startup connects to MongoDB before opening the HTTP listener. Watch for `MongoDB connected` and the endpoint URLs. Configuration or connection failures prevent startup; Ctrl+C closes the server and database connection.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with automatic restart on source changes |
| `npm start` | Start without watch mode |
| `npm test` | Run checks |
| `npm run seed` | Insert the full sample dataset into the configured database |
| `npm run seed:users` | Insert and verify the 36 configured accounts without changing existing users |

## API endpoints

Append these paths to `http://localhost:3000/api/v1.0` locally or `https://<your-host>/api/v1.0` in deployment; adjust the configured port/prefix. Protected GETs use user/admin bearer tokens; reading POST uses the bound device token; installation writes require a current database admin.

| Method | Path |
| --- | --- |
| GET | `/health`, `/openapi.json`, `/docs` (public; `/docs` serves HTML) |
| POST | `/auth/user-tokens`, `/auth/device-tokens` (credential exchange) |
| GET | `/provinces`, `/provinces/{provinceId}`, `/provinces/{provinceId}/districts` |
| GET | `/districts/{districtId}`, `/districts/{districtId}/grid-substations` |
| GET | `/grid-substations/{substationId}`, `/grid-substations/{substationId}/installations` |
| GET, POST | `/installations` |
| GET, PATCH, DELETE | `/installations/{installationId}` |
| GET | `/installations/{installationId}/overview`, `/installations/{installationId}/last-reading` |
| GET, POST | `/installations/{installationId}/readings` |
| GET | `/installations/{installationId}/readings/{readingId}`, `/readings` |
| GET | `/districts/{districtId}/generation-summary` |

See [HTTP rules](docs/API_DESIGN_RULES.md) for parameters, access failures, fields and caching, and OpenAPI for machine-readable schemas. GET `/health` checks MongoDB with a two-second ping timeout: 200 with `{"status":"ok","database":"up"}` when available, or a standard JSON 503 error when unavailable. Health responses use no-store without cache validators.

Open `http://localhost:3000/api/v1.0/docs` for Swagger UI, adjusting port/prefix as configured. Use Authorize for protected endpoints; documentation needs no token. The UI loads bundled assets and `/openapi.json` from the same origin. `API_BASE_URL` is a path, so local HTTP and deployed HTTPS use their own origins automatically. Page/assets/specification share the [documentation limit](docs/architecture.md#rate-limits), which requires MongoDB. [HTTP rules](docs/API_DESIGN_RULES.md#rate-limits) cover documentation media types, caching and configuration restrictions. OpenAPI inventories JSON operations; `/docs` serves HTML.

Focused offline checks: `node --test test/documentation.test.js test/health.test.js test/query-rejection.test.js`. They validate OpenAPI and route/query coverage, specification caching, UI initialization/assets, custom-prefix URLs, query rejection and shared-limit failures using mocked persistence.

Swagger groups endpoints as Authentication, Provinces, Districts, Grid Substations, Installations, Readings, Summaries and System. Collections/details/views precede writes; installation writes follow create, status update, delete. User login precedes device login.

## Sample data

Run `npm run seed` with `MONGODB_URI` and `DEVICE_HASH_COMMON_PREFIX` configured in ignored `.env`. The command builds indexes, inserts missing fixtures, prints collection totals including unrelated records, and disconnects; it never clears data or provisions users.

The dataset contains 9 provinces, 25 districts, 25 synthetic substations, 220 installations and 147,840 readings. [Architecture](docs/architecture.md#seed-dataset-and-persistence) owns profiles, dates and rerun guarantees. A new seeded device secret is the exact private prefix followed by its meter ID. Reruns preserve credentials; changing the prefix does not rotate hashes. Production devices need independent secrets.

## User accounts

1. Copy [seed-users.env.example](seed-users.env.example) to `seed-users.env`.
2. Replace all example emails and fill all 36 blank passwords locally. Quote passwords containing `#` or surrounding spaces.
3. Run `npm run seed` to create the geography, then `npm run seed:users`.

Database configuration comes from `.env`; account credentials come from the ignored `seed-users.env` file, which takes precedence over account values in `.env` for this command. Keep real credentials out of committed files; the example contains only placeholder emails and empty passwords.

Provide email/password pairs using these keys:

| Accounts | Environment keys |
| --- | --- |
| 1 admin | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` |
| 1 national analyst | `SEED_NATIONAL_EMAIL`, `SEED_NATIONAL_PASSWORD` |
| 9 provincial analysts | `SEED_PROVINCE_<NAME>_EMAIL`, `SEED_PROVINCE_<NAME>_PASSWORD` |
| 25 district analysts | `SEED_DISTRICT_<NAME>_EMAIL`, `SEED_DISTRICT_<NAME>_PASSWORD` |

Use uppercase names with underscores, such as `NORTH_WESTERN` and `NUWARA_ELIYA`. The supplied file uses `SEED_DISTRICT_MONARAGALA_*`, which maps to the stored district `Moneragala`.

All 36 credential pairs and existing geography references are required on every run. Missing/invalid credentials, duplicate normalized emails, and missing/ambiguous geography cause a clear failure. Accounts are inserted by normalized email; reruns retain existing UUIDs, password hashes, roles, and jurisdictions. Changing the credential file does not rotate passwords or reset access.

The command verifies all configured accounts before committing its transaction and prints aggregate inserted/preserved/verified counts and actual role/scope totals. Existing assignments that differ from the seed plan are reported by count and preserved. Passwords and hashes are never printed. Run the command again to verify a zero-insert rerun; see [architecture](docs/architecture.md#user-seeding) for the persistence contract.

## API usage

POST JSON `{"email":"<email>","password":"<password>"}` to `/auth/user-tokens`, or `{"meterId":"<meter>","deviceSecret":"<secret>"}` to `/auth/device-tokens`. Save `access_token` and send `Authorization: Bearer <access_token>`. Device login also returns the public `installationId`; submit readings under that UUID:

```json
{
  "recordedAt": "2026-10-08T12:00:00+05:30",
  "powerKw": 3.5,
  "energyKwh": 42,
  "voltageV": 230
}
```

Use a previously unused measurement timestamp. Retrieve the returned Location with a jurisdiction-authorized user/admin token. GET `/installations?status=active` or `?status=inactive` narrows installations within the authorized area; omission includes both. It combines with geography filters and pagination. Lists/history accept only their [documented queries](docs/API_DESIGN_RULES.md#resource-and-query-rules); the province list and small nested lists have no pagination. GET `/provinces` accepts no queries and returns only count/items within the current stored jurisdiction. Every endpoint without documented query options rejects supplied parameters with 400 INVALID_QUERY, including public endpoints, login and writes. Summary energy is observed and may be incomplete; check incompleteEnergyInstallationCount. Historical seed dates can produce stale current power.

## Manual verification

Use a test database and public UUIDs; keep provisioning secrets private. The [HTTP contract](docs/API_DESIGN_RULES.md) owns expected status codes, fields, validation and headers. Full `npm test` runs include concurrency checks that sequential requests cannot establish. Database integration tests use disposable local replica sets and require a MongoDB binary; set `MONGOD_BINARY` to its executable path if it is not at the default location. Those tests skip when the binary is unavailable; focused offline checks above use mocked persistence.

For reads, exercise national/admin and regional users, outside-jurisdiction requests, wrong/missing tokens, invalid IDs/queries and empty collections. Check scoped counts and pagination, then repeat with an ETag to verify bodyless 304 after renewed access. District users should see only their district in the parent province's district list. Full nested installation lists include both statuses without pagination. See [access](docs/API_DESIGN_RULES.md#authentication-and-access), [queries](docs/API_DESIGN_RULES.md#resource-and-query-rules) and [caching](docs/API_DESIGN_RULES.md#caching-and-access).

Example (PowerShell), using an existing user token and province UUID:

```powershell
$base = 'http://localhost:3000/api/v1.0'
$url = "$base/provinces/$provinceId"
$response = Invoke-WebRequest $url -Headers @{ Authorization = "Bearer $userToken" }
curl.exe -i $url -H "Authorization: Bearer $userToken" -H "If-None-Match: $($response.Headers.ETag)"
Invoke-RestMethod "$base/districts/$districtId/generation-summary" -Headers @{ Authorization = "Bearer $userToken" }
```

The summary takes no query parameters. Check its seven fields, zero totals for empty districts, incomplete-energy count, and validator changes as readings/status/time change. Automated clock checks cover freshness and midnight boundaries; historical seed dates can produce stale power.

### Create an installation

Use an existing substation UUID and admin token:

```powershell
$meterId = 'MANUAL-' + [guid]::NewGuid().ToString()
$deviceSecret = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
$inputJson = @{ substationId = $substationId; meterId = $meterId; deviceSecret = $deviceSecret } | ConvertTo-Json
$created = Invoke-WebRequest "$base/installations" -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $adminToken" } -Body $inputJson
$installation = $created.Content | ConvertFrom-Json
$detail = Invoke-WebRequest "$base/installations/$($installation.id)" -Headers @{ Authorization = "Bearer $adminToken" }
$detail.Headers.ETag -eq $created.Headers.ETag # True
$loginJson = @{ meterId = $meterId; deviceSecret = $deviceSecret } | ConvertTo-Json
$deviceLogin = Invoke-RestMethod "$base/auth/device-tokens" -Method Post -ContentType 'application/json' -Body $loginJson
$deviceLogin.installationId -eq $installation.id # True
```

Check creation, Location/detail ETag, device login, duplicate meters, denied actors, invalid fields and missing parents against the [creation contract](docs/API_DESIGN_RULES.md#installation-creation).

### Change installation status

Save the detail ETag and an unexpired device token while active. PATCH `{"status":"inactive"}` with that If-Match, then repeat the same status. Check retained history/meter reservation and blocked login/ingestion. PATCH active using the resulting ETag; original credentials and unexpired tokens should resume until their original expiry. Exercise stale/weak/malformed preconditions, no-op updates, wrong actors and invalid inputs using the [status](docs/API_DESIGN_RULES.md#installation-status-updates) and [precondition](docs/API_DESIGN_RULES.md#caching-and-access) contracts.

### Delete an empty installation

Create active/inactive empty fixtures, save detail ETags and device tokens, and DELETE with no body. Try absent/matching/list/wildcard preconditions, then repeat deletion/detail lookup. Use a fixture with a reading to check the history guard and stale-precondition ordering. Verify old-token rejection and a new UUID when the removed meter is registered again; parents/history must remain intact. Check invalid inputs and denied actors against the [deletion contract](docs/API_DESIGN_RULES.md#installation-deletion).

In a fresh admin rate window, make 31 valid-shaped PATCH or bodyless DELETE requests for a nonexistent UUID: the first 30 return 404, then 429 with Retry-After. Earlier POST/PATCH/DELETE attempts share the budget.

## Project layout

`src/features/` groups routes, validation, controllers and services by feature; shared configuration, middleware, services, utilities and models live in sibling directories. `src/routes/api.routes.js` composes the API and serves OpenAPI; `src/app.js` mounts it; `src/index.js` handles startup/shutdown. `scripts/` contains seed tooling; `test/` contains automated checks. [Architecture](docs/architecture.md#runtime-and-structure) defines ownership and separation rules.

## Documentation

| Document | Purpose |
| --- | --- |
| [Conceptual data model](docs/data-model-reference.md) | Domain entities and relationships |
| [Architecture](docs/architecture.md) | Stored schemas, resource access and persistence |
| [API design rules](docs/API_DESIGN_RULES.md) | Shared HTTP contract and endpoint exceptions |
| [OpenAPI](docs/openapi.json) | Implemented operations, schemas, parameters and responses; compact JSON with shared components |
| [Design decisions](docs/decisions.md) | Rationale and pending choices |
| [AGENTS.md](AGENTS.md) | Coding-agent instructions and invariants |
