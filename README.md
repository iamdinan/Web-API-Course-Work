# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

A Node.js/Express API backed by Mongoose and MongoDB Atlas for solar generation data in Sri Lanka.

## Current implementation

The application currently provides public `/health` and `/openapi.json`, user/admin login at `POST /auth/user-tokens`, device login at `POST /auth/device-tokens`, protected `GET /provinces`, `GET /readings`, `GET /installations/{installationId}/readings`, `GET /installations/{installationId}/readings/{readingId}`, `GET /installations/{installationId}/last-reading`, `GET /installations/{installationId}/overview`, `GET /installations/{installationId}`, `GET /installations`, `GET /grid-substations/{substationId}`, `GET /districts/{districtId}/grid-substations`, `GET /districts/{districtId}`, `GET /provinces/{provinceId}/districts`, `GET /provinces/{provinceId}`, `GET /summarize-district-generation`, and `GET /grid-substations/{substationId}/installations`, six data models, the full dataset seed, and controlled user seeding. Login and protected reads use shared MongoDB limits. Installation JWT verification and URL ownership protect `POST /installations/{installationId}/readings`, with transactional active-status checks and shared device-write limits. Admin creation at `POST /installations` and status updates at `PATCH /installations/{installationId}` use current-role authorization and shared admin-write limits; PATCH supports atomic optional If-Match. Remaining resource endpoints, Swagger UI, database readiness, and other traffic limits remain planned. The architecture describes the target API; OpenAPI describes implemented routes only.

## Getting started

Requires Node.js 24 or later and access to MongoDB.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to your connection string, including the intended database name.
4. Set the JWT variables below; generate a private signing key locally, for example with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
5. Start the application: `npm run dev`.

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

## Substation installation list manual checks

Use a user/admin token and a real public substation UUID. This endpoint returns all installations in count/items, with no pagination or query parameters. The [nested installation contract](docs/API_DESIGN_RULES.md#substation-installation-list) defines jurisdiction, fields and conditional behavior.

```powershell
$listUrl = "$base/api/v1.0/grid-substations/$substationId/installations"
$response = Invoke-WebRequest $listUrl -Headers @{ Authorization = "Bearer $userToken" }
$response.Content # count/items; public fields only
curl.exe -i $listUrl -H "Authorization: Bearer $userToken" -H 'If-None-Match: *' # bodyless 304
```

Verify count matches the full items array, with active/inactive records and no next/previous fields. National/admin and authorized provincial/district tokens return 200; outside jurisdiction returns 403, installation tokens 401, malformed substation UUID 400 and unused valid UUID 404. All query parameters, including offset/limit, geography and sort/status, return 400. Empty authorized substations return count=0 and empty items. Matching a saved ETag returns 304 until the authorized collection changes. If-Modified-Since alone returns 200.

## District summary manual checks

Send a user/admin token and a real public district UUID. See the [summary HTTP contract](docs/API_DESIGN_RULES.md#district-generation-summary). todayEnergyKwh is observed daily energy that may be incomplete; inspect incompleteEnergyInstallationCount. Inactive history contributes energy, while only active fresh readings contribute current power.

```powershell
$summaryUrl = "$base/api/v1.0/summarize-district-generation?districtId=$districtId"
$response = Invoke-WebRequest $summaryUrl -Headers @{ Authorization = "Bearer $userToken" }
$response.Content
curl.exe -i $summaryUrl -H "Authorization: Bearer $userToken" -H 'If-None-Match: *'
```

The first request returns 200 with the seven public summary fields. The wildcard conditional request returns bodyless 304 after authorization; a saved specific ETag returns 200 when the displayed asOf minute or any calculated value changes. asOf uses readable Sri Lanka text, such as `08 Oct 2026, 12:00 PM (Sri Lanka)`, while calculations retain full precision. National/admin and authorized provincial/district tokens return 200; outside jurisdiction returns 403, an installation token 401, missing/invalid districtId 400, an unused valid district UUID 404, and unsupported or repeated query parameters 400. An empty district returns zero totals/counts. If-Modified-Since alone returns 200. Tests use controlled clocks to verify exact freshness and midnight boundaries; the fixed seed's historical dates may produce stale power on current dates.

## API endpoints

Append the paths below to your API base URL. Use your deployed HTTPS host with the configured prefix, for example `https://<your-host>/api/v1.0`. If the app runs locally, use `http://localhost:3000/api/v1.0` (adjust the port or prefix if configured).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Application liveness |
| GET | `/openapi.json` | Implemented OpenAPI specification |
| POST | `/auth/user-tokens` | Obtain a user/admin access token |
| POST | `/auth/device-tokens` | Obtain an installation access token |
| GET | `/provinces` | List provinces visible to the authenticated user |
| GET | `/summarize-district-generation?districtId=...` | Current fresh power and observed daily energy within an authorized district |
| GET | `/provinces/{provinceId}` | Retrieve public province details within the user's jurisdiction |
| GET | `/provinces/{provinceId}/districts` | List authorized districts within a province |
| GET | `/districts/{districtId}` | Retrieve public district details within the user's jurisdiction |
| GET | `/grid-substations/{substationId}/installations` | List all active and inactive installations within an authorized substation |
| GET | `/grid-substations/{substationId}` | Retrieve public substation details within the user's jurisdiction |
| GET | `/districts/{districtId}/grid-substations` | List all substations belonging to an authorized district |
| POST | `/installations/{installationId}/readings` | Submit a reading for the authenticated active installation |
| GET | `/installations/{installationId}/readings` | Page/filter reading history within the authenticated user's jurisdiction |
| GET | `/readings` | Page/filter regional reading history within the authenticated user's jurisdiction |
| GET | `/installations/{installationId}/readings/{readingId}` | Retrieve a reading within the authenticated user's jurisdiction |
| GET | `/installations/{installationId}/last-reading` | Retrieve the latest measurement within the authenticated user's jurisdiction |
| GET | `/installations/{installationId}/overview` | Retrieve installation details, geography and latest reading within the user's jurisdiction |
| GET | `/installations/{installationId}` | Retrieve public installation metadata within the user's jurisdiction |
| GET | `/installations` | Page/filter public installations within the user's jurisdiction |
| POST | `/installations` | Create an active installation as a current database admin |
| PATCH | `/installations/{installationId}` | Activate or deactivate an installation with optional atomic If-Match |

Health does not query MongoDB. For a manual startup check, confirm the connection message and request the health path.

## Sample data

The seed creates 9 provinces, 25 districts, 25 synthetic substations, 220 installations, and 147,840 readings. Reruns insert missing data while preserving existing records. This dataset command does not provision users or admin accounts; use the separate user seed below.

Run `npm run seed` after configuring `MONGODB_URI`. The database must support transactions, as Atlas does. The command builds declared indexes, inserts missing data, prints collection totals (including unrelated records), and disconnects. It never clears the database.

For development, set `DEVICE_HASH_COMMON_PREFIX` in the ignored `.env`. A new seeded installation's password is the exact prefix followed by its stored meter ID; the seed stores only a fresh salted scrypt hash. Reruns preserve existing credentials, so changing the prefix does not rotate stored hashes. Production devices must use independent credentials.

See the [architecture seed section](docs/architecture.md#seed-dataset-and-persistence) for profiles, dates, persistence, and rerun guarantees.

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

## User login

POST JSON containing only `email` and `password` to `/auth/user-tokens`. The response includes the authenticated public `userId`. Save the returned `access_token` and send it as `Authorization: Bearer <access_token>` on user requests. See the [user-token contract](docs/API_DESIGN_RULES.md#user-token-exchange) and [OpenAPI](docs/openapi.json) for responses and limits.

## Device login

POST JSON containing only `meterId` and `deviceSecret` to `/auth/device-tokens`. Submit the original secret; for the development seed it is the configured prefix followed by the meter ID. Save the returned installation `access_token` and public `installationId` for reading submissions. See the [device-token contract](docs/API_DESIGN_RULES.md#device-token-exchange) for responses and limits.

## Protected province list

Send the user/admin bearer token to GET `/provinces`. Results follow the user's stored national, provincial, or district jurisdiction. See the [province-list contract](docs/API_DESIGN_RULES.md#protected-province-list) for filters, pagination, validators, and limits.

## List a province's districts

Send a user/admin bearer token to GET `/provinces/{provinceId}` for only id/name. National/admin readers can request any province, provincial readers their assigned province, and district readers their current district's parent province. No query options or related collections. See the [province-detail contract](docs/API_DESIGN_RULES.md#province-details).

Manual check (PowerShell; use your HTTPS base URL, real public province UUID and user token):

```powershell
$provinceUrl = "$base/api/v1.0/provinces/$provinceId"
$response = Invoke-WebRequest $provinceUrl -Headers @{ Authorization = "Bearer $userToken" }
$response.Content # 200: only id and name
curl.exe -i $provinceUrl -H "Authorization: Bearer $userToken" -H "If-None-Match: $($response.Headers.ETag)" # 304, no body
```

Repeat with national/admin, own-province provincial and own-parent-province district tokens for 200; an outside province for a scoped analyst gives 403. An installation token gives 401, `not-a-uuid` gives 400, an unused valid UUID gives 404, and `?limit=1` gives 400. If-Modified-Since alone gives 200. Errors carry no-store and no validators.

Send a user/admin bearer token to GET `/provinces/{provinceId}/districts`. National/admin and provincial readers receive the authorized province's districts; district analysts receive only their assigned district in their own province. Returns the full count/items collection without query options or pagination. See the [province-district contract](docs/API_DESIGN_RULES.md#province-districts).

## Read a district

Send a user/admin bearer token to GET `/districts/{districtId}`, using the public district UUID. Returns id, provinceId and name within the user's stored jurisdiction, without related collections or query options. See the [district-detail contract](docs/API_DESIGN_RULES.md#district-details).

## Read a grid substation

Send a user/admin bearer token to GET `/grid-substations/{substationId}`, using the public substation UUID. The response includes id, districtId and name within the user's stored jurisdiction. See the [substation-detail contract](docs/API_DESIGN_RULES.md#grid-substation-details) for access, validators and errors.

## List a district's grid substations

Send a user/admin bearer token to GET `/districts/{districtId}/grid-substations`, using the public district UUID. The district must be within the user's stored jurisdiction. Returns the full district collection without pagination or query parameters. See the [district-substation collection contract](docs/API_DESIGN_RULES.md#district-grid-substations).

## Submit a device reading

Send the installation bearer token to POST `/installations/{installationId}/readings`, using the public installation ID returned by device login and a JSON body:

```json
{"recordedAt":"2026-10-08T12:00:00+05:30","powerKw":3.5,"energyKwh":42,"voltageV":230}
```

Use a timestamp not already stored for that installation. Use the returned Location with a user/admin bearer token to retrieve the created reading. See the [reading-submission contract](docs/API_DESIGN_RULES.md#device-reading-submission) for validation, responses, headers, and limits, and the [architecture](docs/architecture.md#reading-ingestion) for persistence coordination.

## Read an individual reading

Send the user/admin bearer token to GET `/installations/{installationId}/readings/{readingId}`, using both public UUIDs or the Location returned by submission. Historical readings remain available for inactive installations within the user's jurisdiction. Out-of-jurisdiction requests return 403; missing readings and reading/installation mismatches return 404. See the [individual-reading contract](docs/API_DESIGN_RULES.md#individual-reading) for responses and conditional requests.

## Read the latest measurement

Send a user/admin bearer token to GET `/installations/{installationId}/last-reading`. The response is the reading with the greatest recordedAt, including retained inactive history. See the [latest-reading contract](docs/API_DESIGN_RULES.md#latest-reading) for access, empty results and conditional caching.

## List installations

Send a user/admin bearer token to GET `/installations`. Optional provinceId, districtId and substationId filters narrow the authorized area; offset and limit select a page. Both active and inactive installations are included. See the [installation-list contract](docs/API_DESIGN_RULES.md#installation-list) for parameters, collection responses and caching. Installation creation and active/inactive status updates are implemented; DELETE remains planned.

## Create an installation

Send a user JWT whose current database role is admin to POST `/installations`. See the [creation contract](docs/API_DESIGN_RULES.md#installation-creation) for validation, errors and the shared admin-write limit. Supply an independent device secret; the seed prefix is not used. Meter IDs are trimmed; secret characters are preserved. Creation returns public fields, Location and the same strong ETag as detail GET. DELETE remains planned.

Manual PowerShell example (use a test database, a real substation UUID and admin token; retain the generated secret privately for device provisioning):

```powershell
$base = 'http://localhost:3000/api/v1.0' # use your deployed HTTPS base in production
$meterId = 'MANUAL-' + [guid]::NewGuid().ToString()
$deviceSecret = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
$inputJson = @{ substationId = $substationId; meterId = $meterId; deviceSecret = $deviceSecret } | ConvertTo-Json
$created = Invoke-WebRequest "$base/installations" -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $adminToken" } -Body $inputJson
$installation = $created.Content | ConvertFrom-Json
$created.Headers.Location
$created.Headers.ETag
$detail = Invoke-WebRequest "$base/installations/$($installation.id)" -Headers @{ Authorization = "Bearer $adminToken" }
$detail.Headers.ETag -eq $created.Headers.ETag # True
$loginJson = @{ meterId = $meterId; deviceSecret = $deviceSecret } | ConvertTo-Json
$deviceLogin = Invoke-RestMethod "$base/auth/device-tokens" -Method Post -ContentType 'application/json' -Body $loginJson
$deviceLogin.installationId -eq $installation.id # True
```

Repeat creation with the same meter for 409; use an analyst token for 403 or the device access_token for 401. Invalid UUID, whitespace-only strings and added id/status/deviceCredentialHash fields give 400; an unused valid substation UUID gives 404. Success is 201 with only id/substationId/meterId/status, no-store, Location and strong ETag; errors have no validators. These examples create persistent installations; automated checks instead use disposable local fixtures.

## Change installation status

PATCH `/installations/{installationId}` with an admin user token and exactly `{"status":"inactive"}` or `{"status":"active"}`. It preserves identity, credentials, meter/substation binding and history. Repeated requests return the same public body/ETag. Creation and PATCH share the 30/minute per-admin write limit. See the [status-update HTTP contract](docs/API_DESIGN_RULES.md#installation-status-updates) and [transaction strategy](docs/architecture.md#admin-installation-management). DELETE remains unimplemented.

Manual Postman checks (use a test installation):

1. Set environment baseUrl to http://localhost:3000/api/v1.0 (or your deployed HTTPS API base), adminToken to a current admin user JWT, installationId to the test installation UUID, and deviceToken to a device token issued while it is active. Retain its meterId/deviceSecret privately for login checks.
2. GET `{{baseUrl}}/installations/{{installationId}}` with Bearer `{{adminToken}}`. Save its ETag including quotes as activeETag. Optionally capture GET history/list/overview/summary responses before the write.
3. PATCH the same URL with Bearer `{{adminToken}}`, Body > raw > JSON `{"status":"inactive"}`, and header If-Match `{{activeETag}}`. Expect 200 with only id/substationId/meterId/status=inactive, no-store and a new strong ETag. Save it as inactiveETag. Subsequent detail GET has the same body/tag; historical readings remain available.
4. Repeat with If-Match `{{inactiveETag}}`, with `*`, and without the header: all return 200 with unchanged body/tag. Send `"unrelated", {{inactiveETag}}` to test a matching tag list.
5. Repeat with the old `{{activeETag}}` or `W/{{inactiveETag}}`: expect 412 PRECONDITION_FAILED with no change. Unquoted text or a trailing-comma tag list gives 400 INVALID_REQUEST. A missing valid installation UUID returns 404 even with malformed/stale If-Match.
6. Set body to `{}`, `{"status":"retired"}`, or add meterId/deviceSecret/id: expect 400. Invalid path UUID gives 400. No/invalid/device token gives 401; an analyst user token gives 403. Errors have the standard code/message/details shape, no-store and no validators.
7. POST auth/device-tokens using the original correct meterId/deviceSecret: expect 403 INSTALLATION_INACTIVE. POST a new reading with the saved deviceToken: expect 403 INSTALLATION_INACTIVE. Verify authorized history GET still returns the previous readings. The meter remains reserved: creation with it gives 409.
8. Reactivate with body `{"status":"active"}` and If-Match `{{inactiveETag}}`. Expect 200, active status and the original active ETag when other public fields are unchanged. Repeat with the returned ETag or without If-Match: unchanged 200. The old inactive ETag now gives 412. Correct-secret device login works again; the saved device token works only if it has not expired. Expired tokens remain 401, and reactivation never extends their expiry. Existing admin tokens continue to work because the current stored role is authoritative.
9. In a fresh admin rate window, use Collection Runner for 31 valid-shaped PATCH requests targeting a nonexistent valid UUID. The first 30 return 404, the 31st returns 429 with Retry-After; earlier creation/PATCH attempts share this budget.

## Read installation details

Send a user/admin bearer token to GET `/installations/{installationId}`. It returns public installation metadata for active or inactive installations within jurisdiction, with a strong installation ETag for conditional GET. See the [installation-detail contract](docs/API_DESIGN_RULES.md#installation-details). Installation creation and active/inactive status updates are implemented; DELETE remains planned.

## Read an installation overview

Send a user/admin bearer token to GET `/installations/{installationId}/overview`. It returns installation details, related geography and the latest measurement, or null when no readings exist. Inactive installations remain available within jurisdiction. See the [overview contract](docs/API_DESIGN_RULES.md#installation-overview) and [architecture response structure](docs/architecture.md#installation-overview).

## Read installation history

Send a user/admin bearer token to GET `/installations/{installationId}/readings`. Optional offset, limit, from/to and sort parameters select the page and time window; results default to newest first. See the [history contract](docs/API_DESIGN_RULES.md#installation-reading-history) for validation, pagination and caching.

For regional history, send a user/admin bearer token to GET `/readings`. Optional provinceId, districtId and substationId filters narrow the authorized area; paging, time filters and sorting follow the [regional history contract](docs/API_DESIGN_RULES.md#regional-reading-history).

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/config/` | Environment configuration and database connection |
| `src/features/auth/` | User/device token routes, controllers, credential validation, and issuance services |
| `src/features/installations/` | Admin installation creation/status-update routes, validation, controllers and persistence services |
| `src/features/readings/` | Reading routes, controllers, validation, public serialization, scoped queries, and transactional ingestion |
| `src/features/provinces/` | Province routes, controllers, query validation, and scoped queries |
| `src/features/districts/` | District detail/province collection routes, validation, controllers and authorized ancestry queries |
| `src/features/grid-substations/` | Substation detail/district collection routes, validation, controllers and authorized ancestry queries |
| `src/features/health/` | Public liveness route and static response |
| `src/routes/api.routes.js` | Central API router and OpenAPI endpoint |
| `src/middleware/` | Shared JWT verification, installation ownership, rate-limit enforcement, and error handling |
| `src/services/` | Shared password/JWT helpers, current-user principal construction, and MongoDB rate counters |
| `src/utils/` | Shared HTTP errors and timestamp parsing |
| `src/models/` | Mongoose schemas and shared model helpers |
| `src/app.js` | Express application and API router mount |
| `src/index.js` | Server startup and shutdown |
| `scripts/` | Seed data generation and persistence |
| `test/` | Automated checks |

## Documentation

| Document | Purpose |
| --- | --- |
| [Conceptual data model](docs/data-model-reference.md) | Domain entities and relationships |
| [Architecture](docs/architecture.md) | Stored data, resource surface, authorization, and persistence design |
| [API design rules](docs/API_DESIGN_RULES.md) | HTTP methods, queries, response schemas, caching, and preconditions |
| [Design decisions](docs/decisions.md) | Rationale and unresolved choices |
| [Prompt log](docs/prompt-log.md) | Historical requests, corrections, and verification records |
| [AGENTS.md](AGENTS.md) | Instructions and invariants for coding agents |
