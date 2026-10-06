# API Design Rules

This API uses the applicable WSO2 REST design rules. `architecture.md` lists the concrete paths.

## Responses

| Status | When | Body and key headers |
| --- | --- | --- |
| 200 OK | Successful GET, token exchange, or installation deactivation | JSON; `Content-Type: application/json`. GET may include `ETag` and a reliable `Last-Modified`. Installation GET and PATCH return the strong ETag of the public installation representation; PATCH returns its resulting public fields. |
| 201 Created | Device creates a reading or admin creates an installation | Created resource as JSON; `Location` points to its GET; `ETag`. For readings, `Last-Modified` comes from `receivedAt`; the installation GET requires a jurisdiction-authorized user. |
| 204 No Content | Admin hard-deletes an installation with no readings | No body; no JSON Content-Type or deleted-resource validators. |
| 304 Not Modified | Conditional GET matches current representation | **No body**; preserve relevant cache validators. |
| 400 Bad Request | Invalid body, ID, filter, or time range | JSON error contract. |
| 401 Unauthorized | Missing or invalid bearer token | JSON error; `WWW-Authenticate: Bearer`. |
| 403 Forbidden | Authenticated client attempts a forbidden action | JSON error. |
| 404 Not Found | Missing or inaccessible atomic resource | JSON error; do not reveal inaccessible IDs. |
| 406 Not Acceptable | `Accept` excludes JSON | No JSON body when the client does not accept JSON. |
| 409 Conflict | Duplicate reading timestamp, duplicate meter ID, or attempted installation deletion when readings exist | JSON error; deletion uses `code=INSTALLATION_HAS_READINGS`. |
| 412 Precondition Failed | Admin installation PATCH/DELETE has a nonmatching `If-Match` | Standard JSON error with `code=PRECONDITION_FAILED`; no mutation. |
| 415 Unsupported Media Type | Write body is not JSON | JSON error. |
| 429 Too Many Requests | Shared rate limit exceeded | JSON error; `Retry-After` in seconds. |

All JSON errors use `{ "code": "...", "message": "...", "details": [] }`. Never include credentials or stack traces.

## Resource and query rules

- Use `/api/v1.0` as the common base path, lowercase hyphenated segments, plural collection nouns, and IDs after collection names. Nest collections under their parent. The district summary is a top-level, verb-named processing function.
- GET is safe. A device POSTs to its installation's readings collection; the created resource has a retrievable `Location`. Readings remain append-only.
- Only admins may POST `/installations`, PATCH `/installations/{installationId}` with exactly `{ "status": "inactive" }`, or DELETE `/installations/{installationId}` when it has no readings. PATCH is an idempotent status update, not deletion, and preserves identity and history. DELETE takes no body, returns bodyless 204 on success, 409 if readings exist, and 404 if absent. Enforce the deletion guard atomically with ingestion as described in `architecture.md`. Expose no general update, reactivation, or PUT.
- Support JSON only for representations. Use `Content-Type: application/json` for JSON bodies; respect `Accept: application/json` and `*/*`. A bodyless DELETE request requires no Content-Type.
- Filter before sorting and paging. History supports time bounds and timestamp order; regional collections support geographic filters. Return authorized `count`, `next`, `previous`, and `items`; links retain filters.

## Caching and access

- Generate stable `ETag` values for exact representations. Send `Last-Modified` only when a reliable change time exists.
- On conditional GET, check `If-None-Match` before `If-Modified-Since`. A match returns bodyless 304. Use private caching for scoped data; never share validators across jurisdictions.
- Admin PATCH/DELETE `/installations/{installationId}` optionally accept `If-Match`. Compare against the current strong ETag from the installation detail GET (not overview/history/list validators), atomically with the mutation. Absent header preserves existing behavior; no 428 requirement. Accept a quoted entity-tag list (any strong match succeeds) or `*` for an existing installation; weak tags never match, and malformed syntax returns 400. An existing installation with no match returns JSON 412 `PRECONDITION_FAILED` without change, even if PATCH would be a no-op. Authenticate, authorize, validate, and preserve missing-resource 404 before evaluating the precondition; for existing DELETE targets, evaluate If-Match before the no-readings guard (mismatch 412; match with readings 409). On success, PATCH returns the resulting strong ETag (unchanged for a no-op); DELETE remains bodyless 204 without resource validators. See `architecture.md` for atomicity.
- Use HTTPS and signed JWT bearer tokens. Bind `installation-write` to one installation; verify each user's read scope against resource ancestry.
- Check the stored user role before admin writes. Admins also have national analyst reads (`readScope=national`, no regional assignment) on all user GET routes, with the same filters, counts, paging, private validators, and per-user read limits. Admin permissions do not grant user management or reading ingestion. Check installation status before device token issuance and ingestion. Authenticate and authorize before processing conditional requests; admins cannot use cache validators to bypass read authorization.
- Keep OpenAPI aligned with the actual routes, schemas, query parameters, authentication, statuses, and headers. The resource and HTTP method design targets Richardson Level 2.
