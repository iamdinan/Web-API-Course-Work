# WEB API COURSE WORK

Student Index: COBSCCOMP251P-004

Requires Node.js 24 or later. Install dependencies with `npm ci`, copy `.env.example`
to `.env`, and run `npm run dev` (or `npm start`). Existing process environment
variables override `.env`. `API_BASE_URL=/api/v1.0` is the shared API path prefix;
`PORT=3000` controls the local HTTP listener. Production HTTPS terminates at the
deployment proxy.

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
