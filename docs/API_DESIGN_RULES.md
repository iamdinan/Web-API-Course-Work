# API Design Rules

HTTP contract using applicable WSO2 REST design rules. [Architecture](architecture.md) owns stored schemas, target paths, access and persistence; [README](../README.md#current-implementation) tracks availability. [OpenAPI](openapi.json) documents implemented operations/schemas. Shared rules below apply unless an endpoint states an exception.

## Responses

Public reading timestamps `recordedAt` and `receivedAt` use ISO 8601 Sri Lankan time (Asia/Colombo, `+05:30`), preserving the stored instant and milliseconds. Reading responses also include derived `recordedAtDisplay` and `receivedAtDisplay`, for example `08 Oct 2026, 12:00 PM (Sri Lanka)`. Display fields use English month abbreviations and 12-hour time at minute precision; use the ISO fields for exact instants. These read-only fields appear consistently in POST, individual GET, and list items and participate in response ETags. Expose public UUIDs as `id`; never expose MongoDB internal IDs or credential hashes. ID generation and storage rules belong to the architecture.

| Status | When | Body and key headers |
| --- | --- | --- |
| 200 OK | Successful GET, token exchange, or installation status update | JSON; `Content-Type: application/json`. GET may include `ETag` and a reliable `Last-Modified`. Installation GET and PATCH return the strong ETag of the public installation representation; PATCH returns its resulting public fields. |
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

## Resource and query rules

- Use `/api/v1.0`, lowercase hyphenated segments, plural collections and public UUID IDs; nest children under parents. The verb-named district summary is a processing function. GET is safe; readings are append-only. No general update/PUT or user-management routes. Design targets Richardson Level 2.
- Representations are JSON; honor Accept application/json and */*. Writes with bodies require application/json. Bodyless DELETE needs no Content-Type. Standard parser/negotiation rules apply throughout.
- Path UUID v4 errors use 400 INVALID_REQUEST; query errors use 400 INVALID_QUERY. Documented query fields are single-valued; reject unknown/repeated fields. Installation write UUIDs must be lowercase. Endpoints explicitly accepting no queries reject supplied options. Installation detail/overview and individual/latest reading routes advertise no query options but do not validate them.
- Paging: offset is a nonnegative safe integer (default 0); limit is 1–200 (default 50); their sum must be safe. Filter before sort/page. Paginated envelopes are `{ "count": 0, "next": null, "previous": null, "items": [] }`; count is all authorized matches before paging. Links preserve filters/effective limit and configured prefix, changing offset. Beyond-end offsets retain count, empty items and next=null. Full nested lists return only count/items, count=items.length. Authorized empty lists return 200.
- History uses from inclusive/to exclusive and requires from < to when both exist; timestamps follow [submission validation](#device-reading-submission). Encode positive-offset `+` as `%2B`. sort=timestamp|-timestamp (default -timestamp) orders recordedAt/publicId in the same direction. Geography filters are provinceId/districtId/substationId UUID v4 strings.

## Authentication and access

All protected GETs require current user JWT authentication; installation actors are rejected. Missing/malformed/invalid/expired/wrong-actor tokens, deleted users or invalid stored assignments return 401 UNAUTHORIZED, `WWW-Authenticate: Bearer`, and `A valid user bearer token is required.` Database errors are sanitized 500. Use current stored role/jurisdiction, ignoring stale JWT authorization claims.

National analysts/admins read nationally; provincial analysts within their stored province; district analysts within their stored district. District analysts may navigate their parent province but never see sibling district data/counts. Complete ancestry is required. Inactive installation history remains readable. Authorization precedes data, counts, composites, summaries and validators; [architecture](architecture.md#security) defines enforcement.

Atomic resources outside jurisdiction return 403 FORBIDDEN; missing resources/ancestry or parent-child mismatches return 404 NOT_FOUND. Geography detail errors are `Province not found.`, `District not found.` or `Substation not found.`; forbidden messages are `The province/district/substation is outside your permitted jurisdiction.` (use the applicable noun). Installation errors are `Installation not found.` and `The installation is outside your permitted jurisdiction.` Reading-specific 404 exceptions appear below. Broken assigned district ancestry yields 403 for an existing requested province.

Explicit regional installation/reading filters: missing geography/ancestry 404, outside jurisdiction 403; authorize each filter before contradictory authorized relationships return 400 INVALID_QUERY. Missing implicit geography yields an empty scope. A parent province filter never broadens district scope. The [province list](#protected-province-list) has a separate empty-result policy.

## Rate limits

[Architecture](architecture.md#rate-limits) owns shared counter storage, thresholds and keys. All protected user/admin GETs consume the shared 120/minute User budget before conditional responses. Login consumes 5 attempts/15 minutes per IP and normalized email/exact meter ID after validation but before credential verification/lookup; invalid shapes do not count. Device ingestion consumes 30/minute per installation and IP after authentication/ownership/body validation; duplicates count. Admin writes share 30/minute per admin after authorization/path/body validation; missing targets, duplicate meters, malformed/stale preconditions, no-ops and history conflicts count.

Exhaustion returns 429 RATE_LIMIT_EXCEEDED with integer Retry-After seconds. Counter failures fail closed. Do not replace shared limits with per-process limits.

## Caching and access

Protected GETs use Cache-Control: private, no-cache and stable strong ETags after current authentication, rate limiting and authorization. Errors use no-store without validators or data/counts. Bodyless 304 retains applicable cache/validator headers and omits Content-Type.

If-None-Match takes precedence whenever present: strong/weak tags, matching list members or * can match; a nonmatch gives 200 even if If-Modified-Since would match. Only individual/latest readings have reliable Last-Modified, derived from selected immutable receivedAt; without If-None-Match, a date at/after it yields 304, earlier/invalid dates 200, at whole-second resolution. Other protected GETs omit Last-Modified and ignore If-Modified-Since alone.

Scoped ETags cover current principal and complete public response; collections additionally include parent identity/effective query/count/links. Overview covers the entire composite; summary covers displayed asOf and calculated values. Exceptions: immutable readings hash their exact public representation shared by POST/GET; installation detail hashes only canonical public installation fields shared by GET/POST/PATCH, independent of reader. Geography names/history/credentials/internal metadata cannot change an unchanged installation-detail tag. Use detail ETags for admin writes, never list/overview tags.

Admin PATCH/DELETE optional If-Match compares atomically against the current strong detail ETag. Absence is unconditional (no 428); sole * or any matching strong tag in a quoted list succeeds; weak tags never match. Malformed syntax: 400 INVALID_REQUEST; no match: JSON 412 PRECONDITION_FAILED without change, including no-op PATCH. Resolve missing-resource 404 before parsing/comparing the header; DELETE compares before its readings guard (412 before 409). Conflict retries reload/re-evaluate; [architecture](architecture.md#admin-installation-management) owns atomicity. PATCH returns the committed ETag, unchanged for a no-op; DELETE has no validators.

## User token exchange

POST `/auth/user-tokens` accepts exactly email/password strings. Trim/lowercase a valid email; password must be non-whitespace, preserving its exact characters. Missing/unknown fields, arrays, invalid types/empty values: 400 INVALID_REQUEST; malformed JSON: INVALID_JSON; wrong media: 415 UNSUPPORTED_MEDIA_TYPE.

200 returns `{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 900, "userId": "<UUID>" }`; expiry is configured seconds, userId equals stored public UUID/JWT sub for both roles. No refresh token. All responses use no-store and Pragma: no-cache; no success validators. Unknown user/password mismatch: identical 401 INVALID_CREDENTIALS, `Invalid email or password.`, Bearer challenge. Unexpected persistence/signing failures: sanitized 500.

## Device token exchange

POST `/auth/device-tokens` accepts exactly nonempty/non-whitespace meterId/deviceSecret strings, preserving both exactly. Invalid shape: 400 INVALID_REQUEST, `Provide only a nonempty meterId and deviceSecret.` Parser/media/negotiation/no-store/Pragma and success fields follow user login, replacing userId with installationId=stored UUID/sub.

Unknown meter/secret mismatch: identical 401 INVALID_CREDENTIALS, `Invalid meter ID or device secret.`, Bearer challenge. Check credentials first; valid inactive credentials: 403 INSTALLATION_INACTIVE, `Inactive installations cannot obtain device tokens.` No token on failure. Login counter namespaces are separate from user login.

## Installation JWT verification and ownership

Missing/malformed/invalid/expired/wrong-actor JWT, deleted installation or invalid principal: 401 UNAUTHORIZED with Bearer challenge, `A valid installation bearer token is required.` Installation actors without exact installation-write scope: 403 FORBIDDEN, `The token does not permit installation writes.` Current inactive status: 403 INSTALLATION_INACTIVE, `Inactive installations cannot authenticate for writes.` URL mismatch: 403 FORBIDDEN, `The authenticated installation cannot access this installation.` Missing authenticated context uses the same installation 401. [Architecture](architecture.md#verified-installations-and-ownership) owns cryptographic/current-state checks.

## Device reading submission

POST `/installations/{installationId}/readings` requires the bound active device, using the verification/ownership rules above. User/admin tokens: 401; inactive/insufficient scope/mismatch: 403; deletion winning concurrent insertion: 401.

Accept exactly recordedAt/powerKw/energyKwh/voltageV. Measurements are finite nonnegative JSON numbers without coercion. Missing/unknown fields (including identity/binding/receipt fields): 400 INVALID_REQUEST. Timestamp must be calendar-valid ISO `YYYY-MM-DDTHH:mm:ss[.SSS]Z` or explicit +/-HH:mm offset, with 1–3 fractional digits if present. Reject missing zone, overflow, leap seconds and sub-millisecond precision. Clock-drift/age/upper measurement bounds remain unresolved and unenforced.

Duplicate installation/timestamp: 409 DUPLICATE_READING without overwrite. Return 201 with id, installationId, recordedAt/receivedAt and their Display fields, powerKw/energyKwh/voltageV; strong ETag, receipt-based Last-Modified and prefix-aware Location `/installations/{installationId}/readings/{readingId}`. Location GET requires an authorized user/admin. All submission responses use no-store. [Architecture](architecture.md#reading-ingestion) owns server identity, timestamps and transaction coordination.

## Protected province list

GET `/provinces`: province id/name items, sorted name/publicId ascending, paginated. Accept geography filters plus offset/limit. Unknown/out-of-scope filter targets return 200 empty scoped lists; conflicting ancestry among visible targets returns 400 INVALID_QUERY. Apply scope before count/page and scoped ETag.

## Province details

GET `/provinces/{provinceId}`: only id/name, no queries/related collections. National/admin any province, provincial own, district current parent province; use shared access/cache rules.

## Province districts

GET `/provinces/{provinceId}/districts`: full count/items, no queries/paging links, name/publicId ascending. Items have id/provinceId/name. National/admin and own-province provincial analysts receive the province's districts; district analysts only their assigned district in its parent province. Authorize parent before child queries/count/validators.

## District details

GET `/districts/{districtId}`: only id/provinceId/name, no queries/related collections; shared district access/cache rules.

## District grid substations

GET `/districts/{districtId}/grid-substations`: full count/items, no queries/paging links, name/publicId ascending. Items have id/districtId/name and belong to the authorized URL district.

## Grid substation details

GET `/grid-substations/{substationId}`: only id/districtId/name, no queries/related collections; shared substation access/cache rules.

## Individual reading

GET `/installations/{installationId}/readings/{readingId}`: validate both UUIDs, authorize installation before reading lookup (even if reading is absent). Missing installation/ancestry/reading or binding mismatch: 404 NOT_FOUND, `Reading not found.` Return the same reading representation/ETag as POST with receipt-based Last-Modified; shared conditional rules apply.

## Latest reading

GET `/installations/{installationId}/last-reading`: authorize before lookup, including empty history. Missing installation/ancestry or no readings: 404 NOT_FOUND, `Reading not found.` Select greatest recordedAt/publicId, never receipt order; reuse individual-reading fields/validators. Delayed older readings leave selection unchanged; newer measurements change ETag. Last-Modified describes the selected receipt, not history/installation; ETag distinguishes same-second changes. No filtering/pagination.

## Installation list

GET `/installations`: geography filters plus offset/limit only; fixed public UUID ascending order. Both statuses; id/substationId/meterId/status items in paginated envelopes. Reject status/sort/time filters. Explicit regional-filter errors and shared scoped cache rules apply. Read authorized ancestry/count/page in one snapshot; collection ETag differs from the detail write validator.

## Substation installation list

GET `/grid-substations/{substationId}/installations`: authorize complete substation ancestry first; missing/forbidden parent uses geography errors. Full count/items, both statuses, public UUID ascending, no queries/paging links. Items use installation fields and URL parent. ETag includes principal/parent/full collection, including empty results.

## Installation details

GET `/installations/{installationId}`: only id/substationId/meterId/status for either status, without related collections. Use shared installation access and canonical detail ETag rules.

## Installation overview

GET `/installations/{installationId}/overview`: shared installation access. Return `{installation, geography: {province, district, gridSubstation}, latestReading}` using the public detail schemas. latestReading is the public reading with greatest recordedAt/publicId or null. Both statuses; no history/counts/paging. Complete composite/current principal determines ETag; public status/geography/latest changes affect it, delayed older readings do not. No reliable whole-composite Last-Modified.

## Installation reading history

GET `/installations/{installationId}/readings`: shared installation access, including inactive history. Accept offset/limit/from/to/sort only. Reading items/paginated envelope follow shared query rules; links preserve time filters/effective sort/limit. Authorize before count/page; read ancestry/count/page in one snapshot. Empty history/time windows are 200, not 404. Whole-envelope ETag includes principal, installation and effective query; no collection Last-Modified.

## Regional reading history

GET `/readings`: installation-history parameters plus geography filters, retaining inactive history and applying explicit regional-filter errors. Without filters, scope follows stored jurisdiction. Read ancestry/count/page in one snapshot. Same reading envelope/order/cache rules; links preserve geography/time filters/effective sort/limit. Province-list empty-filter policy is unchanged.

## District generation summary

GET `/summarize-district-generation?districtId=...`: exactly one required districtId UUID v4; missing/invalid/repeated/other queries: 400 INVALID_QUERY. Shared district access/errors apply before queries/calculations/validators.

Return exactly districtId, asOf, freshInstallationCount, staleInstallationCount, currentPowerKw, todayEnergyKwh and incompleteEnergyInstallationCount. Capture asOf once per request; display it as `08 Oct 2026, 12:00 PM (Sri Lanka)` while retaining full millisecond precision for calculations. Read geography/status/readings in one snapshot. Active installations' latest recordedAt <= asOf is fresh if >= asOf minus 30 minutes inclusive; otherwise stale, including absent eligible readings. Sum power only for fresh active installations. Inactive sites contribute no power/fresh/stale counts.

todayEnergyKwh is observed daily energy that may be incomplete. For each active/inactive installation, order readings from Asia/Colombo midnight through asOf inclusive; sum nonnegative consecutive counter differences, skipping decreases and resuming from the lower counter. Use exact midnight baseline if available, otherwise the first in-day reading. Never use pre-midnight readings, assume zero resets, interpolate, extrapolate or estimate. Count an installation incomplete once if fewer than two daily samples, no exact midnight baseline or any decrease; retain usable observed contributions. Completeness guarantees neither continuous sampling nor energy up to asOf. No installations: zero totals/counts; no daily readings: zero energy/incomplete (also stale if active without fresh eligible reading).

Recalculate before conditional handling. ETag includes current principal and complete response, changing with displayed asOf minute or any value; sub-minute freshness expiry changes values at full precision. Time/midnight can change validators without ingestion. Shared private cache/304 rules apply; no Last-Modified.

## Installation creation

POST `/installations`: current stored admin required (user authentication failures 401, non-admin 403). Exactly substationId/meterId/deviceSecret strings; lowercase UUID v4 parent (missing: 404). Non-whitespace meter/secret; trim meter, preserve secret exactly. Reject client IDs/status/hashes/other fields or types: 400 INVALID_REQUEST. No extra complexity/length policy beyond 100 KB parser. Independent provisioning secret; duplicates including inactive meters/concurrent inserts: 409 DUPLICATE_METER_ID.

201 returns only id/substationId/meterId/status=active, canonical detail ETag and prefix-aware Location `/installations/{id}`; no Last-Modified. All responses no-store; never log/return credentials. Shared admin budget applies.

## Installation status updates

PATCH `/installations/{installationId}`: same current-admin access/budget as creation; lowercase UUID v4 and exactly `{"status":"active"}` or `{"status":"inactive"}`. Missing/empty body, other values/fields: 400 INVALID_REQUEST. Missing target: 404 NOT_FOUND (`Installation not found.`). Optional If-Match uses shared atomic rules, including stale no-op rejection.

200 returns only id/substationId/meterId/status and resulting detail ETag. Repeat current status: identical body/tag; preserve identity/credentials/ancestry/history/meter reservation. All responses no-store; no Last-Modified/error validators. Inactive blocks login/ingestion indefinitely, including old unexpired tokens. Explicit reactivation restores unchanged credentials and tokens only until original expiry; expired tokens stay 401. Admin access follows current stored role even for old permission claims. Lifecycle transactions serialize with ingestion.

## Installation deletion

DELETE `/installations/{installationId}`: same current-admin access/shared budget; lowercase UUID v4. Reject every body, including JSON `{}`/`[]`, non-JSON/chunked payloads: 400 INVALID_REQUEST. Empty requests need no Content-Type; Content-Length: 0 allowed; shared parser/size/negotiation errors still apply.

Resolve target 404 before optional If-Match parsing/comparison; evaluate precondition before any history guard. Stale with history: 412; matching/wildcard/absent header with history: 409 INSTALLATION_HAS_READINGS. Delete only active/inactive installations with no readings at any timestamp; never cascade. [Shared parent-write transaction](architecture.md#admin-installation-management) prevents orphan readings and retries all checks.

204 has no body/Content-Type/ETag/Last-Modified; all responses no-store, errors standard schema without validators. Repeat/missing target: 404. Old installation tokens fail 401, including against a newly registered replacement meter with a new UUID. Meter uniqueness is released only for the removed empty installation.
