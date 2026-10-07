# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

A Node.js/Express API backed by Mongoose and MongoDB Atlas for solar generation data in Sri Lanka.

## Current implementation

The application currently provides public `/health` and `/openapi.json`, user/admin login at `POST /auth/user-tokens`, device login at `POST /auth/device-tokens`, protected `GET /provinces`, six data models, the full dataset seed, and controlled user seeding. Login and protected reads use shared MongoDB limits. Installation JWT verification and URL ownership middleware are available for future device routes. Reading submission, remaining resource endpoints, Swagger UI, database readiness, and other traffic limits remain planned. The architecture describes the target API; OpenAPI describes implemented routes only.

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
| `npm test` | Run offline authentication, protected province access, health/configuration, model, and seed tests |
| `npm run seed` | Insert the full sample dataset into the configured database |
| `npm run seed:users` | Insert and verify the 36 configured accounts without changing existing users |

## Local endpoints

With the default configuration:

| URL | Purpose |
| --- | --- |
| `http://localhost:3000/api/v1.0/health` | Application liveness; returns `{"status":"ok"}` |
| `http://localhost:3000/api/v1.0/openapi.json` | Implemented OpenAPI specification |
| `http://localhost:3000/api/v1.0/auth/user-tokens` | POST email/password to obtain a user/admin access token |
| `http://localhost:3000/api/v1.0/auth/device-tokens` | POST meterId/deviceSecret to obtain an installation access token |
| `http://localhost:3000/api/v1.0/provinces` | GET visible provinces using `Authorization: Bearer <access_token>` |

Health does not query MongoDB. For a manual startup check, confirm the connection message and request the health URL. See the [HTTP contract](docs/API_DESIGN_RULES.md) for response and conditional-request behavior.

## Sample data

The seed creates 9 provinces, 25 districts, 25 synthetic substations, 220 installations, and 147,840 readings. Reruns insert missing data while preserving existing records. This dataset command does not provision users or admin accounts; use the separate user seed below.

Run `npm run seed` after configuring `MONGODB_URI`. The database must support transactions, as Atlas does. The command builds declared indexes, inserts missing data, prints collection totals (including unrelated records), and disconnects. It never clears the database.

For development, set `DEVICE_HASH_COMMON_PREFIX` in the ignored `.env`. A new installation's password is the exact prefix followed by its stored meter ID; the seed stores only a fresh salted scrypt hash. This replaces the old per-installation secret variables and disposable-secret fallback. Reruns preserve existing credentials, so changing the prefix does not rotate stored hashes. Production devices must use independent credentials.

See the [architecture seed section](docs/architecture.md#seed-dataset-and-persistence) for profiles, dates, persistence, and rerun guarantees. The saved [seed verification report](docs/seed-verification.json) records a previous Atlas rerun with zero inserted readings and unchanged document hashes/counts. It is historical evidence, not a current check or one that runs automatically with the seed.

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

POST JSON containing only `email` and `password` to `/api/v1.0/auth/user-tokens`. A successful login returns `access_token`, `token_type=Bearer`, and `expires_in` in seconds. User ID, role, read scope, and regional assignment come from MongoDB. Unknown emails and incorrect passwords share the same 401 error.

Login responses use `Cache-Control: no-store`. Shared counters allow 5 attempts per 15 minutes per IP and normalized email; excess attempts return 429 with `Retry-After`. This endpoint issues access tokens only; remaining resource routes remain planned. See the [HTTP contract](docs/API_DESIGN_RULES.md#user-token-exchange) and [OpenAPI](docs/openapi.json) for request/error details.

## Device login

POST JSON containing only `meterId` and `deviceSecret` to `/api/v1.0/auth/device-tokens`. Submit the original secret; for the development seed it is the configured prefix followed by the meter ID. Login verifies the submitted value against the stored hash and returns the same token response fields as user login. It uses the existing JWT environment configuration; no additional variables are needed.

Unknown meters and incorrect secrets return the same 401; correct credentials for inactive installations return 403. Shared device-login counters allow 5 attempts per 15 minutes per IP and meter ID, independently of user-login counters. Responses use `Cache-Control: no-store`. Installation tokens cannot access user reads such as `/provinces`. Installation JWT verification and URL ownership checks are implemented as middleware; reading submission remains planned. No device write route is exposed yet. See the [verification contract](docs/API_DESIGN_RULES.md#installation-jwt-verification-and-ownership). See the [HTTP contract](docs/API_DESIGN_RULES.md#device-token-exchange) and [OpenAPI](docs/openapi.json).

## Protected province list

Send the access token in `Authorization: Bearer <access_token>` to `GET /api/v1.0/provinces`. National analysts/admins see all provinces; provincial analysts see their assigned province; district analysts see their district's parent province. Each request verifies the JWT and reloads current User access from MongoDB, so deleted users and stale privileges cannot bypass authorization.

The list returns `count`, `next`, `previous`, and public `items`. It accepts `provinceId`, `districtId`, `substationId`, `offset` (default 0), and `limit` (default 50, maximum 200); out-of-scope filters return an empty list. Responses use private scoped ETags; matching `If-None-Match` returns bodyless 304 only after authentication. Missing/invalid/expired/non-user tokens return 401. Shared read limits are 120/minute per User, including admins.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/config/` | Environment configuration and database connection |
| `src/routes/`, `src/controllers/` | Routing and HTTP responses |
| `src/middleware/` | Common request, validation, and error handling |
| `src/services/` | Password verification, JWT issuance, and shared login counters |
| `src/models/` | Mongoose schemas and shared model helpers |
| `src/app.js` | Express application and API router mount |
| `src/index.js` | Server startup and shutdown |
| `scripts/` | Seed data generation and persistence |
| `test/` | Offline automated tests |

## Documentation

| Document | Purpose |
| --- | --- |
| [Conceptual data model](docs/data-model-reference.md) | Domain entities and relationships |
| [Architecture](docs/architecture.md) | Stored data, resource surface, authorization, and persistence design |
| [API design rules](docs/API_DESIGN_RULES.md) | HTTP methods, queries, response schemas, caching, and preconditions |
| [Design decisions](docs/decisions.md) | Rationale and unresolved choices |
| [Prompt log](docs/prompt-log.md) | Historical requests, corrections, and verification records |
| [AGENTS.md](AGENTS.md) | Instructions and invariants for coding agents |
