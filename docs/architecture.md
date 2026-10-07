# Architecture — Solar Generation API

## Runtime

Express serves a JSON API under `/api/v1.0`. Requests pass through JWT verification, authorization, validation, services, and Mongoose before reaching MongoDB Atlas. Public documentation is available under the same base path over HTTPS.

Meters create readings. SLSEA users read data within their assigned jurisdiction. Admins have national analyst read access and can create installations, update their status to `inactive` using PATCH, and hard-delete installations only when they have no readings. A status update is not deletion.

## Stored data

| Model | Fields | Constraint |
| --- | --- | --- |
| Province | `publicId`, `name` | Unique public ID |
| District | `publicId`, `provinceId`, `name` | Existing province |
| GridSubstation | `publicId`, `districtId`, `name` | Existing district |
| SolarInstallation | `publicId`, `substationId`, `meterId`, `status`, `deviceCredentialHash` | Existing substation; unique meter ID, including inactive installations; status `active` or `inactive` |
| GenerationReading | `publicId`, `installationId`, `recordedAt`, `powerKw`, `energyKwh`, `voltageV`, `receivedAt` | Append-only; unique `(installationId, recordedAt)`; nonnegative measurements |
| User | `publicId`, `email`, `passwordHash`, `role`, `readScope`, optional `provinceId`/`districtId` | Unique email; role `user` or `admin`; jurisdiction matches read scope; admins require `readScope=national` without regional assignment; no `active` field |

- Generate random, immutable UUID v4 `publicId` values. Use them in URLs, parent references, response `id` fields, `Location`, and JWT claims.
- Express public reading timestamps in Sri Lankan time (Asia/Colombo, ISO 8601 with `+05:30`). Store BSON dates as UTC instants; formatting must not shift the stored measurement time.
- Keep MongoDB `_id` internal. Disable Mongoose's `id` virtual derived from `_id`; omit `_id`, `__v`, and credential hashes from JSON.
- Index `publicId` uniquely on every model and readings on `{ installationId: 1, recordedAt: -1, publicId: -1 }`. Bound regional and time-window queries in MongoDB.

Seed with random UUID v4 public IDs: 9 provinces, 25 districts, 25 synthetic substations (one per district), and 220 installations. Each installation has 672 readings at 15-minute intervals over seven days, totaling 147,840 readings. Reuse geography by name within its parent and installations by unique meter ID; upsert readings by `(installationId, recordedAt)` while preserving their IDs. Generate IDs only for missing records and use stored parent IDs for references.

Substation names use `<district> Grid Substation` (for example, `Colombo Grid Substation`),
and meter IDs use `METER-<district number>-<installation number>` with two-digit
numbers (for example, `METER-01-01`). No seed prefix is included in live names.
The completed naming correction preserved public IDs, parent references,
credentials, statuses and readings. Normal model/API meter identity remains immutable.

`npm run seed` builds declared indexes without dropping them, inserts missing
geography/installations in per-district transactions, and inserts readings in
one batch of 672 per installation using insert-only upserts. Each batch transaction locks
its parent installations while inserting, then removes the transient lock field.
Existing IDs, parent references, inactive statuses, credential hashes, and reading
values are preserved. No users are provisioned and unrelated records are retained.
The fixed window is 2026-09-30 00:00 through 2026-10-06 23:45 in Asia/Colombo
(end-exclusive 2026-10-07 00:00). Power is zero overnight, with a smooth daytime
solar curve, site capacities of 3–15 kW, and deterministic cloud/day variation.
Cumulative kWh integrates consecutive power samples using the trapezoidal rule;
receivedAt is five seconds after recordedAt. Stable meter IDs and the fixed window
make interrupted runs resumable and reruns idempotent.

The former two-installation demo was already moved atomically into
`seed_fixture_archive`. Complete original records and credentials, plus copies
of shared Western/Colombo parents, remain there. Those two parents were reused
unchanged in the live hierarchy. Completed migration tools and obsolete small
fixtures have been removed; the current seed neither renames nor deletes data.
The last full Atlas rerun verification (unchanged counts and complete-document
hashes, all parents and profiles valid) is retained as historical evidence in
`docs/seed-verification.json`. Current offline tests verify generation, insert-only
reruns, identity/status/credential preservation, models and API contracts.
References are validated public UUID strings, not ObjectId references.
Parent-plus-publicId indexes support hierarchy lists; readings have both the
unique timestamp index and descending history index specified above, plus a
global time/publicId index for regional history. Meter ID and normalized email
have unique indexes. User jurisdiction is national with no assignment, province
with only provinceId, or district with only districtId; admins require national.

## Resource surface

Prefix every path below with `/api/v1.0`. Each row is one path. “User” means an authenticated SLSEA principal with read access to that jurisdiction, including admins with national analyst access to every User GET below. “Admin” means role `admin`, which additionally grants installation creation, status updates to inactive, and hard deletion of installations without readings.

### Geography

| Path | Method | Access |
| --- | --- | --- |
| `/provinces` | GET | User; visible provinces |
| `/provinces/{provinceId}` | GET | User; province |
| `/provinces/{provinceId}/districts` | GET | User; districts in province |
| `/districts/{districtId}` | GET | User; district |
| `/districts/{districtId}/grid-substations` | GET | User; substations in district |
| `/grid-substations/{substationId}` | GET | User; substation |

### Installations and readings

| Path | Method | Access |
| --- | --- | --- |
| `/grid-substations/{substationId}/installations` | GET | User; installations at substation |
| `/installations` | GET, POST | User; regional list. Admin; create installation |
| `/installations/{installationId}` | GET, PATCH, DELETE | User; details. Admin; set status to inactive, or hard-delete only if no readings exist |
| `/installations/{installationId}/overview` | GET | User; details, geography, latest reading |
| `/installations/{installationId}/last-reading` | GET | User; latest reading |
| `/installations/{installationId}/readings` | GET, POST | User; history. Bound device; new reading |
| `/installations/{installationId}/readings/{readingId}` | GET | User; individual reading |
| `/readings` | GET | User; regional history |
| `/summarize-district-generation` | GET | User; required `districtId` query |

### Authentication and documentation

| Path | Method | Access |
| --- | --- | --- |
| `/health` | GET | Public application liveness; returns `{ "status": "ok" }`, no database check |
| `/auth/device-tokens` | POST | Meter credential exchange |
| `/auth/user-tokens` | POST | User or admin credential exchange |
| `/openapi.json` | GET | Public OpenAPI specification |
| `/docs` | GET | Public Swagger UI |

## Read behavior

- History uses `from` (inclusive), `to` (exclusive), `sort=timestamp|-timestamp`, `offset` (default 0), and `limit` (default 50, max 200). Regional lists accept `provinceId`, `districtId`, and `substationId`; reject conflicting ancestry.
- Apply jurisdiction and filters before counting and paging. Sort readings by `recordedAt` and `publicId`. Return `{ "count": 0, "next": null, "previous": null, "items": [] }` with links preserving the query.
- `last-reading` selects the latest measurement. `overview` composes the installation, its geography, and latest reading. A site with no readings returns 404 for `last-reading`.
- `summarize-district-generation?districtId=...` reports `asOf`, fresh/stale installation counts, current power, today's energy, and incomplete-energy count. Use Asia/Colombo day boundaries and a 30-minute freshness threshold. Calculate energy from counter changes with reset/baseline handling, not the sum of cumulative counters.
- Keep inactive installations and their history visible to users within jurisdiction, including lists, counts, overview, and latest-reading views. District summaries exclude inactive installations from current power and fresh/stale counts, but include their retained readings in today's energy and incomplete-energy calculation. Recompute affected validators after creation, status updates, or hard deletion.

## Admin installation management

- **Access:** Admins have national analyst reads (`readScope=national`, no `provinceId`/`districtId`) across geography, installations, readings, overview, latest readings, and district summaries, including retained inactive history. Derive `installation-create`, `installation-deactivate`, and `installation-delete` server-side from the stored admin role; deletion requires no readings. Users retain assigned reads. No user-management, geography-write, reading-write, credential-rotation, general edit, or reactivation permissions; no PUT. Apply the same filters, counts, pagination, private cache validators, and 120/min per-user read limit to admins.
- **POST `/installations`:** Accept only `substationId` (existing public UUID), `meterId` (nonempty unique string), and `deviceSecret` (nonempty provisioning secret). Generate `publicId`, set `status=active`, and salt/hash the secret. Reject unknown fields, including supplied IDs, status, and hashes; never return/log secrets or hashes. Return 201 with public fields and `Location: /api/v1.0/installations/{installationId}` (GET requires jurisdiction-authorized user).
- **PATCH `/installations/{installationId}`:** Status update, not deletion; accept exactly `{ "status": "inactive" }`. Return 200 with public fields, including unchanged state on repeats; 404 if missing, 400 for other statuses/fields. Preserve installation, meter binding, ancestry, and readings; reserve meter ID while it exists. Check current status on every ingestion: inactive installations cannot obtain tokens or ingest, even with unexpired tokens; otherwise valid credentials/tokens return 403.
- **DELETE `/installations/{installationId}`:** No body; hard-delete active/inactive installations only if no GenerationReading references their public ID at any timestamp. Return bodyless 204, 404 if absent/repeated, or 409 `INSTALLATION_HAS_READINGS` without mutation. Never cascade-delete readings. Success removes installation and credential hash, releasing meter ID; re-registration gets a new public UUID inaccessible to old installation-bound tokens.
- **Conditional writes:** PATCH/DELETE accept optional `If-Match` against the current strong ETag of the installation's public detail representation, also returned by GET. Absence preserves existing behavior. Apply `API_DESIGN_RULES.md` tag-list/wildcard/syntax and request-order rules; no strong match returns standard JSON 412 `PRECONDITION_FAILED` without change, including no-op PATCH. Check DELETE's no-readings guard only after a matching precondition (409 with readings). Successful PATCH returns its resulting strong ETag, unchanged for a no-op; successful DELETE stays bodyless 204 without validators.
- **Concurrency:** Atomically coordinate the no-readings guard/deletion with ingestion through a shared installation write in both database transactions, or an equivalent guarantee; separate check-then-delete and snapshot reads alone are insufficient. Ingestion committing first yields delete 409; deletion committing first prevents reading commit and yields token 401. Verify current installation existence; prevent orphaned readings under every interleaving.
- **ETag atomicity:** Hash a deterministic serialization of public installation fields (`id`, `substationId`, `meterId`, `status`) into a quoted strong tag, never `W/`; use identical serialization for GET and PATCH. Compare If-Match and mutate the same installation state using a transaction/shared installation write or compare-and-swap, including no-op PATCH. On write conflict, reload and re-evaluate the precondition; never reuse a stale successful comparison. Derive the response ETag from the committed PATCH representation. Coordinate DELETE's precondition and readings guard in the same ingestion-safe mutation; internal locking/revisions must not change an unchanged public representation's ETag.
- **Setup:** Provision initial user/admin accounts through controlled setup with environment credentials and stored password hashes; no public registration/user-management routes. Seed/setup reruns preserve deactivation and credentials. Never commit passwords or device secrets.

## Security

- A meter exchanges its `meterId` and secret for a short-lived JWT with `actor=installation`, `installation-write`, and its installation public ID. Store only the salted secret hash. The token may POST readings only under that installation; the server sets ownership.
- Users and admins exchange email and password through `/auth/user-tokens`. JWTs contain `actor=user`, the user's public ID, and `role`. Role `user` tokens carry a national/province/district read scope and assigned jurisdiction; role `admin` tokens carry `readScope=national` without regional assignment plus `installation-create`, `installation-deactivate`, and `installation-delete`. Verify signature, allowed algorithm, issuer, audience, expiry, and the principal's continued existence. Derive effective authorization from the current stored role and jurisdiction, rather than relying on stale token claims. User has no `active` attribute.
- Check the actual geographic ancestry before every lookup, list, count, overview, summary, or cache validator. An inaccessible atomic ID returns 404; a forbidden action on an accessible resource returns 403. Keep signing keys and credentials in environment configuration.

## Rate limits

Use shared counters with atomic updates and expiry across deployed instances. Return JSON 429 with `Retry-After`.

| Traffic | Initial limit | Key |
| --- | --- | --- |
| Token issuance | 5 attempts / 15 min | IP and account or meter ID |
| Device ingestion | 30 / min | Installation and IP |
| User and admin reads | 120 / min | User |
| Admin installation writes | 30 / min | Admin |
| Public docs | 60 / min | IP |
| Backstop | 300 / min | IP |

See `API_DESIGN_RULES.md` for the HTTP response contract and `decisions.md` for pending choices.

The initial implementation provides `/health` and `/openapi.json`; `docs/openapi.json` describes implemented routes only. The configured `API_BASE_URL` defaults to `/api/v1.0` and is imported at the API router mount. Startup now awaits a Mongoose connection using `MONGODB_URI` before opening the HTTP listener; initial failure prevents startup. SIGINT/SIGTERM close HTTP and database connections. Health remains a liveness check, without a database query. Other resource routes, Swagger UI, a database readiness endpoint, and shared rate limits remain planned.
