# Architecture — Solar Generation API

This document defines the target stored data, resource surface, authorization, and persistence design. The [README](../README.md#current-implementation) tracks implementation status; [API_DESIGN_RULES.md](API_DESIGN_RULES.md) owns the HTTP contract and [decisions.md](decisions.md) records rationale. The [conceptual reference](data-model-reference.md) explains domain relationships.

## Runtime and structure

The target Express JSON API uses `/api/v1.0`, with HTTPS terminating at the deployment proxy. Protected requests will pass through JWT verification, authorization, validation, services, and Mongoose before reaching MongoDB Atlas. Public documentation uses the same base path.

`src/features` groups auth, readings, provinces, districts, grid-substations, and health by feature. Each feature owns its routes, HTTP controllers, request validation, and applicable business/persistence services. The readings feature also owns its deterministic public serializer. Keep routes thin and validation, HTTP responses, authorization, and persistence as separate responsibilities within the feature. The static health response lives directly in its route because it has no validation, authorization, or business logic. User/device credential validators share one module; shared read/write limit middleware shares one module while keeping each traffic policy separate.

`src/routes/api.routes.js` composes feature routers and serves OpenAPI. `src/middleware` owns shared JWT verification, installation ownership, rate-limit enforcement, and error handling; `src/services` owns shared password/JWT helpers, current-user principal construction, and operational rate counters. `src/utils` owns shared timestamp parsing and HTTP errors; models and configuration remain shared in `src/models` and `src/config`. Feature-specific code should live with its feature; extract helpers when multiple features or setup tools need them.

`src/app.js` mounts the configured API prefix; `src/index.js` owns startup/shutdown. Startup awaits MongoDB before listening, initial failure prevents startup, and SIGINT/SIGTERM close both connections. Health remains a liveness check without a database query.

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

New development installations derive their password from `DEVICE_HASH_COMMON_PREFIX` plus the exact meter ID. Store only its salted scrypt hash in `deviceCredentialHash`; no random disposable-secret fallback or per-installation override is used. Prefix configuration is required before dataset seed writes. This is a development convenience, not the production provisioning scheme: real devices require independent credentials. Normal reruns preserve existing hashes and statuses; credential replacement is an explicit setup operation, never an automatic rerun or an admin API permission.

`scripts/seed-data.js` generates the geography and profiles; `scripts/seed.js` handles persistence. See the [README](../README.md#sample-data) for commands and credential configuration.

The former two-installation demo is preserved separately in `seed_fixture_archive`, including copies of the shared Western/Colombo parents reused in the live hierarchy. The current seed leaves the archive untouched. Migration history belongs to the [prompt log](prompt-log.md).

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
- `last-reading` selects the latest measurement by recordedAt, not receivedAt. `overview` composes the installation, its geography, and latest reading; latest-reading alone returns 404 for empty history, while overview returns latestReading=null.
- `summarize-district-generation?districtId=...` reports `asOf`, fresh/stale installation counts, current power, today's energy, and incomplete-energy count. Use Asia/Colombo day boundaries and a 30-minute freshness threshold. Calculate energy from counter changes with reset/baseline handling, not the sum of cumulative counters.
- Keep inactive installations and their history visible to users within jurisdiction, including lists, counts, overview, and latest-reading views. District summaries exclude inactive installations from current power and fresh/stale counts, but include their retained readings in today's energy and incomplete-energy calculation. Recompute affected validators after creation, status updates, or hard deletion.

### District generation summary

The implemented GET /summarize-district-generation uses only the required districtId query. Reuse districtAncestry and jurisdictionAllows before querying GridSubstation, SolarInstallation or GenerationReading. Scope substations by districtId, installations by those public substation IDs, and readings by those installation IDs. Use one read-only snapshot for ancestry, installation status and measurements; capture current time once outside retries.

Aggregate latest eligible measurements by installationId with recordedAt descending and publicId descending (receivedAt never determines latest); exclude recordedAt after asOf. Query daily counters within the Asia/Colombo midnight-to-asOf range in deterministic installationId/recordedAt/publicId order. Freshness is 30 minutes inclusive. Sum current power only for fresh active installations; inactive history remains in observed daily energy and incomplete counts.

asOf is readable Asia/Colombo text (`08 Oct 2026, 12:00 PM (Sri Lanka)`); use the shared displayTimestamp formatter while retaining full captured precision for calculations. Public response fields are districtId, asOf, freshInstallationCount, staleInstallationCount, currentPowerKw, todayEnergyKwh and incompleteEnergyInstallationCount. todayEnergyKwh is observed daily energy that may be incomplete: no interpolation, estimates or pre-midnight baseline. Sum nonnegative consecutive daily counter changes, skipping decreases and resuming from each lower counter. Missing midnight baseline, fewer than two daily samples or any decrease marks an installation incomplete once. No installations yields zeros; no readings yields zero energy and an incomplete installation. See [approved rationale](decisions.md#d31---observed-district-generation-summary-approved-2026-10-08) and [HTTP contract](API_DESIGN_RULES.md#district-generation-summary) for exact counting/caching. The district-summary feature owns this endpoint; no domain writes or admin routes are added.

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

### User-token implementation

The implemented user-token exchange reads the normalized email from MongoDB with explicit access to `passwordHash`, verifies the seed's salted scrypt format using a timing-safe comparison, and performs a dummy derivation for absent users or invalid stored hashes. Input validation, HTTP responses, authentication service, and shared counters remain separate from the route.

HS256 tokens use `sub` for the User public UUID, `actor=user`, `role`, `readScope`, and only the applicable `provinceId` or `districtId`. Admin tokens also include `permissions=[installation-create, installation-deactivate, installation-delete]`. Claims are selected from stored fields; request bodies cannot supply identity or authorization. Include configured `iss`/`aud` and standard `iat`/`exp`. Signing key, issuer, audience, and expiry are configured as described in the [README](../README.md#getting-started). The verified-user middleware and protected province list below apply the current-principal security checks; future protected routes must use the same checks rather than trust claims alone.

Login and user-read counters live in the operational `token_rate_limits` collection, outside the six public domain models. Hashed IP/email/meter keys use unique `_id` values; atomic update pipelines reset expired windows or increment the current count, and a TTL index eventually removes expired counters. Retry a concurrent initial-upsert collision against the winning key. Database failures fail closed with the standard error. Token issuance consumes no User writes and does not change credentials or assignments.

### Device-token implementation

`POST /auth/device-tokens` looks up SolarInstallation by the exact submitted meter ID, explicitly selects the internal `deviceCredentialHash`, and uses the shared scrypt verification helper, including dummy derivation for absent installations or invalid hash formats. The endpoint never reads the development prefix, reconstructs secrets, writes installation fields, or changes seeded credentials. Check credentials before status; inactive installations cannot receive tokens.

Active installations receive only `sub` (installation public UUID), `actor=installation`, and `scope=installation-write`, plus standard `iss`, `aud`, `iat`, and `exp`. User and device issuance share the signing utility and existing HS256 environment configuration. Device issuance uses the same operational counter collection and atomic expiry rules, with separate hashed device-IP and meter-ID keys. HTTP errors and limits belong to the [device exchange contract](API_DESIGN_RULES.md#device-token-exchange).

The existing user JWT middleware rejects installation actors before User lookup; these tokens cannot read `/provinces`. Installation verification and ownership middleware protect reading submission below.

### Verified installations and ownership

`verifyInstallationJwt` uses the shared bearer verifier for configured HS256 signature, issuer, audience, expiry, a public UUID subject, and bounded integer `iat`/`exp`. Require `actor=installation` and exactly `scope=installation-write` before querying MongoDB. Look up SolarInstallation by `publicId=sub`, explicitly selecting only `publicId` and `status`; reject absent/invalid stored installations and current inactive status. Never trust token claims for installation status, meter binding, or user privileges. Database failures propagate through the sanitized error handler.

Attach only a frozen `{ id: installation.publicId }` as `req.installation`. `requireInstallationOwnership` must follow verification and requires `req.params.installationId` to match this authenticated public UUID exactly; user/admin context cannot substitute for installation authentication. Both actor types reuse cryptographic checks while retaining separate current-principal lookup and authorization behavior. See the [HTTP contract](API_DESIGN_RULES.md#installation-jwt-verification-and-ownership) for 401/403 conventions.

Installation verification and ownership precede the persistence-time safeguards below.

### Reading ingestion

The reading service initializes declared indexes, then uses `mongoose.connection.transaction` with snapshot reads and majority writes. Inside each retry, a conditional Mongoose installation update matches the authenticated public UUID and `status=active`, setting a fresh temporary `_ingestionLock` UUID to guarantee a real parent write. If no active parent matches, reload within the session and reject inactive, absent, or invalid installation state using the HTTP contract. Save a new validated GenerationReading with server-generated public UUID, authenticated installation reference, and server receipt time in that same session. Unset the temporary lock before commit. It is internal, excluded from public JSON/projections, and never changes public installation validators. Failed saves/duplicate timestamps roll back all transaction writes.

Lifecycle transactions must write the same installation document before evaluating the deletion readings guard; deactivation also writes that document. MongoDB conflicts and transaction retries therefore re-evaluate existence/status. Lifecycle committing first prevents a reading commit; ingestion committing first causes guarded deletion to find history and refuse deletion. Snapshot-only checks or separate check/insert/delete operations are insufficient. The seed's existing temporary parent write coordinates through the same document. See the [HTTP contract](API_DESIGN_RULES.md#device-reading-submission) for validation, duplicate and response behavior.

### Verified users and province access

`verifyUserJwt` reads a bearer token, verifies the configured HS256 algorithm/signature/issuer/audience and expiry, requires `actor=user`, a public UUID `sub`, and bounded `iat`/`exp`, then fetches the current User by public UUID without credential fields. Invalid tokens, absent users, and invalid stored assignments fail authentication. Database failures fail closed. Attach only the current stored identity/role/scope and applicable jurisdiction as `req.user`; derive admin permissions again from the stored role and ignore authorization claims in the token.

The first protected route is `GET /provinces`. National users/admins have an unrestricted province query; provincial users are constrained to their stored province UUID; district users resolve their assigned district's parent province. Filter district/substation lookups within that same jurisdiction, including preventing access to sibling districts for district users. Query provinces and counts with the resolved public-UUID filter before paging; compose public fields and scoped validators only afterward. Missing geography produces no visible province. The shared user read limit uses the User public UUID, with identical limits for admins and analysts. See the [HTTP rules](API_DESIGN_RULES.md#protected-province-list) for list, query, cache, and rejection behavior.

### Province detail access

`GET /provinces/{provinceId}` resolves the requested Province by public UUID and uses the shared provinceAllows helper. National/admin users read any province; provincial users only their stored province; district users resolve their current assigned district through districtAncestry and may read its parent province only. Broken assignment ancestry fails closed. Province resolution and authorization use one read-only snapshot. Return the existing model's public serialization narrowed to id/name; query no related collections. Missing requested province returns 404; existing provinces outside jurisdiction return 403. No query options. See [HTTP behavior](API_DESIGN_RULES.md#province-details) for conditional GET and caching.

### Province district collection

`GET /provinces/{provinceId}/districts` first resolves the requested Province by public UUID. For district analysts, reuse provinceAllows/districtAncestry to resolve the current stored assigned district and its parent province; deny other provinces or broken assignment ancestry before list queries. Apply the shared jurisdictionAllows comparison for national/provincial/district scope, then query District with provinceId and, for district scope, publicId equal to the assigned district. Province authorization and the complete filtered list use one read-only snapshot.

Project publicId/provinceId/name, order by name/publicId ascending and serialize through the same districtBody allowlist as detail reads. Reuse listBody without pagination for count/items only; count is records.length. No child geography, installations or readings are composed, and no domain writes occur. The districts feature owns the route/service/controller and existing authentication/HTTP helpers. See the [HTTP contract](API_DESIGN_RULES.md#province-districts) for no-query behavior, errors, private scoped ETags and omission of Last-Modified.

### District detail access

`GET /districts/{districtId}` reuses the shared districtAncestry service (also used by substation detail and district substation lists) to resolve District and Province through explicit public projections. Within one read-only snapshot, require complete ancestry and apply jurisdictionAllows: national access unrestricted, provincial access matches provinceId, district access matches the URL districtId. Reject forbidden access before model JSON serialization or validators; missing ancestry fails closed.

Return exactly `{ "id": "<UUID>", "provinceId": "<UUID>", "name": "<district name>" }` through the model public transform and explicit allowlist. No substation/installation/reading queries or domain writes occur. The districts feature owns route/validation/controller/service; the shared ancestry helper lives under src/services. See the [HTTP contract](API_DESIGN_RULES.md#district-details) for errors, private scoped ETags and omission of Last-Modified.

### District substation collection

`GET /districts/{districtId}/grid-substations` resolves the URL District and its Province, then applies jurisdictionAllows before querying GridSubstation. Reuse districtAncestry for complete-parent checks shared with substation detail. In a read-only snapshot, authorize the parent and bind the complete list query to `{ districtId: <URL public UUID> }`. Never query an unscoped substation collection. Project publicId/districtId/name, order by name/publicId ascending and return all records without skip/limit.

The shared substationBody allowlist/model transform returns only id/districtId/name for both detail and list items. Reuse listBody for the unpaginated count/items response: count is records.length, with no next/previous fields. No installation/reading queries or domain writes occur. Empty districts are valid collections; missing ancestry fails closed. The [HTTP contract](API_DESIGN_RULES.md#district-grid-substations) owns errors, the complete collection, scoped full-response ETags and omission of Last-Modified. No query options are accepted.

### Grid substation detail access

`GET /grid-substations/{substationId}` resolves GridSubstation to District to Province by public UUID in a read-only snapshot, using explicit credential-free projections. Validate complete ancestry before applying the shared jurisdictionAllows comparison also used by installation read authorization. National analysts/admins have no regional constraint; provincial scope matches the parent district province and district scope matches the substation district. Missing ancestry fails closed; deny out-of-jurisdiction resources before serialization or validators.

The public representation is exactly `{ "id": "<UUID>", "districtId": "<UUID>", "name": "<substation name>" }`, selected deterministically after the model JSON transform. No installation/reading queries or domain writes occur. The substation feature owns its route, validation, controller and service. The [HTTP contract](API_DESIGN_RULES.md#grid-substation-details) owns responses, private scoped ETags and omission of Last-Modified.

### Individual reading access

The shared `authorizedInstallation` helper resolves the URL installation to its substation, district, and province using public UUID references and credential-free projections. After confirming complete ancestry, provincial scope compares the district's province against the stored User province UUID; district scope compares the substation's district against the stored User district UUID. Out-of-jurisdiction installations are rejected before reading lookup using the HTTP contract. National analysts/admins have no regional constraint. Every ancestor must exist; invalid/missing ancestry fails closed. Installation status does not restrict historical reads.

Only after ancestry authorization, query GenerationReading with both `{ publicId: readingId, installationId }`. Project only reading public fields and serialize through the same deterministic public representation as insertion, independent of BSON field order. The reading serializer derives recordedAtDisplay/receivedAtDisplay in Asia/Colombo for all reading responses; these fields are not stored or added to the model. ISO timestamps remain unchanged. Generate response validators only after access and resource identity are established. The [HTTP contract](API_DESIGN_RULES.md#individual-reading) owns errors, caching, and conditional-request behavior.

### Latest reading access

`GET /installations/{installationId}/last-reading` reuses authorizedInstallation before querying GenerationReading by the installation public UUID. Use descending recordedAt/publicId with findOne and the existing installation history index. No installation status filter or domain writes occur. Missing installation/ancestry or empty history returns no reading; forbidden ancestry is rejected before querying readings. Serialize through readingBody and share individual-reading response/conditional handling after authorization. The [latest-reading HTTP contract](API_DESIGN_RULES.md#latest-reading) owns statuses, caching and receipt-based Last-Modified.

### Installation list

`GET /installations` reuses the regional geography resolver to obtain authorized substation public IDs after resolving explicit filters, their ancestry and stored user scope. Apply `{ substationId: { $in: authorizedSubstationIds } }` to both SolarInstallation count and paged result queries; no unrestricted installation query occurs, even nationally. Include inactive installations and exclude broken implicit ancestry. Explicit missing or forbidden geography uses the shared filter errors.

Resolve geography, count and page in one read-only snapshot. Project only publicId/substationId/meterId/status, sort by publicId ascending, then offset/limit; serialize through installationBody. Reading history is not queried. The shared listBody utility supplies the standard count/next/previous/items envelope and prefix-aware filter-preserving links, also used by reading lists. Query parameters and collection validators belong to the [HTTP contract](API_DESIGN_RULES.md#installation-list). No installation writes are implemented.

### Installation details

`GET /installations/{installationId}` returns exactly `{ "id": "<UUID>", "substationId": "<UUID>", "meterId": "<meter identifier>", "status": "active" }`; status may also be inactive. Reuse authorizedInstallation and the read-only snapshot pattern to resolve complete ancestry and current installation metadata coherently. No reading query or domain write occurs. Missing installation/ancestry fails closed; jurisdiction rejection precedes public serialization and validators.

The shared installationBody serializer (also used in overview) selects public fields in id/substationId/meterId/status order after the model JSON transform. installationETag hashes JSON.stringify of those canonical fields using SHA-256 and returns a quoted strong hexadecimal tag. It excludes principal identity, geography names, readings, credentials, internal IDs, version and lock metadata. Future admin PATCH/DELETE preconditions must reuse these helpers with the atomic mutation guarantees above; writes remain unimplemented. No reliable metadata modification timestamp is stored. See the [HTTP contract](API_DESIGN_RULES.md#installation-details).

### Installation overview

`GET /installations/{installationId}/overview` returns this minimal composite (public UUIDs only):

```json
{
  "installation": { "id": "<UUID>", "substationId": "<UUID>", "meterId": "<meter identifier>", "status": "active" },
  "geography": {
    "province": { "id": "<UUID>", "name": "<province name>" },
    "district": { "id": "<UUID>", "provinceId": "<UUID>", "name": "<district name>" },
    "gridSubstation": { "id": "<UUID>", "districtId": "<UUID>", "name": "<substation name>" }
  },
  "latestReading": null
}
```

latestReading is either the existing public reading representation (including ISO/display timestamps) or null; no full history, counts or pagination are included. Status may be active or inactive. The shared authorizedInstallation resolver returns credential-free installation/ancestry documents after checking current jurisdiction. Reuse their model JSON transforms and explicit public field allowlists for deterministic composite serialization; reuse readingBody for the latest reading. Resolve ancestry and select the latest recordedAt/publicId in one read-only snapshot transaction, without domain writes or a second ancestry lookup. Missing installation or broken ancestry fails closed. The [HTTP contract](API_DESIGN_RULES.md#installation-overview) owns errors, scoped full-response ETags and omission of Last-Modified.

### Installation reading history

The collection and individual GETs reuse installation ancestry authorization and deterministic public reading serialization. `listReadings` uses a read-only snapshot transaction: authorize ancestry, then query the installation/time filter for count and the sorted/offset/limited page in the same session. An ingestion committing between queries cannot make count and page disagree. No model/domain writes occur. The existing descending installation/time/public-ID index supports newest-first traversal and its reverse.

Counts and validators are constructed only after authorization. The whole envelope plus current principal, installation identity and effective query forms the scoped ETag input, following the protected province-list convention. No reliable collection modification time is persisted. See the [HTTP contract](API_DESIGN_RULES.md#installation-reading-history) for query rules, pagination, errors and caching.

### Regional reading history

`GET /readings` shares query validation, pagination, serialization and response validators with installation history. Within the same read-only snapshot, resolve each explicit geography filter and its ancestors, enforce current stored jurisdiction, then reject contradictory authorized filter relationships. Resolve eligible provinces, districts, substations and installation public IDs with credential-free projections and database restrictions. Bind both reading count and page to those installation IDs and the time window; no unscoped reading query is used, including for national reads. Retain inactive installations. Missing implicit ancestry produces an empty eligible area; explicit missing ancestry uses the HTTP error contract.

The regional resolver is separate from the province-list service because explicit inaccessible/missing geography filters have different response policies. See the [regional HTTP contract](API_DESIGN_RULES.md#regional-reading-history) for parameters, precedence, paging and caching.

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
