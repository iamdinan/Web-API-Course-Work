# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

A Node.js/Express API backed by Mongoose and MongoDB Atlas for solar generation data in Sri Lanka.

## Current implementation

The application currently provides public `/health` and `/openapi.json`, user/admin login at `POST /auth/user-tokens`, device login at `POST /auth/device-tokens`, protected `GET /provinces`, `GET /installations/{installationId}/readings`, and `GET /installations/{installationId}/readings/{readingId}`, six data models, the full dataset seed, and controlled user seeding. Login and protected reads use shared MongoDB limits. Installation JWT verification and URL ownership protect `POST /installations/{installationId}/readings`, with transactional active-status checks and shared device-write limits. Remaining resource endpoints, Swagger UI, database readiness, and other traffic limits remain planned. The architecture describes the target API; OpenAPI describes implemented routes only.

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

Append the paths below to your API base URL. Use your deployed HTTPS host with the configured prefix, for example `https://<your-host>/api/v1.0`. If the app runs locally, use `http://localhost:3000/api/v1.0` (adjust the port or prefix if configured).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Application liveness |
| GET | `/openapi.json` | Implemented OpenAPI specification |
| POST | `/auth/user-tokens` | Obtain a user/admin access token |
| POST | `/auth/device-tokens` | Obtain an installation access token |
| GET | `/provinces` | List provinces visible to the authenticated user |
| POST | `/installations/{installationId}/readings` | Submit a reading for the authenticated active installation |
| GET | `/installations/{installationId}/readings` | Page/filter reading history within the authenticated user's jurisdiction |
| GET | `/installations/{installationId}/readings/{readingId}` | Retrieve a reading within the authenticated user's jurisdiction |

Health does not query MongoDB. For a manual startup check, confirm the connection message and request the health path.

## Sample data

The seed creates 9 provinces, 25 districts, 25 synthetic substations, 220 installations, and 147,840 readings. Reruns insert missing data while preserving existing records. This dataset command does not provision users or admin accounts; use the separate user seed below.

Run `npm run seed` after configuring `MONGODB_URI`. The database must support transactions, as Atlas does. The command builds declared indexes, inserts missing data, prints collection totals (including unrelated records), and disconnects. It never clears the database.

For development, set `DEVICE_HASH_COMMON_PREFIX` in the ignored `.env`. A new installation's password is the exact prefix followed by its stored meter ID; the seed stores only a fresh salted scrypt hash. Reruns preserve existing credentials, so changing the prefix does not rotate stored hashes. Production devices must use independent credentials.

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

## Submit a device reading

Send the installation bearer token to POST `/installations/{installationId}/readings`, using the public installation ID returned by device login and a JSON body:

```json
{"recordedAt":"2026-10-08T12:00:00+05:30","powerKw":3.5,"energyKwh":42,"voltageV":230}
```

Use a timestamp not already stored for that installation. Use the returned Location with a user/admin bearer token to retrieve the created reading. See the [reading-submission contract](docs/API_DESIGN_RULES.md#device-reading-submission) for validation, responses, headers, and limits, and the [architecture](docs/architecture.md#reading-ingestion) for persistence coordination.

## Read an individual reading

Send the user/admin bearer token to GET `/installations/{installationId}/readings/{readingId}`, using both public UUIDs or the Location returned by submission. Historical readings remain available for inactive installations within the user's jurisdiction. Out-of-jurisdiction requests return 403; missing readings and reading/installation mismatches return 404. See the [individual-reading contract](docs/API_DESIGN_RULES.md#individual-reading) for responses and conditional requests.

## Read installation history

Send a user/admin bearer token to GET `/installations/{installationId}/readings`. Optional offset, limit, from/to and sort parameters select the page and time window; results default to newest first. See the [history contract](docs/API_DESIGN_RULES.md#installation-reading-history) for validation, pagination and caching.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/config/` | Environment configuration and database connection |
| `src/features/auth/` | User/device token routes, controllers, credential validation, and issuance services |
| `src/features/readings/` | Reading routes, controllers, validation, public serialization, scoped queries, and transactional ingestion |
| `src/features/provinces/` | Province routes, controllers, query validation, and scoped queries |
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
