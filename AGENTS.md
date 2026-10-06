# AGENTS.md — Solar Generation API

## Project context

Node.js/Express, Mongoose, and MongoDB Atlas. The JSON API and public `/docs` and `/openapi.json` are under `/api/v1.0` over HTTPS. Resource paths in `architecture.md` omit that common prefix.

| File                  | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `architecture.md`     | Stored data, resource paths, access, and operations |
| `API_DESIGN_RULES.md` | HTTP behavior and response contract                 |
| `decisions.md`        | Design rationale and unresolved issues              |

## Invariants

- Province → District → GridSubstation → SolarInstallation → append-only GenerationReading; User is separate. Meter identity belongs to the installation.
- Use public UUIDs in routes, references, JSON, and JWTs. Keep MongoDB `_id` and credential hashes internal.
- Only the meter bound to an installation can create its readings. Users read within their stored national, provincial, or district jurisdiction.
- User has role `user` or `admin` and no `active` field. Admins have national analyst read access (`readScope=national`) plus installation creation, PATCH status updates to `inactive`, and hard deletion only when no readings exist; no user management or reading writes. PATCH is a status update, not deletion. Preserve inactive installations and history; block their device token issuance and ingestion. Coordinate hard deletion with ingestion so installations with readings cannot be deleted and readings cannot be orphaned.
- Scope list results, counts, composite views, summaries, and cache validators before responding. Use stable ETags, bodyless 304, one error schema, and shared rate limits.
- Admin installation PATCH/DELETE accept optional `If-Match` against the current strong installation ETag. Compare atomically with the mutation; mismatch returns standard JSON 412 without change. Absence preserves existing behavior. PATCH returns the resulting ETag; DELETE checks the no-readings guard after a matching precondition (409 if readings exist, bodyless 204 on success).
- Seed includes 9 provinces, 25 districts, 20+ substations, 200+ installations, and seven days of readings per installation.

## Working loop

1. Read the relevant code and design files. Check `decisions.md` before adding routes whose behavior is unresolved.
2. Update the documented contract, implementation, and OpenAPI together. Keep routes thin; isolate validation, authorization, services, and persistence.
3. Verify device ownership, jurisdiction boundaries, list counts, pagination, conditional requests, 201 `Location`, and rate-limit responses. Include optional If-Match, atomic stale-write rejection, PATCH ETags, and guarded DELETE when implementing installation writes.
4. Keep secrets out of source control. Record generated-code prompts and corrections in the project's prompt log. Claim deployment or verification only after checking it.
