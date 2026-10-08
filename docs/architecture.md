# Architecture — Solar Generation API

This document defines stored data, resource access and persistence. The [README](../README.md#current-implementation) tracks implementation status; [OpenAPI](openapi.json) documents endpoint contracts and [API design rules](API_DESIGN_RULES.md) cover common HTTP conventions. [Decisions](decisions.md) records rationale, and the [conceptual reference](data-model-reference.md) explains domain relationships.

## Runtime and structure

Express serves JSON under `/api/v1.0`; production HTTPS terminates at the deployment proxy. `src/app.js` mounts the prefix; `src/index.js` awaits MongoDB before listening, fails startup on connection failure and closes HTTP/MongoDB on SIGINT/SIGTERM. Health checks application and database availability using a MongoDB ping with a two-second driver timeout; disconnected state or ping failure yields unavailable.

`src/features/` groups auth, provinces, districts, grid-substations, installations, readings, district-summary, health and documentation. Keep routes thin; separate validation, authorization, HTTP controllers and business/persistence services. Health separates its database check into a service. Readings owns public reading serialization; auth shares credential validation. `src/routes/api.routes.js` composes JSON features and serves OpenAPI; the app mounts documentation HTML/assets separately for media negotiation, sharing the OpenAPI documentation limiter. Swagger serves the local `swagger-ui-dist` bundle; a custom operation sorter keeps resource groups and read/write order stable ([Swagger configuration](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/)).

Shared middleware owns JWT/ownership verification, rate enforcement and errors; shared services own passwords/JWTs, current principals, ancestry/access and counters. Utilities own timestamps, list responses, HTTP errors, public-path/query rejection and response validators; models/configuration remain shared. Extract helpers when multiple features/setup tools need them. All query-free routes reuse rejectQueryParameters; protected reads keep authentication/read-limit/path checks first, while writes validate access/body/query before write counters. Public health/OpenAPI also reject queries. Exact HTTP errors are documented in [OpenAPI](openapi.json).

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
- Store BSON dates as UTC instants. Public timestamp formatting follows the [OpenAPI contract](openapi.json); local-day calculations use Asia/Colombo.
- Keep MongoDB `_id` internal. Disable Mongoose's `id` virtual derived from `_id`; omit `_id`, `__v`, and credential hashes from JSON.

References are validated public UUID strings, not ObjectId references. Every model has a unique publicId index; parent-plus-publicId indexes support hierarchy lists. Bound regional and time-window queries in MongoDB. Readings have the unique timestamp index, descending `{ installationId: 1, recordedAt: -1, publicId: -1 }` history index, and a global time/publicId index for regional history. Meter ID and normalized email have unique indexes. User jurisdiction is national with no assignment, province with only `provinceId`, or district with only `districtId`; admins require national.

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

Seed dates specify `+05:30`. MongoDB stores those instants as UTC BSON dates, so database tools may display `Z`. For example, 03:00 UTC is 08:30 Sri Lankan time. Public reading JSON uses `+05:30`, as defined in the [OpenAPI contract](openapi.json).

### Rerun guarantees

New records receive random UUID v4 public IDs. Geography is reused by name within its parent; installations are reused by unique meter ID. A conflicting meter parent or ambiguous geography identity causes failure instead of reassignment. Existing IDs, parent references, inactive statuses, credential hashes, and reading values are preserved. The seed never renames or deletes records.

Hierarchy writes use per-district transactions. Readings use one batch of 672 insert-only upserts per installation, keyed by `(installationId, recordedAt)`. Each batch validates measurements and writes a temporary parent lock within the transaction to coordinate with deletion, removing it before commit. Existing samples are skipped; interrupted runs can resume by inserting missing samples. Earlier committed transactions remain if a later batch fails.

The seed is setup tooling and may restore missing fixture history for an inactive installation. Device ingestion must still reject inactive installations.

New development installations use the [README seed credential configuration](../README.md#sample-data); store only salted scrypt deviceCredentialHash values. Validate configuration before writes; no disposable-secret fallback or per-installation override. Reruns preserve hashes/statuses; replacement is explicit setup, never an admin API permission.

`scripts/seed-data.js` generates the geography and profiles; `scripts/seed.js` handles persistence. See the [README](../README.md#sample-data) for commands and credential configuration.

The seed leaves the historical `seed_fixture_archive` untouched.

### User seeding

`scripts/seed-users.js` provisions 36 accounts from the ignored `seed-users.env` file using existing geography. [seed-users.env.example](../seed-users.env.example) lists all required keys without real credentials:

| Accounts | Role | Read scope | Regional reference |
| --- | --- | --- | --- |
| 1 admin | `admin` | `national` | None |
| 1 national analyst | `user` | `national` | None |
| 9 provincial analysts | `user` | `province` | Existing province public UUID only |
| 25 district analysts | `user` | `district` | Existing district public UUID only |

Validate every credential pair and normalized-email uniqueness before account writes. Resolve provinces by exact name and districts by exact name within their expected province; missing/ambiguous geography is an error. Generate random public UUIDs for new users and salted scrypt `passwordHash` values (`scrypt$salt$hash`); store no plaintext passwords and add no `active` field.

Within one transaction, fully validate new User documents, then upsert by email using only `$setOnInsert`. This setup-only raw bulk operation bypasses query validation but receives fully validated documents. Existing users are skipped without changing any stored field. Verify all configured users before commit: validate their schema/parent references, compare newly inserted fields with the prepared values, and compare complete existing documents with their pre-run snapshots. Verification failure rolls back account inserts. Preserve valid existing roles/jurisdictions even when they differ from the seed plan and report only aggregate differences.

User seeding neither creates geography nor modifies installation/history data or unrelated users. The dataset seed remains separate. See the [README](../README.md#user-accounts) for credential-file keys, commands, and safe verification output. No user-management HTTP route is introduced.

## Resource surface

Prefix every path below with `/api/v1.0`. Each row is one path. “User” means an authenticated SLSEA principal with read access to that jurisdiction, including admins with national analyst access to every User GET below. “Admin” means role `admin`, which additionally grants installation creation, status updates to active or inactive, and hard deletion of installations without readings.

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
| `/installations/{installationId}` | GET, PATCH, DELETE | User; details. Admin; set status to active or inactive, or hard-delete only if no readings exist |
| `/installations/{installationId}/overview` | GET | User; details, geography, latest reading |
| `/installations/{installationId}/last-reading` | GET | User; latest reading |
| `/installations/{installationId}/readings` | GET, POST | User; history. Bound device; new reading |
| `/installations/{installationId}/readings/{readingId}` | GET | User; individual reading |
| `/readings` | GET | User; regional history |
| `/districts/{districtId}/generation-summary` | GET | User; district summary |

### Authentication and documentation

| Path | Method | Access |
| --- | --- | --- |
| `/health` | GET | Public application/database health; MongoDB ping; HTTP behavior in the [health contract](openapi.json) |
| `/auth/device-tokens` | POST | Meter credential exchange |
| `/auth/user-tokens` | POST | User or admin credential exchange |
| `/openapi.json` | GET | Public OpenAPI specification |
| `/docs` | GET | Public Swagger UI |

## Security

Keep signing keys/credentials in environment configuration. User and installation tokens share configured HS256 signature, issuer/audience, expiry and bounded integer iat/exp checks with a public UUID subject. Reject wrong actors before principal lookup; database failures fail closed. Authorization uses current stored principals, never stale token privileges.

### User-token implementation

Look up normalized email with explicit passwordHash selection; verify salted scrypt using timing-safe comparison and dummy derivation for absent users/invalid hashes. Select claims from stored fields: sub=public UUID, actor=user, role, readScope and only the applicable provinceId/districtId. Admins are national without assignment and carry the three derived installation permissions. Include configured iss/aud and iat/exp; inputs cannot supply claims. Login changes no User fields. [README](../README.md#getting-started) owns configuration; [OpenAPI](openapi.json) documents exchanges.

### Device-token implementation

Look up the exact submitted meter ID, explicitly select deviceCredentialHash and use the shared scrypt/dummy verification helper. Verify credentials before status. Never reconstruct secrets from the seed prefix or change installation credentials. Active devices receive sub=installation UUID, actor=installation and scope=installation-write plus iss/aud/iat/exp, using the same signer/configuration.

### Verified installations and ownership

verifyInstallationJwt requires actor=installation and exactly scope=installation-write; reload publicId/status by sub and reject absent, invalid or inactive installations. Attach only frozen `{ id: installation.publicId }` as req.installation. requireInstallationOwnership follows verification and matches the URL installationId exactly. User/admin context cannot substitute; token claims cannot override status or binding.

### Verified users

verifyUserJwt requires actor=user, reloads the current User without credentials and validates role/scope/assignment. Attach only stored identity/access and derive admin permissions again; province-list persistence is described below.

## Read behavior

Use credential-free projections and explicit public serializers. Resolve complete ancestry and apply current stored jurisdiction in database filters before any results, counts, pagination, composites, summaries or validator input. Broken implicit ancestry fails closed; explicit resource/filter errors follow the [OpenAPI contract](openapi.json). Preserve inactive installations and history in analyst reads.

Geography reads, installation detail/overview/collections, reading collections and summaries use one read-only snapshot for ancestry and dependent queries. Individual/latest reading lookups authorize ancestry first, then query the immutable reading without a snapshot. Query bounded time windows with deterministic public-ID tie-breakers; do not load unrestricted regional readings, even for national users. Query, ordering, response envelope and cache behavior are documented in [OpenAPI](openapi.json).

### Province list

Province queries are unrestricted nationally, constrained to the assigned province provincially, or resolve the assigned district's parent province for district users. Resolve district ancestry and the complete authorized list in one read-only snapshot; missing/broken ancestry has no visible province. Apply public projections and name/publicId order, deriving count from records through listBody. [OpenAPI](openapi.json) documents queries, response fields and scoped validators.

### Province detail access

Use provinceAllows; for district analysts resolve their current district through districtAncestry. Read requested province/current assignment ancestry in one snapshot. Return the model transform narrowed to id/name without child queries.

### Province district collection

Authorize province through provinceAllows/districtAncestry and jurisdictionAllows; query District by requested provinceId plus stored district publicId for district analysts. Project publicId/provinceId/name, serialize districtBody and derive count from the full records. Parent/list share a snapshot; never include siblings in district-user validator input.

### District detail access

districtAncestry resolves District/Province via public projections. Apply jurisdictionAllows in the same snapshot and serialize through the model transform/public allowlist; no child queries. Share this resolver with substation detail/list and summaries.

### District substation collection

Authorize districtAncestry before a GridSubstation query bound to URL districtId. Project publicId/districtId/name, serialize substationBody and derive count from the full list in the same snapshot; no skip/limit or child queries.

### Grid substation detail access

Resolve GridSubstation → District → Province in one snapshot and apply jurisdictionAllows. Project public fields and serialize substationBody; no installation/history query. Complete ancestry is required even for national readers.

### Individual reading access

authorizedInstallation resolves installation/substation/district/province with public projections and compares stored jurisdiction before reading queries. Status does not restrict analyst reads. Query GenerationReading by both publicId=readingId and installationId. readingBody deterministically serializes public fields independent of BSON field order; its derived display timestamps are not stored/model fields. Construct validators only after access and identity checks.

### Latest reading access

After authorizedInstallation, use findOne by installation UUID ordered recordedAt/publicId descending on the history index. Reuse readingBody/individual-reading validators; no count or full-history load. Delivery order does not determine latest.

### Installation list

Regional geography resolution returns eligible substation UUIDs; bind both SolarInstallation count/page to `{substationId: {$in: authorizedSubstationIds}}` plus optional validated status, including nationally. Omitted status includes active/inactive records; the top-level list alone accepts this query. Preserve status in paging links and scoped ETag context. Resolve geography/count/page in one snapshot and project only publicId/substationId/meterId/status through installationBody. No reading queries. listBody supplies prefix-aware filter-preserving links.

### Substation installation collection

Reuse listInstallations with an authorized URL substation parent and no pagination query. Bind full results to eligible substation UUIDs in the same snapshot and derive count from those records; no separate count query or skip/limit. Reuse installationBody/listBody without paging links; include parent UUID in validators even for equal empty bodies.

### Installation details

Reuse authorizedInstallation and a snapshot; query no readings. installationBody selects id/substationId/meterId/status in that order after the model transform. installationETag hashes JSON.stringify of these canonical fields with SHA-256 into a quoted strong hexadecimal tag shared by GET/POST/PATCH and write preconditions. Exclude principal, geography names, history, credentials, internal IDs, versions and locks.

### Installation overview

Reuse authorizedInstallation once, public model transforms/allowlists and readingBody. Resolve ancestry/current installation and latest recordedAt/publicId reading in one snapshot without domain writes. Compose installation, geography and nullable latestReading; [OpenAPI](openapi.json) documents its public shape and caching.

### Installation reading history

listReadings authorizes installation ancestry, then queries count and sorted/offset/limited results with one installation/time filter in the same snapshot. Concurrent ingestion cannot mix datasets between count/page. The descending installation/time/public-ID index supports newest-first and reverse traversal. Reuse readingBody/listBody; construct validators after authorization.

### Regional reading history

In one snapshot, resolve explicit filters/ancestors and current jurisdiction before comparing filter relationships. Resolve eligible province/district/substation/installation UUIDs with restricted credential-free queries, then bind reading count/page to those IDs and the time window. Missing implicit ancestry yields an empty scope. Share history query validation/serialization/pagination; province listing accepts no filters.

### District generation summary

Reuse districtAncestry/jurisdictionAllows, then bind substations to districtId, installations to those substation UUIDs and readings to those installation UUIDs in one snapshot. Capture asOf once outside retries. Aggregate latest eligible readings by installationId, recordedAt/publicId descending, excluding future measurements; query daily counters in installationId/recordedAt/publicId order from Asia/Colombo midnight through asOf. Use displayTimestamp only for output; retain millisecond precision internally. [OpenAPI](openapi.json) documents freshness, energy/reset/completeness calculations and the seven-field response.

## Admin installation management

Derive `installation-create`, `installation-status-update` and `installation-delete` from the current stored admin role. Admins also have national analyst reads under the same read rules/limits. No user/geography management, reading-write, credential-rotation, general edit or PUT permissions. Initial accounts use controlled [user seeding](#user-seeding).

- **Creation:** Reuse current-user/admin verification, validated models, salted scrypt hashPassword, installationBody/installationETag and the unique meter index. Resolve GridSubstation by public UUID before insert; the model checks its parent too. Generate UUID/status, trim meterId, preserve supplied secret characters and never read the development seed prefix. Unique-index collisions handle concurrent duplicates and reserve inactive meters. Never return/log credentials.
- **PATCH:** In a snapshot/majority transaction, installationForWrite resolves credential-free public fields and evaluates the [optional precondition](openapi.json). Set only status and a fresh temporary `_ingestionLock` UUID, then unset the lock before commit. Force a real parent write even for no-op status updates; conflicts retry lookup/comparison. Return the committed public representation. Preserve credentials, identity, ancestry and history. Inactive remains blocked until explicit reactivation; unchanged credentials/unexpired tokens resume only until their original expiry.
- **DELETE:** In each snapshot/majority attempt, resolve existence/precondition, write the same temporary parent lock, then query GenerationReading.exists by installation UUID. Abort on any history; otherwise delete that parent in the same session. Never mutate readings, geography or users. Deletion releases meter uniqueness; replacements get new UUIDs inaccessible to old tokens. HTTP validation rejects framed bodies even when express.json does not parse their media type.

Both lifecycle transactions serialize with ingestion/seed writes to the same parent. Ingestion committing first makes DELETE find history; deletion committing first prevents reading commit. Snapshot-only guards or separate check/delete operations are insufficient. Retries must re-evaluate existence, preconditions, status/history; never reuse a successful stale comparison. Failures roll back lock/domain changes. Internal locks cannot affect unchanged public ETags. Admin rate limits and response ordering are documented in [OpenAPI](openapi.json).

## Reading ingestion

Initialize declared indexes, then use mongoose.connection.transaction with snapshot reads/majority writes. In each retry, conditionally update the authenticated public UUID with status=active, setting a fresh `_ingestionLock` UUID to force a parent write. If it no longer matches, reload and reject absent/inactive/invalid state. Save a validated new GenerationReading with server-generated UUID, authenticated installation reference and server receipt time in that session; unset the lock before commit. Duplicate timestamps/failures roll back all writes. The lock is private and excluded from validators. Coordinate lifecycle/seed writes through that same parent as described [above](#admin-installation-management).

## Rate limits

Counters live in operational `token_rate_limits`, outside the six domain models. Unique hashed keys identify IP/email/meter/principal; atomic update pipelines reset expired windows or increment counts, with TTL cleanup. Retry first-upsert collisions against the winning key. Separate user/device login and read/device/admin-write namespaces; share counters across instances and fail closed on database errors.

| Traffic | Initial limit | Key | Status |
| --- | --- | --- | --- |
| Token issuance | 5 / 15 min | IP and normalized email or exact meter ID | Implemented |
| Device ingestion | 30 / min | Installation and IP | Implemented |
| User/admin reads | 120 / min | User | Implemented |
| Admin installation writes | 30 / min | Admin; shared POST/PATCH/DELETE | Implemented |
| Public docs | 60 / min | IP; shared specification, Swagger page and assets | Implemented |

[OpenAPI](openapi.json) documents consumption timing and responses.
