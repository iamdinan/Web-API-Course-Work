# Architecture — Solar Generation API

This document defines the target stored data, resource surface, authorization, and persistence design. The [README](../README.md#current-implementation) tracks implementation status; [API_DESIGN_RULES.md](API_DESIGN_RULES.md) owns the HTTP contract and [decisions.md](decisions.md) records rationale. The [conceptual reference](data-model-reference.md) explains domain relationships.

## Runtime and structure

The target Express JSON API uses `/api/v1.0`, with HTTPS terminating at the deployment proxy. Protected requests will pass through JWT verification, authorization, validation, services, and Mongoose before reaching MongoDB Atlas. Public documentation uses the same base path.

`src/config` owns environment/database configuration; routes define relative resource paths, controllers handle HTTP responses, and middleware handles common request behavior. `src/app.js` mounts the configured API prefix; `src/index.js` owns startup/shutdown. Add services for business logic and persistence coordination as features are implemented. Startup awaits MongoDB before listening, initial failure prevents startup, and SIGINT/SIGTERM close both connections. Health remains a liveness check without a database query.

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
- Store BSON dates as UTC instants. Public timestamp formatting follows the [HTTP contract](API_DESIGN_RULES.md#responses); local-day calculations use Asia/Colombo.
- Keep MongoDB `_id` internal. Disable Mongoose's `id` virtual derived from `_id`; omit `_id`, `__v`, and credential hashes from JSON.
- Index `publicId` uniquely on every model and readings on `{ installationId: 1, recordedAt: -1, publicId: -1 }`. Bound regional and time-window queries in MongoDB.

References are validated public UUID strings, not ObjectId references. Parent-plus-publicId indexes support hierarchy lists. Readings have the unique timestamp index, descending history index, and a global time/publicId index for regional history. Meter ID and normalized email have unique indexes. User jurisdiction is national with no assignment, province with only `provinceId`, or district with only `districtId`; admins require national.

Normal validated document writes check parent existence. Validate complete User documents when changing roles/jurisdictions; partial query validators cannot enforce cross-field rules. Model updates/deletions of readings are blocked except insert-only upserts. Raw collection access bypasses Mongoose guards and must not be used for API writes. Services must coordinate ingestion/deletion as specified below.

## Seed dataset and persistence

| Collection | Seed count |
| --- | --- |
| Provinces | 9 |
| Districts | 25 |
| Grid substations | 25; one synthetic substation per district |
| Solar installations | 220 |
| Generation readings | 147,840; 672 per installation |

Geography uses Sri Lanka's real province/district hierarchy. Substations are named `<district> Grid Substation`, such as `Colombo Grid Substation`. Meter IDs use `METER-<district number>-<installation number>` with two-digit numbers, such as `METER-01-01`.

Each installation has seven complete days of 15-minute samples, from 2026-09-30 00:00 through 2026-10-06 23:45 in Asia/Colombo; the end-exclusive boundary is 2026-10-07 00:00. Synthetic capacities are 3–15 kW. Power follows a daytime solar curve with deterministic day/cloud variation and is zero overnight. Cumulative kWh integrates consecutive power samples using the trapezoidal rule; `receivedAt` is five seconds after `recordedAt`.

Seed dates specify `+05:30`. MongoDB stores those instants as UTC BSON dates, so database tools may display `Z`. For example, 03:00 UTC is 08:30 Sri Lankan time. Public reading JSON uses `+05:30`, as defined in the [HTTP contract](API_DESIGN_RULES.md).

### Rerun guarantees

New records receive random UUID v4 public IDs. Geography is reused by name within its parent; installations are reused by unique meter ID. A conflicting meter parent or ambiguous geography identity causes failure instead of reassignment. Existing IDs, parent references, inactive statuses, credential hashes, and reading values are preserved. The seed never renames or deletes records.

Hierarchy writes use per-district transactions. Readings use one batch of 672 insert-only upserts per installation, keyed by `(installationId, recordedAt)`. Each batch validates measurements and writes a temporary parent lock within the transaction to coordinate with deletion, removing it before commit. Existing samples are skipped; interrupted runs can resume by inserting missing samples. Earlier committed transactions remain if a later batch fails.

The seed is setup tooling and may restore missing fixture history for an inactive installation. Device ingestion must still reject inactive installations.

`scripts/seed-data.js` generates the geography and profiles; `scripts/seed.js` handles persistence. `test/seed.test.js` checks generation and rerun preservation offline. See the [README](../README.md#sample-data) for commands, credential configuration, and historical verification evidence.

The former two-installation demo is preserved separately in `seed_fixture_archive`, including copies of the shared Western/Colombo parents reused in the live hierarchy. The current seed leaves the archive untouched. Completed migration tools and the one-off verifier were removed; their history remains in the [prompt log](prompt-log.md).

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

- Apply jurisdiction and filters in database queries before counting, paging, composing views, or calculating validators. Query parameters, sorting, and list envelopes follow the [HTTP contract](API_DESIGN_RULES.md#resource-and-query-rules). Reject geographic filters with conflicting ancestry.
- `last-reading` selects the latest measurement. `overview` composes the installation, its geography, and latest reading; see the HTTP contract for the empty latest-reading response.
- `summarize-district-generation?districtId=...` reports `asOf`, fresh/stale installation counts, current power, today's energy, and incomplete-energy count. Use Asia/Colombo day boundaries and a 30-minute freshness threshold. Calculate energy from counter changes with reset/baseline handling, not the sum of cumulative counters.
- Keep inactive installations and their history visible to users within jurisdiction, including lists, counts, overview, and latest-reading views. District summaries exclude inactive installations from current power and fresh/stale counts, but include their retained readings in today's energy and incomplete-energy calculation. Recompute affected validators after creation, status updates, or hard deletion.

## Admin installation management

- **Access:** Admins have national analyst reads (`readScope=national`, no `provinceId`/`districtId`) across geography, installations, readings, overview, latest readings, and district summaries, including retained inactive history. Derive `installation-create`, `installation-deactivate`, and `installation-delete` server-side from the stored admin role; deletion requires no readings. Users retain assigned reads. No user-management, geography-write, reading-write, credential-rotation, general edit, or reactivation permissions; no PUT. Apply the same scoped read behavior and user read limits to admins.
- **POST `/installations`:** Accept only `substationId` (existing public UUID), `meterId` (nonempty unique string), and `deviceSecret` (nonempty provisioning secret). Generate `publicId`, set `status=active`, and salt/hash the secret. Reject unknown fields, including supplied IDs, status, and hashes; never return/log secrets or hashes. Response status and headers follow the HTTP contract.
- **PATCH `/installations/{installationId}`:** Status update, not deletion; accept exactly `{ "status": "inactive" }`. Repeated deactivation preserves the same public representation; reject other statuses/fields. Preserve installation, meter binding, ancestry, and readings; reserve meter ID while it exists. Check current status on every ingestion: inactive installations cannot obtain tokens or ingest, even with unexpired tokens; rejection statuses follow the HTTP contract.
- **DELETE `/installations/{installationId}`:** No body; hard-delete active/inactive installations only if no GenerationReading references their public ID at any timestamp. Never cascade-delete readings. Success removes installation and credential hash, releasing meter ID; re-registration gets a new public UUID inaccessible to old installation-bound tokens.
- **Conditional writes:** Apply the optional installation-detail `If-Match` comparison and ordering in the [HTTP contract](API_DESIGN_RULES.md#caching-and-access), with the atomicity guarantees below.
- **Concurrency:** Atomically coordinate the no-readings guard/deletion with ingestion through a shared installation write in both database transactions, or an equivalent guarantee; separate check-then-delete and snapshot reads alone are insufficient. Ingestion committing first blocks deletion; deletion committing first prevents the reading commit. Use the HTTP contract for rejection statuses. Verify current installation existence; prevent orphaned readings under every interleaving.
- **ETag atomicity:** Hash a deterministic serialization of public installation fields (`id`, `substationId`, `meterId`, `status`) into a quoted strong tag, never `W/`; use identical serialization for GET and PATCH. Compare If-Match and mutate the same installation state using a transaction/shared installation write or compare-and-swap, including no-op PATCH. On write conflict, reload and re-evaluate the precondition; never reuse a stale successful comparison. Derive the response ETag from the committed PATCH representation. Coordinate DELETE's precondition and readings guard in the same ingestion-safe mutation; internal locking/revisions must not change an unchanged public representation's ETag.
- **Setup:** Provision initial user/admin accounts through controlled setup with environment credentials and stored password hashes; no public registration/user-management routes. Seed/setup reruns preserve deactivation and credentials. Never commit passwords or device secrets.

## Security

- A meter exchanges its `meterId` and secret for a short-lived JWT with `actor=installation`, `installation-write`, and its installation public ID. Store only the salted secret hash. The token may POST readings only under that installation; the server sets ownership.
- Users and admins exchange email and password through `/auth/user-tokens`. JWTs contain `actor=user`, the user's public ID, and `role`. Role `user` tokens carry a national/province/district read scope and assigned jurisdiction; role `admin` tokens carry `readScope=national` without regional assignment plus `installation-create`, `installation-deactivate`, and `installation-delete`. Verify signature, allowed algorithm, issuer, audience, expiry, and the principal's continued existence. Derive effective authorization from the current stored role and jurisdiction, rather than relying on stale token claims. User has no `active` attribute.
- Check the actual geographic ancestry before every lookup, list, count, overview, summary, or cache validator. Use the HTTP contract for inaccessible-resource and forbidden-action responses. Keep signing keys and credentials in environment configuration.

## Rate limits

Use shared counters with atomic updates and expiry across deployed instances. The HTTP contract defines rate-limit responses.

| Traffic | Initial limit | Key |
| --- | --- | --- |
| Token issuance | 5 attempts / 15 min | IP and account or meter ID |
| Device ingestion | 30 / min | Installation and IP |
| User and admin reads | 120 / min | User |
| Admin installation writes | 30 / min | Admin |
| Public docs | 60 / min | IP |
| Backstop | 300 / min | IP |

These are initial thresholds; see [pending decisions](decisions.md#pending-decisions) before finalizing implementation.
