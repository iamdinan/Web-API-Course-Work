# API Design Rules

This file defines the HTTP contract using the applicable WSO2 REST design rules. [architecture.md](architecture.md) owns concrete paths, access assignments, and persistence guarantees. The [README](../README.md#current-implementation) distinguishes implemented features from planned behavior; [OpenAPI](openapi.json) describes implemented routes only.

## Responses

Public reading timestamps use ISO 8601 Sri Lankan time (Asia/Colombo, `+05:30`), preserving the stored instant. Expose public UUIDs as `id`; never expose MongoDB internal IDs or credential hashes. ID generation and storage rules belong to the architecture.

| Status | When | Body and key headers |
| --- | --- | --- |
| 200 OK | Successful GET, token exchange, or installation deactivation | JSON; `Content-Type: application/json`. GET may include `ETag` and a reliable `Last-Modified`. Installation GET and PATCH return the strong ETag of the public installation representation; PATCH returns its resulting public fields. |
| 201 Created | Device creates a reading or admin creates an installation | Created resource as JSON; `Location` points to its GET; `ETag`. For readings, `Last-Modified` comes from `receivedAt`; the installation GET requires a jurisdiction-authorized user. |
| 204 No Content | Admin hard-deletes an installation with no readings | No body; no JSON Content-Type or deleted-resource validators. |
| 304 Not Modified | Conditional GET matches current representation | **No body**; preserve relevant cache validators. |
| 400 Bad Request | Invalid body, ID, filter, or time range | JSON error contract. |
| 401 Unauthorized | Invalid login credentials, or missing/invalid bearer token | JSON error; `WWW-Authenticate: Bearer`. |
| 403 Forbidden | Authenticated client attempts a forbidden action | JSON error. |
| 404 Not Found | Missing atomic resource, reading/installation mismatch, or unknown route | JSON error. Unknown routes use `code=NOT_FOUND`. |
| 406 Not Acceptable | `Accept` excludes JSON | No JSON body when the client does not accept JSON. |
| 409 Conflict | Duplicate reading timestamp, duplicate meter ID, or attempted installation deletion when readings exist | JSON error; deletion uses `code=INSTALLATION_HAS_READINGS`. |
| 412 Precondition Failed | Admin installation PATCH/DELETE has a nonmatching `If-Match` | Standard JSON error with `code=PRECONDITION_FAILED`; no mutation. |
| 413 Content Too Large | JSON body exceeds the current 100 KB parser limit | Standard JSON error with `code=PAYLOAD_TOO_LARGE`. |
| 415 Unsupported Media Type | Write body is not JSON | JSON error. |
| 429 Too Many Requests | Shared rate limit exceeded | JSON error; `Retry-After` in seconds. |
| 500 Internal Server Error | Unexpected server failure | Standard JSON error with `code=INTERNAL_SERVER_ERROR`; no internal diagnostics. |

All JSON errors use `{ "code": "...", "message": "...", "details": [] }`. Never include credentials or stack traces.

### Health and parser behavior

Public health GET returns `{ "status": "ok" }` with a stable strong ETag and `Cache-Control: no-cache`. Matching conditional requests return bodyless 304; Accept excluding JSON returns bodyless 406. Malformed JSON returns 400 `INVALID_JSON`. Oversized JSON uses the 413 response above. Health is application liveness, not a database readiness probe.

## User token exchange

`POST /auth/user-tokens` accepts an `application/json` object containing exactly `email` and `password` strings. Trim/lowercase email; require a valid email and a non-whitespace password, preserving the password's exact characters. Reject missing/unknown fields, arrays, objects in place of strings, and empty values with 400 `INVALID_REQUEST`; malformed JSON uses 400 `INVALID_JSON`. Unsupported Content-Type uses 415 `UNSUPPORTED_MEDIA_TYPE`.

Success returns 200 `{ "access_token": "<signed JWT>", "token_type": "Bearer", "expires_in": 900, "userId": "<public UUID>" }`, where the lifetime is configured in seconds. `userId` is the authenticated stored User public UUID and equals the JWT `sub`; it is returned for both users and admins. Return `Cache-Control: no-store` and `Pragma: no-cache` for this POST, including errors; successful token responses have no ETag or Last-Modified. No refresh token is issued.

Unknown users and password mismatches return the same 401 `INVALID_CREDENTIALS` with message `Invalid email or password.` and `WWW-Authenticate: Bearer`. Never include submitted credentials, stored hashes, or internal IDs in errors. Unexpected persistence/signing failures return the standard 500 error.

After request validation and before password verification, apply shared 5-attempt/15-minute IP and normalized-email counters. Exceeded limits return 429 `RATE_LIMIT_EXCEEDED` with integer `Retry-After` seconds. Rejected request shapes do not consume these credential-attempt counters. JSON negotiation and the 100 KB parser limit follow the general rules above.

## Device token exchange

`POST /auth/device-tokens` accepts an `application/json` object containing exactly `meterId` and `deviceSecret` as nonempty, non-whitespace strings. Preserve both values exactly. Missing/unknown fields and invalid types use 400 `INVALID_REQUEST` with message `Provide only a nonempty meterId and deviceSecret.` Parser, media type, negotiation, successful token response, and no-store/Pragma behavior follow the [user-token exchange](#user-token-exchange).

Successful device login returns the same token fields as user login with `installationId` instead of `userId`: the authenticated stored installation public UUID, equal to JWT `sub`. No MongoDB `_id` or credentials are returned.

Unknown meters and secret mismatches return identical 401 `INVALID_CREDENTIALS` errors with message `Invalid meter ID or device secret.` and `WWW-Authenticate: Bearer`. Verify the submitted secret before evaluating status: valid credentials for an inactive installation return 403 `INSTALLATION_INACTIVE` with message `Inactive installations cannot obtain device tokens.` Neither error returns a token. Unexpected persistence/signing failures use the standard sanitized 500.

After validation and before credential lookup, apply shared MongoDB counters of 5 attempts per 15 minutes per IP and exact meter ID, using separate namespaces from user login. Excess attempts use the existing 429 login error and integer `Retry-After`. Invalid request shapes do not consume credential-attempt counters. Installation JWT claims are defined in the [architecture](architecture.md#device-token-implementation).

## Installation JWT verification and ownership

Installation-only middleware reads `Authorization: Bearer <token>` and verifies the configured signature/algorithm, issuer, audience, expiry, public UUID subject, and bounded issued/expiry claims. Missing, malformed, invalid, expired, or wrong-actor tokens return 401 `UNAUTHORIZED` with `WWW-Authenticate: Bearer` and message `A valid installation bearer token is required.` A deleted installation or invalid stored principal also returns this same 401. Wrong-actor tokens use 401 in both user and installation authentication.

A valid installation actor without exactly `scope=installation-write` returns 403 `FORBIDDEN` with message `The token does not permit installation writes.` Current inactive installations return 403 `INSTALLATION_INACTIVE` with message `Inactive installations cannot authenticate for writes.` URL ownership mismatches return 403 `FORBIDDEN` with message `The authenticated installation cannot access this installation.` Ownership checks without authenticated installation context return the installation 401 above. All errors use the standard JSON shape; persistence failures remain sanitized 500s.

These middleware protect reading submission below. Token issuance keeps its existing credential/status responses.

## Device reading submission

`POST /installations/{installationId}/readings` uses installation JWT verification and exact URL ownership. User/admin tokens return 401; insufficient scope, inactive status, and ownership mismatch return 403. Deleted installations return 401, including when deletion wins a concurrent insertion transaction.

Accept an `application/json` object containing exactly `recordedAt`, `powerKw`, `energyKwh`, and `voltageV`. Measurements must be finite nonnegative JSON numbers; strings are not coerced. Reject missing/unknown fields, including client IDs, installation binding, and receipt time, with 400 `INVALID_REQUEST`. `recordedAt` must be a valid calendar ISO 8601 timestamp (`YYYY-MM-DDTHH:mm:ss[.SSS]Z` or an explicit `+/-HH:mm` offset), with one to three fractional digits when present. Reject timezone-free values, calendar overflow, leap seconds, and precision beyond BSON milliseconds. Clock-drift, age, and measurement upper bounds remain unresolved; none are enforced.

After authentication, ownership, and body validation, consume shared counters of 30 submissions/minute per installation public UUID and IP, in separate device-write namespaces. Valid-shaped attempts, including duplicates, consume counters. Exceeded limits return 429 `RATE_LIMIT_EXCEEDED` and integer `Retry-After` seconds. Parser, negotiation, and media-type errors follow the general contract.

Identity, ownership, receipt time, and atomic insertion follow the [architecture transaction strategy](architecture.md#reading-ingestion). Duplicate `(installationId, recordedAt)` returns 409 `DUPLICATE_READING` without overwriting. Return 201 with only `id`, `installationId`, both timestamps formatted with `+05:30`, and the three measurements. Include a strong ETag for the exact public representation, `Last-Modified` from `receivedAt` as an HTTP date, and `Location: /api/v1.0/installations/{installationId}/readings/{readingId}` (respect the configured prefix). All submission responses use `Cache-Control: no-store`. The Location identifies the user-authorized reading GET; see [current implementation](../README.md#current-implementation) for route availability.

## Protected province list

`GET /provinces` requires a user bearer JWT. Missing/malformed/invalid/expired tokens, non-user actors, removed users, or invalid stored role/scope assignments return 401 `UNAUTHORIZED` with `WWW-Authenticate: Bearer`. Use one generic message, `A valid user bearer token is required.`; do not disclose token-validation details. Persistence failures remain sanitized 500s.

Apply the current stored jurisdiction and optional geographic filters before count/paging. Return the standard list envelope with public `{ "id": "<UUID>", "name": "..." }` items ordered by name then public ID. Accept only single-valued `provinceId`, `districtId`, `substationId`, `offset`, and `limit`; malformed UUIDs, unknown/repeated fields, invalid paging, or conflicting ancestry among visible targets return 400 `INVALID_QUERY`. Unknown/out-of-scope filter targets return 200 with an empty scoped list.

Successful responses use `Cache-Control: private, no-cache` and a stable strong ETag tied to the current principal and exact scoped representation. Omit Last-Modified because no reliable geography modification time is stored. Authenticate/reload User, apply the shared 120/minute user read limit, and scope the representation before conditional GET evaluation. Matching If-None-Match returns bodyless 304 with validators. Authentication, query, and rate-limit errors are not cacheable; 429 includes Retry-After seconds.

## Individual reading

`GET /installations/{installationId}/readings/{readingId}` requires user JWT authentication and current stored jurisdiction, following the same 401 contract as protected province reads. Installation tokens return 401. Authenticate, consume the shared 120/minute User read limit, validate both UUID v4 path parameters (400 `INVALID_REQUEST` on failure), and resolve installation ancestry before looking up the reading or evaluating validators. National analysts/admins read nationally; provincial/district analysts read only within their assigned ancestry.

An existing installation with complete ancestry outside the analyst's stored jurisdiction returns 403 `FORBIDDEN` with message `The installation is outside your permitted jurisdiction.` This check precedes reading lookup, so it also applies when the supplied reading ID does not exist. Missing installation/ancestry/reading and reading/installation mismatch return 404 `NOT_FOUND` with message `Reading not found.`. Return 200 with the same public reading JSON as POST, including `+05:30` timestamps. Inactive installation history remains readable.

Success uses `Cache-Control: private, no-cache`, the same exact-representation strong ETag as POST, and Last-Modified derived from immutable `receivedAt`. Matching If-None-Match (including a weak tag, matching tag in a list, or `*`) returns bodyless 304 with validators and no Content-Type. If-None-Match takes precedence whenever present; a nonmatching tag returns 200 even if If-Modified-Since would match. Without If-None-Match, an If-Modified-Since at or after Last-Modified returns 304; earlier or invalid dates return 200. Compare HTTP dates at whole-second resolution. Authentication, current jurisdiction, UUIDs, resource identity, and rate limits always precede conditional handling. Errors use no-store and do not include reading validators; 429 includes Retry-After.

## Resource and query rules

- Use `/api/v1.0` as the common base path, lowercase hyphenated segments, plural collection nouns, and IDs after collection names. Nest collections under their parent. The district summary is a top-level, verb-named processing function.
- GET is safe. A device POSTs to its installation's readings collection; the created resource has a retrievable `Location`. Readings remain append-only.
- Only admins may POST `/installations`, PATCH `/installations/{installationId}` with exactly `{ "status": "inactive" }`, or DELETE `/installations/{installationId}` when it has no readings. PATCH is an idempotent status update, not deletion, and preserves identity and history. DELETE takes no body, returns bodyless 204 on success, 409 if readings exist, and 404 if absent. Enforce the deletion guard atomically with ingestion as described in `architecture.md`. Expose no general update, reactivation, or PUT.
- Support JSON only for representations. Use `Content-Type: application/json` for JSON bodies; respect `Accept: application/json` and `*/*`. A bodyless DELETE request requires no Content-Type.
- Filter before sorting and paging. History accepts `from` (inclusive), `to` (exclusive), and `sort=timestamp|-timestamp`; order readings by `recordedAt` with `publicId` as a stable tie-breaker. Paging uses `offset` (default 0) and `limit` (default 50, max 200). Regional lists accept `provinceId`, `districtId`, and `substationId`; reject conflicting ancestry.
- List responses use `{ "count": 0, "next": null, "previous": null, "items": [] }`, with the count calculated after authorization/filters and before paging. Links retain filters.
- Latest-reading GET returns 404 when the installation has no readings.
- Otherwise valid device credentials/tokens for an inactive installation return 403 on token issuance or ingestion. A device token whose installation has been deleted fails current-principal verification with 401.

## Caching and access

- Generate stable `ETag` values for exact representations. Send `Last-Modified` only when a reliable change time exists.
- On conditional GET, check `If-None-Match` before `If-Modified-Since`. A match returns bodyless 304. Use private caching for scoped data. List/composite validators must reflect jurisdiction-scoped representations; an individual immutable reading uses its exact public representation validator only after current access is verified.
- Admin PATCH/DELETE `/installations/{installationId}` optionally accept `If-Match`. Compare against the current strong ETag from the installation detail GET (not overview/history/list validators), atomically with the mutation. Absent header preserves existing behavior; no 428 requirement. Accept a quoted entity-tag list (any strong match succeeds) or `*` for an existing installation; weak tags never match, and malformed syntax returns 400. An existing installation with no match returns JSON 412 `PRECONDITION_FAILED` without change, even if PATCH would be a no-op. Authenticate, authorize, validate, and preserve missing-resource 404 before evaluating the precondition; for existing DELETE targets, evaluate If-Match before the no-readings guard (mismatch 412; match with readings 409). On success, PATCH returns the resulting strong ETag (unchanged for a no-op); DELETE remains bodyless 204 without resource validators. See `architecture.md` for atomicity.
- Return 403 for an authenticated analyst requesting an atomic resource outside their stored jurisdiction, or another forbidden action. Return 404 for missing resources or parent/child identity mismatches. Scoped collection behavior remains unchanged.
- Use HTTPS and signed JWT bearer tokens. Resolve device ownership, stored role/jurisdiction, and current installation status using the [architecture security rules](architecture.md#security). Authenticate and authorize before processing conditional requests; validators cannot bypass read authorization.
- Keep OpenAPI aligned with the actual routes, schemas, query parameters, authentication, statuses, and headers. The resource and HTTP method design targets Richardson Level 2.
