# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

Node.js/Express, Mongoose and MongoDB Atlas API for Sri Lankan solar generation data.

## Current implementation

Implemented routes are listed under [API endpoints](#api-endpoints) and in [OpenAPI](docs/openapi.json). They include user/device authentication, jurisdiction-scoped geography and installation reads, reading ingestion/history, district summaries, and admin installation creation/status updates/guarded deletion. Shared MongoDB limits cover login, protected reads, device ingestion and admin writes; PATCH/DELETE support atomic optional If-Match. Swagger UI (`/docs`), database readiness and public/backstop limits remain planned. [Architecture](docs/architecture.md#resource-surface) describes the target surface.

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

## API endpoints

Append these paths to `http://localhost:3000/api/v1.0` locally or `https://<your-host>/api/v1.0` in deployment; adjust the configured port/prefix. Protected GETs use user/admin bearer tokens; reading POST uses the bound device token; installation writes require a current database admin.

| Method | Path |
| --- | --- |
| GET | `/health`, `/openapi.json` (public) |
| POST | `/auth/user-tokens`, `/auth/device-tokens` (credential exchange) |
| GET | `/provinces`, `/provinces/{provinceId}`, `/provinces/{provinceId}/districts` |
| GET | `/districts/{districtId}`, `/districts/{districtId}/grid-substations` |
| GET | `/grid-substations/{substationId}`, `/grid-substations/{substationId}/installations` |
| GET, POST | `/installations` |
| GET, PATCH, DELETE | `/installations/{installationId}` |
| GET | `/installations/{installationId}/overview`, `/installations/{installationId}/last-reading` |
| GET, POST | `/installations/{installationId}/readings` |
| GET | `/installations/{installationId}/readings/{readingId}`, `/readings` |
| GET | `/summarize-district-generation?districtId=...` |

See [HTTP rules](docs/API_DESIGN_RULES.md) for parameters, access failures, fields and caching, and OpenAPI for machine-readable schemas. Health checks liveness without querying MongoDB; check the startup connection message separately.

## Sample data

Run `npm run seed` with `MONGODB_URI` and `DEVICE_HASH_COMMON_PREFIX` configured in ignored `.env`. MongoDB must support transactions (Atlas does). The command builds indexes, inserts missing fixtures, prints collection totals including unrelated records, and disconnects; it never clears data or provisions users.

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
{"recordedAt":"2026-10-08T12:00:00+05:30","powerKw":3.5,"energyKwh":42,"voltageV":230}
```

Use a previously unused measurement timestamp. Retrieve the returned Location with a jurisdiction-authorized user/admin token. GET `/installations?status=active` or `?status=inactive` narrows installations within the authorized area; omission includes both. It combines with geography filters and pagination. Lists/history accept only their [documented queries](docs/API_DESIGN_RULES.md#resource-and-query-rules); the province list and small nested lists have no pagination. GET `/provinces` accepts no queries and returns only count/items within the current stored jurisdiction. Every endpoint without documented query options rejects supplied parameters with 400 INVALID_QUERY, including public endpoints, login and writes. Summary energy is observed and may be incomplete; check incompleteEnergyInstallationCount. Historical seed dates can produce stale current power.

## Manual verification

Use a test database and real public UUIDs. Keep provisioning secrets privately. Detailed expected responses live in the HTTP contract; `npm test` includes isolated concurrency checks, which sequential manual requests cannot establish.

For protected GETs, exercise national/admin and authorized provincial/district tokens, then outside-jurisdiction, device, invalid and missing tokens. Check malformed/missing UUIDs, unsupported/repeated queries, scoped counts and empty results. Save an ETag and repeat with it or `If-None-Match: *` for bodyless 304. If-Modified-Since alone gives 200 except on individual/latest readings. Errors have no-store and no validators. Example (PowerShell):

```powershell
$base = 'http://localhost:3000/api/v1.0'
$url = "$base/provinces/$provinceId"
$response = Invoke-WebRequest $url -Headers @{ Authorization = "Bearer $userToken" }
$response.Content
curl.exe -i $url -H "Authorization: Bearer $userToken" -H "If-None-Match: $($response.Headers.ETag)"
```

Also verify district users see only their district in the parent province list; substation installation lists include both statuses and count equals all items without paging links. Summaries have seven fields, empty districts have zero totals, and ETags change with displayed asOf minutes or calculated values. Automated clock checks cover freshness/midnight boundaries.

### Create an installation

Use a real substation UUID and admin token:

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

Verify 201, Location, no-store and a detail-compatible ETag. Repeat the meter for 409, use analyst/device tokens for 403/401, invalid/extra fields for 400 and a missing parent for 404.

### Change installation status

In Postman, set baseUrl, adminToken, installationId and a deviceToken issued while active; save the original meterId/deviceSecret privately. GET detail and save its quoted ETag as activeETag.

1. PATCH with JSON `{"status":"inactive"}` and `If-Match: {{activeETag}}`; save inactiveETag. Verify detail/tag match, history remains and the meter stays reserved (duplicate creation 409).
2. Repeat with inactiveETag, `*`, no header and a list `"unrelated", {{inactiveETag}}`: unchanged 200/body/tag. Old activeETag or `W/{{inactiveETag}}`: 412; unquoted/trailing-comma headers: 400; missing UUID: 404 even with bad preconditions.
3. Invalid path/body/status or extra fields: 400; no/invalid/device token: 401; analyst: 403. Correct-secret device login and saved-token ingestion while inactive: 403.
4. PATCH active with inactiveETag. Original credentials and unexpired device tokens work again until their original expiry; expired tokens remain 401. The original active ETag returns if public fields are unchanged; inactiveETag is now stale. Repeat active requests are unchanged 200. Admin tokens continue to use current stored roles.

### Delete an empty installation

1. Create an empty fixture, obtain its device token and save detail ETag. DELETE with Body > none and optional matching If-Match; omit Content-Type. Verify 204 with no body/Content-Type/validators and no-store; repeat DELETE/detail: 404.
2. Use additional fixtures for absent header, `*`, matching tag list and inactive-empty deletion. Stale/weak tags: 412 without change; malformed headers: 400; missing resource: 404 before preconditions. Invalid UUID/body (including `{}`, `[]`, raw text): 400; no/invalid/device token: 401; analyst: 403.
3. Submit a reading to another fixture. Current/wildcard/absent If-Match: 409 INSTALLATION_HAS_READINGS; stale: 412 first. Repeat while inactive; verify history/detail stay intact.
4. Old device token against the deleted UUID: 401. Register the same meter again: new UUID; old token fails against both URLs. New login uses the replacement's secret.

In a fresh admin rate window, run 31 valid-shaped PATCH or bodyless DELETE requests for a nonexistent UUID: first 30 return 404, then 429 with Retry-After. Earlier POST/PATCH/DELETE attempts share the budget. See [status](docs/API_DESIGN_RULES.md#installation-status-updates) and [deletion](docs/API_DESIGN_RULES.md#installation-deletion) contracts for complete rules.

## Project layout

`src/features/` groups routes, validation, controllers and services by feature; shared configuration, middleware, services, utilities and models live in sibling directories. `src/routes/api.routes.js` composes the API and serves OpenAPI; `src/app.js` mounts it; `src/index.js` handles startup/shutdown. `scripts/` contains seed tooling; `test/` contains automated checks. [Architecture](docs/architecture.md#runtime-and-structure) defines ownership and separation rules.

## Documentation

| Document | Purpose |
| --- | --- |
| [Conceptual data model](docs/data-model-reference.md) | Domain entities and relationships |
| [Architecture](docs/architecture.md) | Stored schemas, target paths, access and persistence |
| [API design rules](docs/API_DESIGN_RULES.md) | Shared HTTP contract and endpoint exceptions |
| [OpenAPI](docs/openapi.json) | Implemented operations, schemas, parameters and responses; compact JSON with shared components |
| [Design decisions](docs/decisions.md) | Rationale and pending choices |
| [Prompt log](docs/prompt-log.md) | Historical requests, corrections and verification |
| [AGENTS.md](AGENTS.md) | Coding-agent instructions and invariants |
