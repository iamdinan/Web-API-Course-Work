# Solar Generation API — Web API Coursework

Student Index: COBSCCOMP251P-004

A Node.js/Express API backed by Mongoose and MongoDB Atlas for solar generation data in Sri Lanka.

## Current implementation

The application currently provides public `/health` and `/openapi.json` endpoints, six data models, and the full dataset seed. Authentication, resource endpoints, Swagger UI, database readiness, and shared rate limits remain planned. The architecture describes the target API; OpenAPI describes implemented routes only.

## Getting started

Requires Node.js 24 or later and access to MongoDB.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to your connection string, including the intended database name.
4. Start the application: `npm run dev`.

| Setting | Purpose | Default |
| --- | --- | --- |
| `MONGODB_URI` | Database connection URI | Required; example file uses local MongoDB |
| `API_BASE_URL` | Shared API path prefix | `/api/v1.0` |
| `PORT` | Local HTTP listener port | `3000` |

Existing process environment variables override `.env`. Keep credentials out of source control. Local development uses HTTP; production HTTPS is intended to terminate at the deployment proxy.

Startup connects to MongoDB before opening the HTTP listener. Watch for `MongoDB connected` and the endpoint URLs. Configuration or connection failures prevent startup; Ctrl+C closes the server and database connection.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with automatic restart on source changes |
| `npm start` | Start without watch mode |
| `npm test` | Run offline health/configuration, model, and seed tests |
| `npm run seed` | Insert the full sample dataset into the configured database |

## Local endpoints

With the default configuration:

| URL | Purpose |
| --- | --- |
| `http://localhost:3000/api/v1.0/health` | Application liveness; returns `{"status":"ok"}` |
| `http://localhost:3000/api/v1.0/openapi.json` | Implemented OpenAPI specification |

Health does not query MongoDB. For a manual startup check, confirm the connection message and request the health URL. See the [HTTP contract](docs/API_DESIGN_RULES.md) for response and conditional-request behavior.

## Sample data

The seed creates 9 provinces, 25 districts, 25 synthetic substations, 220 installations, and 147,840 readings. Reruns insert missing data while preserving existing records. No users or admin accounts are provisioned.

Run `npm run seed` after configuring `MONGODB_URI`. The database must support transactions, as Atlas does. The command builds declared indexes, inserts missing data, prints collection totals (including unrelated records), and disconnects. It never clears the database.

Optional local `SEED_DEVICE_SECRET_1` through `SEED_DEVICE_SECRET_220` values provide device secrets for new installations. Without them, random disposable secrets are used and their plaintext is not retained or printed. Secrets are salted and scrypt-hashed; changing these variables does not rotate existing credentials. Keep plaintext secrets out of source control.

See the [architecture seed section](docs/architecture.md#seed-dataset-and-persistence) for profiles, dates, persistence, and rerun guarantees. The saved [seed verification report](docs/seed-verification.json) records a previous Atlas rerun with zero inserted readings and unchanged document hashes/counts. It is historical evidence, not a current check or one that runs automatically with the seed.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/config/` | Environment configuration and database connection |
| `src/routes/`, `src/controllers/` | Routing and HTTP responses |
| `src/middleware/` | Common request and error handling |
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
