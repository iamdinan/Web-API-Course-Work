# AGENTS.md — Solar Generation API

## Project context

Node.js/Express, Mongoose, and MongoDB Atlas. The target JSON API and public documentation use `/api/v1.0` over HTTPS. Resource paths in the architecture omit that common prefix. Check the README for implemented features before claiming a route exists.

| File | Purpose |
| --- | --- |
| [README.md](README.md) | Setup, commands, current implementation, and documentation navigation |
| [docs/architecture.md](docs/architecture.md) | Stored data, resource paths, access, and persistence operations |
| [docs/API_DESIGN_RULES.md](docs/API_DESIGN_RULES.md) | HTTP behavior and response contract |
| [docs/decisions.md](docs/decisions.md) | Design rationale and unresolved issues |
| [docs/data-model-reference.md](docs/data-model-reference.md) | Conceptual domain entities and relationships |
| [docs/prompt-log.md](docs/prompt-log.md) | Historical generated-code prompts, corrections, and verification |

## Invariants

These reminders are intentional; use the linked documents for full specifications.

- Province → District → GridSubstation → SolarInstallation → append-only GenerationReading; User is separate. Meter identity belongs to the installation.
- Use public UUIDs in routes, references, JSON, and JWTs. Keep MongoDB `_id` and credential hashes internal.
- Only the meter bound to an active installation can create its readings. Users read within their stored national, provincial, or district jurisdiction.
- User has role `user` or `admin` and no `active` field. Admins have national analyst reads, installation creation, PATCH status updates to `inactive`, and hard deletion only when no readings exist; no user management or reading writes.
- Preserve inactive installations and history; block their device token issuance and ingestion. Coordinate hard deletion with ingestion to prevent deleting installations with readings or orphaning readings.
- Scope list results, counts, composite views, summaries, and cache validators before responding. Use stable ETags, bodyless 304, one error schema, and shared rate limits.
- Admin installation PATCH/DELETE accept optional `If-Match` against the current strong installation ETag, compared atomically with the mutation. Mismatch returns standard JSON 412 without change; absence preserves unconditional behavior. PATCH returns the resulting ETag. DELETE evaluates the precondition before its no-readings guard: 409 with readings, bodyless 204 on success.
- Seed at least 9 provinces, 25 districts, 20 substations, 200 installations, and seven days of readings per installation. Preserve existing records on reruns; see the architecture seed section for the current dataset.

## Working loop

1. Read relevant code and design files. Check pending decisions before implementing unresolved behavior.
2. Update the contract, implementation, and OpenAPI together. Keep routes thin; isolate validation, authorization, services, and persistence. OpenAPI documents implemented routes only.
3. Verify device ownership, jurisdiction boundaries, scoped counts/pagination, conditional requests, 201 `Location`, and shared rate-limit responses when implementing those features.
4. For installation writes, verify admin-only access, allowed fields, duplicate meters, repeat deactivation, inactive-device rejection, retained history, summary/cache changes, and stale tokens. Check optional If-Match, no-op PATCH ETags, atomic stale-write rejection, empty deletion, repeat-delete 404, the 412-before-409 ordering, and concurrent ingestion/deletion without orphaned readings.
5. Keep secrets out of source control. Record generated-code prompts and corrections in the prompt log. Claim deployment or verification only after checking it; distinguish offline tests from historical/live evidence.

## Documentation maintenance

Keep operational instructions in the README, schemas/access/persistence in the architecture, HTTP details in the API design rules, rationale in decisions, and historical work in the prompt log. Link to the owning document instead of copying full specifications. Preserve historical log entries and mark removed tools as historical. Prefer existing documents and sections over adding Markdown files for individual features.
