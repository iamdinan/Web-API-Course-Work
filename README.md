# Solar Generation API

A Node.js and Express API for solar generation data in Sri Lanka, using MongoDB and Mongoose.

Student index: COBSCCOMP251P-004

## Current implementation

The API supports user and device authentication, readings, district summaries, and installation management. The [endpoint table](#api-endpoints) lists the available routes.

## Getting started

You need Node.js 24 or later and MongoDB Atlas or a local MongoDB replica set.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set your database connection and JWT settings below.
4. Run `npm run dev`.

To generate a signing key locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

For local MongoDB, [configure a replica set](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/) named `rs0` and run `rs.initiate()` once. The example URI is `mongodb://127.0.0.1:27017/solar-generation?replicaSet=rs0`. A standalone MongoDB server cannot run the required transactions.

| Setting | Purpose | Default |
| --- | --- | --- |
| `MONGODB_URI` | Database connection URI, including the database name | Required |
| `API_BASE_URL` | API path prefix | `/api/v1.0` |
| `PORT` | Server port | `3000` |
| `JWT_SIGNING_KEY` | Private signing key, at least 32 bytes | Required |
| `JWT_ISSUER` | Token issuer | Required; example: `solar-generation-api` |
| `JWT_AUDIENCE` | Token audience | Required; example: `solar-generation-users` |
| `JWT_EXPIRES_IN_SECONDS` | Token lifetime, from 60 to 3600 seconds | `900` |
| `DEVICE_HASH_COMMON_PREFIX` | Private device-secret prefix for sample data | Required for seeding |

Keep credentials out of source control. Process environment variables override `.env`. The local server uses HTTP; deployment uses HTTPS through a proxy.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with automatic restart on source changes |
| `npm start` | Start without watch mode |
| `npm run seed` | Add the sample dataset |
| `npm run seed:users` | Add and verify the 36 configured accounts |

## API endpoints

The default local base URL is `http://localhost:3000/api/v1.0`. Append the paths below to it.

| Method | Path |
| --- | --- |
| GET | `/health`, `/openapi.json`, `/docs` (public; `/docs` serves HTML) |
| POST | `/auth/user-tokens`, `/auth/device-tokens` |
| GET | `/provinces`, `/provinces/{provinceId}`, `/provinces/{provinceId}/districts` |
| GET | `/districts/{districtId}`, `/districts/{districtId}/grid-substations` |
| GET | `/grid-substations/{substationId}`, `/grid-substations/{substationId}/installations` |
| GET, POST | `/installations` |
| GET, PATCH, DELETE | `/installations/{installationId}` |
| GET | `/installations/{installationId}/overview`, `/installations/{installationId}/last-reading` |
| GET, POST | `/installations/{installationId}/readings` |
| GET | `/installations/{installationId}/readings/{readingId}`, `/readings` |
| GET | `/districts/{districtId}/generation-summary` |

Open [Swagger UI](http://localhost:3000/api/v1.0/docs) to try requests and view schemas. Adjust the URL if you change the port or prefix.

Use a user token for protected reads, the installation's device token to submit readings, and an admin token to manage installations. Send tokens as `Authorization: Bearer <access_token>`. See [OpenAPI](docs/openapi.json) for request fields, query parameters, access rules and caching.

`/health` returns 200 when MongoDB responds and 503 when it is unavailable.

## Sample data

Set `MONGODB_URI` and `DEVICE_HASH_COMMON_PREFIX`, then run `npm run seed`.

The dataset includes 9 provinces, 25 districts, 25 substations, 220 installations and 147,840 readings. Reruns add missing records and preserve existing data. Accounts are seeded separately.

For a newly seeded installation, its device secret is the private prefix followed by its meter ID. Changing the prefix does not update existing credentials. Use independent secrets for production devices. See [seed details](docs/architecture.md#seed-dataset-and-persistence) for dates and profiles.

## User accounts

1. Copy [seed-users.env.example](seed-users.env.example) to `seed-users.env`.
2. Replace the example emails and fill in all 36 passwords. Quote passwords containing `#` or surrounding spaces.
3. Run `npm run seed` first, then `npm run seed:users`.

The command reads database settings from `.env` and account credentials from `seed-users.env`. Both files are ignored by Git.

| Accounts | Environment keys |
| --- | --- |
| 1 admin | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` |
| 1 national analyst | `SEED_NATIONAL_EMAIL`, `SEED_NATIONAL_PASSWORD` |
| 9 provincial analysts | `SEED_PROVINCE_<NAME>_EMAIL`, `SEED_PROVINCE_<NAME>_PASSWORD` |
| 25 district analysts | `SEED_DISTRICT_<NAME>_EMAIL`, `SEED_DISTRICT_<NAME>_PASSWORD` |

Names use uppercase letters and underscores, such as `NORTH_WESTERN`. The supplied `MONARAGALA` keys map to the stored district `Moneragala`.

All credential pairs are required on each run. Existing accounts keep their passwords, roles and jurisdictions; editing the file does not reset them. The command prints verification counts. See [user seeding](docs/architecture.md#user-seeding) for details.

## Manual verification

Use Swagger UI with a separate development database to try the API. [OpenAPI](docs/openapi.json) describes the expected responses and access restrictions.

## Documentation

| Document | Purpose |
| --- | --- |
| [Conceptual data model](docs/data-model-reference.md) | Domain entities and relationships |
| [Architecture](docs/architecture.md) | Stored data, access and persistence |
| [API design rules](docs/API_DESIGN_RULES.md) | Common REST API conventions |
| [OpenAPI](docs/openapi.json) | Endpoint and schema reference |
| [Design decisions](docs/decisions.md) | Rationale and unresolved issues |
| [AGENTS.md](AGENTS.md) | Coding-agent instructions |
