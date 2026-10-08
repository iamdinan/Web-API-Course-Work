# API Design Rules

This file defines the HTTP contract using the applicable WSO2 REST design rules. [architecture.md](architecture.md) owns concrete paths, access assignments, and persistence guarantees. The [README](../README.md#current-implementation) distinguishes implemented features from planned behavior; [OpenAPI](openapi.json) describes implemented routes only.

## Responses

Public reading timestamps `recordedAt` and `receivedAt` use ISO 8601 Sri Lankan time (Asia/Colombo, `+05:30`), preserving the stored instant and milliseconds. Reading responses also include derived `recordedAtDisplay` and `receivedAtDisplay`, for example `08 Oct 2026, 12:00 PM (Sri Lanka)`. Display fields use English month abbreviations and 12-hour time at minute precision; use the ISO fields for exact instants. These read-only fields appear consistently in POST, individual GET, and list items and participate in response ETags. Expose public UUIDs as `id`; never expose MongoDB internal IDs or credential hashes. ID generation and storage rules belong to the architecture.

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

Identity, ownership, receipt time, and atomic insertion follow the [architecture transaction strategy](architecture.md#reading-ingestion). Duplicate `(installationId, recordedAt)` returns 409 `DUPLICATE_READING` without overwriting. Return 201 with `id`, `installationId`, both ISO timestamps, both derived display timestamps, and the three measurements. Include a strong ETag for the exact public representation, `Last-Modified` from `receivedAt` as an HTTP date, and `Location: /api/v1.0/installations/{installationId}/readings/{readingId}` (respect the configured prefix). All submission responses use `Cache-Control: no-store`. The Location identifies the user-authorized reading GET; see [current implementation](../README.md#current-implementation) for route availability.

## Protected province list

`GET /provinces` requires a user bearer JWT. Missing/malformed/invalid/expired tokens, non-user actors, removed users, or invalid stored role/scope assignments return 401 `UNAUTHORIZED` with `WWW-Authenticate: Bearer`. Use one generic message, `A valid user bearer token is required.`; do not disclose token-validation details. Persistence failures remain sanitized 500s.

Apply the current stored jurisdiction and optional geographic filters before count/paging. Return the standard list envelope with public `{ "id": "<UUID>", "name": "..." }` items ordered by name then public ID. Accept only single-valued `provinceId`, `districtId`, `substationId`, `offset`, and `limit`; malformed UUIDs, unknown/repeated fields, invalid paging, or conflicting ancestry among visible targets return 400 `INVALID_QUERY`. Unknown/out-of-scope filter targets return 200 with an empty scoped list.

Successful responses use `Cache-Control: private, no-cache` and a stable strong ETag tied to the current principal and exact scoped representation. Omit Last-Modified because no reliable geography modification time is stored. Authenticate/reload User, apply the shared 120/minute user read limit, and scope the representation before conditional GET evaluation. Matching If-None-Match returns bodyless 304 with validators. Authentication, query, and rate-limit errors are not cacheable; 429 includes Retry-After seconds.

## Province details

`GET /provinces/{provinceId}` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED with WWW-Authenticate: Bearer. Validate provinceId as a public UUID v4 (400 INVALID_REQUEST); missing requested province returns 404 NOT_FOUND with message `Province not found.` National analysts/admins can read any province; provincial analysts only their assigned province; district analysts only the province containing their current assigned district. Other provinces, or broken assigned district ancestry for an existing requested province, return 403 FORBIDDEN with message `The province is outside your permitted jurisdiction.`

Return only `{id,name}`, with no related collections. No query parameters; reject supplied options with 400 INVALID_QUERY. Authorize in a snapshot before data or validators. Strong ETag covers the current principal and public response; Cache-Control is private, no-cache. Matching strong/weak If-None-Match, a matching tag in a list, or * returns bodyless 304 with ETag/cache headers and no Content-Type. Recheck current authentication, access and shared limits before conditional responses. Omit Last-Modified because province metadata has no reliable change timestamp; If-Modified-Since alone returns 200. Errors use the standard schema, no-store and no ETag/Last-Modified.

## Province districts

`GET /provinces/{provinceId}/districts` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED with WWW-Authenticate: Bearer. Validate provinceId as a public UUID v4 (400 INVALID_REQUEST). Missing requested province returns 404 NOT_FOUND with message `Province not found.` National analysts/admins list all districts in the requested province; provincial analysts only within their assigned province. District analysts may request their own parent province, but receive only their assigned district. Other provinces return 403 FORBIDDEN with message `The province is outside your permitted jurisdiction.` Missing/broken assigned district ancestry fails closed with 403 for an existing requested province.

Authorize the parent before querying district results. Bind the database list to the requested provinceId and, for district analysts, the stored district public UUID; never load sibling districts into their response or validator input. Return `{ "count": 0, "items": [] }`, with public id/provinceId/name items, sorted by name then public UUID ascending for deterministic order. Empty authorized provinces return 200 with an empty collection. This fixed order has no client-selectable sorting option. Accept no query parameters: pagination, sorting, geography or other supplied parameters return 400 INVALID_QUERY. Omit next/previous fields. Read parent authorization and full filtered list in one snapshot; count equals returned records.

Use Cache-Control: private, no-cache and a stable strong ETag covering current authorized principal, requested province and the complete filtered count/items response. Matching If-None-Match (strong/weak, tag list or *) returns bodyless 304 with ETag/cache headers and no Content-Type only after current authentication, authorization and shared rate limiting. Omit Last-Modified because no reliable whole-collection change time exists; If-Modified-Since alone returns 200. Errors use no-store and omit validators/data/counts; 429 includes Retry-After.

## District details

`GET /districts/{districtId}` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED with WWW-Authenticate: Bearer. Validate districtId as a public UUID v4 (400 INVALID_REQUEST). Missing district or province ancestry returns 404 NOT_FOUND with message `District not found.` National analysts/admins read nationally; provincial analysts read districts within their stored province; district analysts only their assigned district. Other access returns 403 FORBIDDEN with message `The district is outside your permitted jurisdiction.` Authorize before data or validators.

Return 200 with exactly id, provinceId and name. Use public UUIDs only; omit internal IDs, version/private metadata and related collections. Accept no query options; supplied query parameters return 400 INVALID_QUERY.

Use Cache-Control: private, no-cache and a strong ETag covering the current authorized principal and complete public district representation. Matching If-None-Match (strong/weak, tag list or *) returns bodyless 304 with ETag/cache headers and no Content-Type only after current authentication, jurisdiction and shared rate limits. Omit Last-Modified because no reliable district metadata change time is stored; If-Modified-Since alone returns 200. Errors use no-store and omit validators; 429 includes Retry-After.

## District grid substations

`GET /districts/{districtId}/grid-substations` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED with WWW-Authenticate: Bearer. Validate districtId as a UUID v4 (400 INVALID_REQUEST). Missing district or province ancestry returns 404 NOT_FOUND with message `District not found.` National analysts/admins may access nationally; provincial analysts only districts in their stored province; district analysts only their assigned district. Other access returns 403 FORBIDDEN with message `The district is outside your permitted jurisdiction.` Authorize the parent before any substation query, count or validator.

Return the full district collection without pagination. Accept no query parameters; offset, limit, geography filters, sort and other supplied query parameters return 400 INVALID_QUERY. Order by name ascending then public UUID ascending for deterministic ties.

Return `{ "count": 0, "items": [] }`; items contain exactly id, districtId and name for substations in the URL district. Count equals the number of returned district substations. Empty authorized districts return 200 with count=0 and empty items. Omit next and previous entirely. Read parent ancestry and the full list in one snapshot; derive count from the returned records.

Use Cache-Control: private, no-cache and a stable strong ETag covering current principal, district identity and the complete response. Matching If-None-Match (strong/weak, tag list or *) returns bodyless 304 with ETag/cache headers and no Content-Type only after current access and shared rate limits. Omit Last-Modified because no reliable whole-collection change timestamp exists; If-Modified-Since alone returns 200. Errors use no-store and omit validators/data/counts; 429 includes Retry-After.

## Grid substation details

`GET /grid-substations/{substationId}` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED with WWW-Authenticate: Bearer. Validate the public UUID v4 path parameter (400 INVALID_REQUEST). Resolve the substation, district and province before public data or validators; national analysts/admins read nationally, provincial analysts within their stored province and district analysts within their stored district. Cross-jurisdiction access returns 403 FORBIDDEN with message `The substation is outside your permitted jurisdiction.` Missing substation or ancestry returns 404 NOT_FOUND with message `Substation not found.` Broken ancestry fails closed even for national readers.

Return 200 with exactly id, districtId and name, using public UUIDs only. Do not include internal IDs, version metadata, installations, reading history or credential fields. No new query filters or child-list endpoints are introduced.

Use Cache-Control: private, no-cache and a stable strong ETag covering current authorized principal and public representation. Matching If-None-Match (strong/weak, matching tag in a list or *) returns bodyless 304 with ETag/cache headers and no Content-Type, only after current authentication, jurisdiction checks and shared rate limiting. Omit Last-Modified because no reliable substation metadata change time is stored; If-Modified-Since alone returns 200. Errors use no-store and omit validators; 429 includes Retry-After.

## Individual reading

`GET /installations/{installationId}/readings/{readingId}` requires user JWT authentication and current stored jurisdiction, following the same 401 contract as protected province reads. Installation tokens return 401. Authenticate, consume the shared 120/minute User read limit, validate both UUID v4 path parameters (400 `INVALID_REQUEST` on failure), and resolve installation ancestry before looking up the reading or evaluating validators. National analysts/admins read nationally; provincial/district analysts read only within their assigned ancestry.

An existing installation with complete ancestry outside the analyst's stored jurisdiction returns 403 `FORBIDDEN` with message `The installation is outside your permitted jurisdiction.` This check precedes reading lookup, so it also applies when the supplied reading ID does not exist. Missing installation/ancestry/reading and reading/installation mismatch return 404 `NOT_FOUND` with message `Reading not found.`. Return 200 with the same public reading JSON as POST, including `+05:30` timestamps. Inactive installation history remains readable.

Success uses `Cache-Control: private, no-cache`, the same exact-representation strong ETag as POST, and Last-Modified derived from immutable `receivedAt`. Matching If-None-Match (including a weak tag, matching tag in a list, or `*`) returns bodyless 304 with validators and no Content-Type. If-None-Match takes precedence whenever present; a nonmatching tag returns 200 even if If-Modified-Since would match. Without If-None-Match, an If-Modified-Since at or after Last-Modified returns 304; earlier or invalid dates return 200. Compare HTTP dates at whole-second resolution. Authentication, current jurisdiction, UUIDs, resource identity, and rate limits always precede conditional handling. Errors use no-store and do not include reading validators; 429 includes Retry-After.

## Latest reading

`GET /installations/{installationId}/last-reading` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401. Validate the installation UUID v4 (400 `INVALID_REQUEST` on failure), then reuse complete installation ancestry authorization: national analysts/admins read nationally, provincial/district analysts within their stored jurisdiction. Cross-jurisdiction access returns 403 `FORBIDDEN` before reading lookup, even when no readings exist. Missing installation/ancestry or an installation without readings returns 404 `NOT_FOUND` with message `Reading not found.` Inactive installation history remains readable.

Select the greatest recordedAt, with descending publicId as the deterministic tie-breaker; receivedAt does not determine which reading is latest. Return 200 with the existing public reading representation, including both ISO and display timestamps. No filters or pagination apply.

Use the [individual-reading conditional contract](#individual-reading): private, no-cache; the exact public reading strong ETag; Last-Modified from the selected immutable reading receivedAt at whole-second precision. If-None-Match takes precedence over If-Modified-Since; matching conditions return bodyless 304 with validators and no Content-Type. Authentication, current jurisdiction, resource lookup and shared rate limiting precede conditional handling. A delayed older measurement leaves the selected reading and validators unchanged; a newer recordedAt changes the representation ETag. Last-Modified describes the selected reading receipt time, not the installation or the whole history; use ETag to distinguish changes within the same second. Errors use no-store and omit ETag/Last-Modified; 429 includes Retry-After.

## Installation list

`GET /installations` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED. National analysts/admins list nationally; provincial/district analysts see only their stored jurisdiction. Resolve complete geography and restrict installation queries before querying items, counts or validators. Explicit geography outside jurisdiction returns 403 FORBIDDEN; missing referenced geography/ancestry returns 404 NOT_FOUND. Authorize each filter before checking contradictory relationships; authorized contradictory ancestry returns 400 INVALID_QUERY. Missing implicit geography yields an empty scope, never unrestricted results.

Accept only single-valued provinceId, districtId and substationId UUID v4 filters, offset (nonnegative safe integer, default 0) and limit (1-200, default 50). Offset plus limit must remain a safe integer. Reject malformed/repeated/unknown parameters, including status, sort, from and to, with 400 INVALID_QUERY. District analysts may select their parent province while results remain district-scoped. Include both active and inactive installations; no status filter is documented. Use ascending public UUID order for stable pagination; no client-selectable sort.

Return `{ "count": 0, "next": null, "previous": null, "items": [] }`. Items contain exactly id, substationId, meterId and status via the shared public installation serializer. Count covers all matching authorized installations before paging. Links use the configured prefix and preserve supplied geography filters and effective limit. Empty results return 200 with count=0, null links and empty items. Offsets beyond the result retain the scoped count, with empty items and next=null. Read authorized geography, count and page in one snapshot.

Use Cache-Control: private, no-cache and a strong ETag covering current authorized principal, effective query and the complete envelope including counts/links. Matching If-None-Match (strong/weak, tag list or *) returns bodyless 304 with validators and no Content-Type only after current authentication, authorization and shared rate limiting. Omit Last-Modified without a reliable whole-collection change time; If-Modified-Since alone returns 200. Denied/error responses use no-store, omit validators and expose no items/counts; 429 includes Retry-After. This collection ETag is distinct from installation-detail validators used for future If-Match.

## Installation details

`GET /installations/{installationId}` requires current user JWT authentication, the shared 120/minute User read limit and a valid UUID v4 installation path parameter. Installation tokens return 401 UNAUTHORIZED; invalid UUIDs return 400 INVALID_REQUEST. Resolve complete ancestry and enforce stored jurisdiction before returning data or validators. National analysts/admins read nationally; provincial/district analysts within their assignment. Cross-jurisdiction access returns 403 FORBIDDEN; missing installation or ancestry returns 404 NOT_FOUND with message `Installation not found.`

Return 200 with exactly the [public installation fields](architecture.md#installation-details): id, substationId, meterId and status. Include active and inactive installations. Do not expose internal IDs, hashes, version/lock metadata, geography or readings.

Use Cache-Control: private, no-cache and the canonical strong installation ETag described in architecture, independent of the reader. Future admin If-Match operations must use this same tag, rather than overview/history validators. Public status changes affect the tag; credential/internal metadata, geography names and new readings do not. Matching If-None-Match (strong/weak, matching tag in a list or *) returns bodyless 304 with ETag/cache headers and no Content-Type, only after current authentication, authorization and rate limiting. Omit Last-Modified because no reliable installation metadata change time is stored; never derive it from readings. If-Modified-Since alone returns 200. Errors use no-store and omit validators; 429 includes Retry-After. Installation writes remain unimplemented.

## Installation overview

`GET /installations/{installationId}/overview` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401 UNAUTHORIZED. Validate the installation UUID v4 (400 INVALID_REQUEST), resolve complete ancestry, and enforce stored jurisdiction before selecting readings, composing data or evaluating validators. National analysts/admins read nationally; provincial/district analysts within their assigned geography. Cross-jurisdiction access returns 403 FORBIDDEN; missing installation or ancestry returns 404 NOT_FOUND with message `Installation not found.`

Return 200 using the [architecture composite structure](architecture.md#installation-overview): installation, geography and latestReading. Latest is selected by greatest recordedAt with descending publicId tie-breaker, never by receivedAt. Empty history returns latestReading=null with installation/geography intact. Include inactive installations. Omit all internal IDs, credential hashes, locking/version metadata and full reading history.

Return Cache-Control: private, no-cache and a stable strong ETag covering the current authorized principal and entire composite. Installation status, public geography fields and selected latest-reading changes affect the ETag; delayed older readings do not. Matching If-None-Match (strong/weak, tag list or *) returns bodyless 304 with ETag/cache headers and no Content-Type, only after authentication, rate limiting and authorization. Omit Last-Modified because no reliable revision time covers the whole composite; If-Modified-Since alone returns 200. Errors use no-store and omit ETag/Last-Modified; 429 includes Retry-After.

## Installation reading history

`GET /installations/{installationId}/readings` requires current user JWT authentication, the shared 120/minute User read limit, a valid installation public UUID, and the same ancestry authorization as individual readings. Installation tokens return 401. Missing installation/ancestry returns 404 `NOT_FOUND` with message `Installation not found.`; cross-jurisdiction access returns 403 `FORBIDDEN`. Inactive history remains readable. Authorization precedes every history query, count, page and cache validator.

Accept only single-valued `offset` (nonnegative safe integer, default 0), `limit` (1-200, default 50), `from`, `to`, and `sort` (`timestamp` or `-timestamp`, default `-timestamp`). Offset plus limit must remain a safe integer. Use the [reading timestamp rules](#device-reading-submission) for from/to; from is inclusive and to exclusive. If both exist, require from < to. Reject malformed/repeated/unknown parameters and invalid paging/time ranges with 400 `INVALID_QUERY`. Percent-encode a positive timezone offset's `+` as `%2B` in query URLs.

Return `{ "count": 0, "next": null, "previous": null, "items": [] }`. Count includes all matching installation readings before paging. Sort by recordedAt then publicId, both ascending for timestamp or descending for -timestamp. Items reuse the public reading representation. An authorized empty installation or empty time window returns 200 with an empty envelope. Links use the configured API prefix and preserve from/to, effective sort, and limit while changing offset. An offset beyond the result still reports the matching count with empty items; next is null.

Return `Cache-Control: private, no-cache` and a strong ETag covering the current principal, installation ID, effective query and complete envelope, including count/links. Matching If-None-Match returns bodyless 304 with validators after current authorization and rate limiting, using existing conditional handling. Omit Last-Modified: no reliable revision is stored for the complete collection representation. If-Modified-Since alone therefore returns 200. Denied/error responses use no-store, contain no items/counts, and omit ETag and Last-Modified; 429 includes Retry-After.

## Regional reading history

`GET /readings` requires current user JWT authentication and the shared 120/minute User read limit. Installation tokens return 401. Without geography filters, national analysts/admins see national history, provincial analysts their province, and district analysts their district. Include inactive installation history. Resolve complete province/district/substation/installation ancestry and apply the stored jurisdiction before querying readings, counting, paging, or generating validators.

Accept the [installation history](#installation-reading-history) parameters and defaults, plus single-valued public UUID v4 provinceId, districtId and substationId. Resolve explicit filters and their ancestors; missing geography/ancestry returns 404 NOT_FOUND. Explicit filters outside stored jurisdiction return 403 FORBIDDEN. A district analyst may select their own parent province but results remain limited to their district. Check each filter's access before comparing their ancestry: authorized filters with contradictory relationships return 400 INVALID_QUERY. Malformed UUIDs and invalid/repeated/unsupported query parameters also return 400 INVALID_QUERY. Missing implicit ancestry yields an empty scope rather than broadening access.

Reuse the public reading list envelope and serialization. Count covers all matching authorized readings before pagination; recordedAt/publicId ordering is deterministic and defaults to newest first. Links point to `/api/v1.0/readings` and preserve all supplied geography/time filters, effective sort, and limit while changing offset. No matches return count=0, null links and empty items. Read ancestry, count and items in one snapshot.

Private caching, conditional GET, no reliable collection Last-Modified, and rate-limit responses follow installation history. ETag covers current authorized principal, effective query and the complete envelope; authorization and rate limiting precede any 304. Denied/error responses use no-store and expose neither data/counts nor ETag/Last-Modified. No changes to the protected province-list filter policy are implied.

## Resource and query rules

- Use `/api/v1.0` as the common base path, lowercase hyphenated segments, plural collection nouns, and IDs after collection names. Nest collections under their parent. The district summary is a top-level, verb-named processing function.
- GET is safe. A device POSTs to its installation's readings collection; the created resource has a retrievable `Location`. Readings remain append-only.
- Only admins may POST `/installations`, PATCH `/installations/{installationId}` with exactly `{ "status": "inactive" }`, or DELETE `/installations/{installationId}` when it has no readings. PATCH is an idempotent status update, not deletion, and preserves identity and history. DELETE takes no body, returns bodyless 204 on success, 409 if readings exist, and 404 if absent. Enforce the deletion guard atomically with ingestion as described in `architecture.md`. Expose no general update, reactivation, or PUT.
- Support JSON only for representations. Use `Content-Type: application/json` for JSON bodies; respect `Accept: application/json` and `*/*`. A bodyless DELETE request requires no Content-Type.
- Filter before sorting and paging. History accepts `from` (inclusive), `to` (exclusive), and `sort=timestamp|-timestamp` (default `-timestamp`); order readings by `recordedAt` with `publicId` as a stable tie-breaker. Paging uses `offset` (default 0) and `limit` (default 50, max 200). Regional lists accept `provinceId`, `districtId`, and `substationId`; reject conflicting ancestry.
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
