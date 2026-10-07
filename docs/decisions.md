# Design Decisions

## D01 — Hierarchy and public IDs

- **Choice:** Store the hierarchy through parent references; User is separate. Use UUID v4 `publicId` values externally and keep MongoDB `_id` internal.
- **Reason:** One authoritative parent relationship determines geography. Fixed public IDs make seed runs repeatable.

## D02 — Meter identity and history

- **Choice:** Store `meterId` and a hashed secret on the installation. Readings keep measurement and receipt times and are append-only, with unique `(installationId, recordedAt)`.
- **Reason:** The history supports time queries and the latest-reading view without duplicating measurements on the installation.

## D03 — Client access

- **Choice:** Device tokens have `installation-write` for one active installation. Role `user` tokens carry a read scope and assigned jurisdiction. Role `admin` tokens carry national analyst reads plus installation creation, status updates to inactive, and conditional hard-deletion permissions; see D07. User has no `active` attribute.
- **Reason:** Checking principal state and resource ancestry on every read, count, and aggregate prevents cross-jurisdiction disclosure.

## D04 — Derived resources

- **Choice:** Expose `last-reading`, installation `overview`, and `summarize-district-generation` as derived views.
- **Reason:** Operational power and local-day energy come from readings. Exclude stale sites from current power and report incomplete energy baselines and counter resets.

## D05 — URI and HTTP contract

- **Choice:** Use `/api/v1.0` as the common base path, JSON, 201 with `Location` for new readings, bounded paging, one error shape, and stable `ETag` values. Matching conditional GETs return bodyless 304.
- **Reason:** A versioned path follows the design guideline and allows later versions to coexist. Send `Last-Modified` only when a reliable change time exists.

## D06 — Limits and seed

- **Choice:** Use shared rate counters, returning 429 with `Retry-After`. Seed the geography, installations, and at least seven days of per-site readings.
- **Parameters:** Token issuance 5/15 min; ingestion 30/min; user/admin reads 120/min; admin installation writes 30/min; docs 60/min; global IP 300/min. Seed 9 provinces, 25 districts, 20+ substations, and 200+ installations.

## D07 — Admin role and installation lifecycle

- **Choice:** User has `role=user|admin`, no `active`. Admins use the existing user token endpoint with national analyst reads (`readScope=national`, no regional assignment) plus exactly `installation-create`, `installation-deactivate`, and `installation-delete`; deletion requires no readings. Reads cover all geography, installations, readings, derived views, summaries, and retained inactive history, using the same filters, counts, paging, private validators, and 120/min user read limit. No user-management routes or broader write privileges.
- **Surface:** Under `/api/v1.0`, admin-only POST `/installations` creates an active installation with existing substation/unique meter. PATCH `/installations/{installationId}` accepts exactly `{ "status": "inactive" }`: idempotent status update, not deletion, returning 200. DELETE on that path removes empty active/inactive installations: bodyless 204, 409 `INSTALLATION_HAS_READINGS` if readings exist, 404 if absent. No general edits, reactivation, or PUT.
- **Conditional writes:** Optional If-Match on PATCH/DELETE uses the current strong installation-detail ETag, compared atomically with the mutation; mismatch returns standard JSON 412 `PRECONDITION_FAILED` without change, including no-op PATCH. Absence preserves existing behavior. Tag lists, wildcard, syntax, and authorization/missing-resource ordering follow `API_DESIGN_RULES.md`. For existing DELETE targets, precondition precedes the readings guard: mismatch 412, match with readings 409, empty success bodyless 204. PATCH returns the committed representation's strong ETag, unchanged for no-op.
- **Retention and reason:** Admins manage onboarding, status, and removal without history. Status updates preserve installations, meter IDs, geographic attribution, and readings; the delete guard protects every reading. Inactive sites immediately lose token issuance/ingestion, including existing tokens; authorized users retain history. Exclude inactive sites from current power and fresh/stale counts, but include their readings in local-day energy.
- **Setup:** Controlled admin provisioning; no public route/committed password. Seed reruns preserve deactivation/credentials. Derive permissions from the current stored principal so JWTs cannot retain privileges after role changes.
- **Deletion integrity:** Serialize deletion/ingestion through a shared installation write in database transactions or equivalent; snapshot checks alone are insufficient. First ingestion blocks deletion; first deletion blocks ingestion. Never delete/orphan readings. Success removes credentials and releases meter ID; replacements get new public UUIDs, and old tokens fail current-principal verification.
- **ETag integrity and reason:** Use deterministic public-detail serialization for strong GET/PATCH tags; internal concurrency bookkeeping must not alter unchanged representation tags. Use a shared transactional write or compare-and-swap, re-evaluating on conflicts, to prevent stale preconditions passing. Combine DELETE comparison and readings guard with ingestion coordination. Optional preconditions prevent stale edits while retaining existing unconditional clients.
- **Handoff:** Design only; implement validation, role authorization, status checks, persistence, OpenAPI, and verification together. Verify admin national reads across all read routes, user jurisdiction boundaries, scoped counts/paging/validators, admin-only writes, extra-field rejection, duplicate meters, 201 Location, repeat status updates, inactive-device rejection, scoped retained history, empty active/inactive deletion, readings-conflict 409 without mutation, repeat-delete 404, stale device tokens, concurrent ingestion/deletion, summary/cache changes, and shared 429.
- **Conditional verification:** During implementation, check optional strong matching, atomic 412 without mutation, PATCH ETags, and DELETE's 412/409 ordering under concurrent writes/ingestion. OpenAPI and tests are deferred to development.

## D08 — Environment configuration and health

- **Choice:** Load `.env` centrally with Node.js's built-in environment loader. Export the validated `API_BASE_URL` path (default `/api/v1.0`) and `PORT`; process environment takes precedence. Mount relative Express feature routes under the imported prefix.
- **Health:** Public GET `/health` returns 200 `{ "status": "ok" }` for application liveness only, with a stable strong ETag and `Cache-Control: no-cache`. Matching `If-None-Match` returns bodyless 304; Accept excluding JSON returns bodyless 406. Database readiness is deferred until persistence is connected.
- **Structure:** Separate configuration, application setup, listener startup, routes, controllers, and shared middleware. Add services and models when the feature needs business logic or persistence.

## Pending decisions

| Topic | Decision needed |
| --- | --- |
| Response-header instruction | Clarify whether “curl response headers” means curl evidence, CORS headers, or both. |
| Implementation parameters | Set meter clock-drift and measurement bounds, counter-reset behavior, deployment provider, and final rate thresholds. |

Keep the implementation, OpenAPI, `architecture.md`, and these decisions aligned.
