# Design Decisions

This file records choices, their reasons, and unresolved questions. Concrete schemas and operations live in [architecture.md](architecture.md), HTTP behavior in [API_DESIGN_RULES.md](API_DESIGN_RULES.md), and seed operations in the [README](../README.md#sample-data). Historical implementation and verification records live in [prompt-log.md](prompt-log.md).

## D01 — Hierarchy and public IDs

Store authoritative parent references with User separate and random UUID v4 public IDs distinct from MongoDB identity. One parent determines geography; stable seed lookup keys preserve existing UUIDs on reruns.

## D02 — Meter identity and history

Bind meter identity/hashed secret to its installation and retain append-only history with unique installation/measurement-time pairs. This prevents cross-device writes and supports time/latest views without duplicating measurements.

## D03 — Client access

Use current principal state and complete ancestry for device writes, user reads and admin capabilities ([D07](#d07--admin-role-and-installation-lifecycle)). Scope data/counts/aggregates/validators before responding to prevent regional disclosure and stale-token privileges.

## D04 — Derived resources

Derive latest readings, overviews and summaries from history. Current power excludes inactive/stale sites; local-day energy uses counter changes with reset/incompleteness handling, including inactive history.

## D05 — URI and HTTP contract

Use versioned JSON resources, bounded pagination, one error schema and stable validators under the [HTTP contract](API_DESIGN_RULES.md). Versioning allows coexistence; Location/conditional requests support navigation/caching without unreliable modification times.

## D06 — Shared rate limits

Use shared counters and [architecture thresholds](architecture.md#rate-limits): per-process counters are bypassable across instances. Remaining thresholds are pending below.

## D07 — Admin role and installation lifecycle

Admin is a User role with national reads and limited installation creation, activation/deactivation and guarded hard deletion; no user management, general edits or reading writes. Preserve history and geographic attribution; reserve inactive meters. Shared transactional parent writes prevent orphan readings; new replacement UUIDs exclude old tokens. Optional strong If-Match protects stale writes without requiring conditional clients. Controlled setup/current roles avoid public registration and stale privileges. The original no-reactivation restriction was superseded by D35; deletion implementation is D36. Current [HTTP](API_DESIGN_RULES.md#caching-and-access) and [persistence](architecture.md#admin-installation-management) details have one owner.

## D08 — Environment configuration and health

Use Node's built-in environment loader centrally and mount relative routes under the configured prefix to avoid dependencies/inconsistent URLs. Health is liveness; dependency readiness remains separate/planned.

## D09 — MongoDB connection lifecycle

Centralize MongoDB lifecycle in src/config/database.js; connect before listening and close HTTP/database on shutdown. Preserve actual connection errors for diagnostics without explicitly logging the URI. This avoids accepting requests before persistence; startup never seeds automatically.

## D10 — Models and full seed

Share UUID/parent-validation/public-JSON/credential-projection model helpers to prevent drift; raw operations bypass guards and require explicit integrity. Fixed deterministic seven-day fixtures, stable lookup keys and transactional insert-only batches make runs reproducible/resumable without resetting identity/status/credentials/history. Archive the former demo separately. Store UTC instants, expose Sri Lankan timestamps and use local-day semantics. Profiles/persistence belong to [architecture](architecture.md#seed-dataset-and-persistence), commands to [README](../README.md#sample-data).

## D11 - Controlled user seeding

Provision 36 configured accounts separately from geography/readings. Insert-only email upserts preserve rotated passwords/access; complete-document validation and transactional verification prevent invalid or partial assignments. Keep ignored seed-users.env separate from database .env and avoid credential output/user-management routes. See [persistence](architecture.md#user-seeding) and [operation](../README.md#user-accounts).

## D12 - User credential exchange

Use [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) HS256 with environment key/issuer/audience/bounded lifetime and stored-field claims/public UUID sub. Reuse scrypt, identical invalid-credential errors/dummy derivation and no-store responses to reduce disclosure/caching. Adopt shared login limits. This entry originally covered user login only; D15 adds devices. Refresh tokens remain outside scope.

## D13 - Current-user verification and the first protected read

Verify JWTs and reload current credential-free User/access on every protected read; start with province listing. Signatures alone do not establish existence/current jurisdiction. Scoped database filters/counts and principal-specific private validators prevent data/cache leakage.

## D14 - Development device credential derivation

Derive development device secrets from a private common prefix plus exact meter ID using shared scrypt. This avoids managing 220 development secrets; prefix compromise exposes all derivations, so production needs independent credentials. Seed reruns preserve hashes/status/identity/history; rotation is explicit setup outside the API. See [configuration](../README.md#sample-data).

## D15 - Device credential exchange

Verify stored meter hashes before status, then issue installation-only tokens for active devices using shared JWT configuration/separate login counters. This supports independent secrets, avoids inactive-state disclosure without credentials and excludes device actors from user reads.

## D16 - Current-installation verification and ownership

Share cryptographic verification but separately reload current installation status and enforce exact actor/write scope/URL ownership. Unexpired claims cannot override inactive/deleted state or authorize another installation; attach only the authenticated UUID.

## D17 - Transactional device reading submission

Insert readings with a real shared parent write in the transaction: authentication alone cannot stop concurrent lifecycle changes, snapshot-only checks can orphan history. Timestamp uniqueness prevents overwrites. Explicit zones/millisecond validation preserve BSON identity; clock drift/age/ceilings require domain decisions. [HTTP rules](API_DESIGN_RULES.md#device-reading-submission) own validation.

## D18 - Individual reading access and validators

Authorize complete ancestry before a reading lookup bound to both UUIDs, retaining inactive history. A global reading UUID does not prove ownership/jurisdiction. Explicit forbidden responses distinguish access from missing resources and may reveal parent existence. Exact immutable representations share POST/GET ETags; private caching/rechecks prevent access bypass.

## D19 - Installation history pagination and caching

Read authorized ancestry/count/page in one snapshot so ingestion cannot mix count/results. Index/public-ID ordering is deterministic. Whole-envelope ETags include query/access context; page max receivedAt cannot describe collection membership/count/link changes, so omit collection Last-Modified.

## D20 - Feature-based source organization

Group routes/controllers/validation/services by feature while keeping shared security/persistence/configuration/models/utilities separate. This improves navigation without merging responsibilities; timestamp parsing is independent of POST middleware and reading serialization has one owner.

## D21 - Scoped regional reading history

Resolve regional eligible installation UUIDs through geography in the count/page snapshot and reuse history helpers. Apply scope before queries to prevent disclosure; broad parent filters intersect district scope. Separate resolver preserves province-list empty-filter behavior while regional filters give explicit missing/forbidden/conflict errors.

## D22 - Latest measurement lookup

Select greatest recordedAt through the history index after shared ancestry authorization. Delayed delivery must not replace a newer measurement. Indexed findOne avoids full-history loads; inactive history remains useful. Reuse reading serialization/receipt validators after renewed access.

## D23 - Installation overview composite

Choose installation/geography/nullable latestReading as the minimal overview because exact fields were previously unspecified. Shared public serializers and one snapshot avoid private data and mixed states. Full-composite ETag tracks geography/status/reading; receipt time cannot cover all changes.

## D24 - Installation detail representation and validator

Use one canonical four-field installation serializer and principal-independent SHA-256 strong ETag for detail and admin preconditions. Readers need the same write validator; history/geography/private changes must not invalidate unchanged metadata. Access remains checked; no persisted metadata revision supports Last-Modified.

## D25 - Scoped installation collection

Reuse regional authorization and one snapshot for installation count/page; retain both statuses with fixed UUID order. Scope-before-query prevents leaks; explicit regional filter errors stay consistent. No client sort was specified. Complete query/envelope ETag has no reliable collection Last-Modified.

## D26 - Grid substation detail access

Resolve full substation ancestry in a snapshot and share jurisdiction comparison. Parent province determines provincial access; district readers cannot see siblings. Explicit projections/allowlists prevent metadata leakage; no reliable geography revision supports Last-Modified.

## D27 - District substation collection

Authorize district ancestry before the full bound substation list in one snapshot. The user requested no pagination for this small collection; name/UUID ordering stabilizes ties without client sort. Parent-scoped counts/ETags prevent sibling disclosure; empty authorized parents remain valid. No reliable collection Last-Modified.

## D28 - District detail access

Reuse District/Province ancestry for district detail. Provincial access depends on stored parent, district access on exact assignment. Check current access before public serialization/validators; expose no related collections/query options or unreliable Last-Modified.

## D29 - Province district collection

Authorize province, bind districts to that parent and additionally to a district analyst's stored UUID. This allows parent navigation without sibling data/count/validator leakage. Shared snapshot/serializer, deterministic name/UUID order and no pagination/query options keep the small collection consistent.

## D30 - Province detail access

Reuse province access/current district ancestry for province detail and nested districts in one snapshot. Stored ancestry, not token claims, determines access; broken assignments fail closed before scoped validators. Minimal id/name output avoids related collections; no reliable metadata Last-Modified.

## D31 - Observed district generation summary (approved 2026-10-08)

User approved the seven summary fields and observed daily energy without estimates/interpolation, resolving prior baseline/reset questions. Use daily consecutive nonnegative counter differences; skip decreases/resume from lower counters rather than assume zero resets. Mark missing midnight/few samples/decreases incomplete while retaining observed contributions. Exact rules belong to the [HTTP contract](API_DESIGN_RULES.md#district-generation-summary). Capture time once across snapshot retries; current power needs inclusive freshness and excludes inactive sites, while energy retains history. Time advances can change a full-summary ETag without ingestion. User corrected asOf to readable Sri Lankan text instead of a second field; calculations retain full precision and ETag tracks display/values.

## D32 - Nested substation installation list

Reuse installation list persistence with a URL substation parent. User requested a full small collection (about ten installations/substation), so omit pagination/queries; top-level pagination remains. Shared scope/count/snapshot logic prevents drift, and parent UUID must affect validators even for identical empty bodies.

## D33 - Admin installation provisioning

Use current stored admin role, independent device secrets, shared scrypt/models/serializer/detail ETag and unique meter index. Current role defeats stale claims; unique meter reservation covers inactive/concurrent duplicates. Preserve model trimming/exact secrets without inventing credential policy. Seed-prefix derivation stays in setup; shared admin-write limits count valid shapes. DELETE was outside this initial change and is now covered by D36.

## D34 - Transactional installation deactivation

Initial PATCH allowed only inactive; D35 supersedes that restriction. Compare optional strong If-Match inside snapshot/majority transaction and force a real parent write even for no-ops, retrying all checks. Ingestion already writes that parent: serialization prevents post-deactivation commits and stale successful comparisons surviving concurrent changes. Unchanged public fields retain their ETag; shared HTTP rules own preconditions. D36 subsequently implements deletion.

## D35 - Admin reactivation (approved 2026-10-08)

User defined inactive as indefinite blocking until explicit admin reactivation and approved status PATCH in both directions. Retain the same atomic preconditions/parent writes, current-admin access and budget; derive installation-status-update regardless of old JWT permission claims. Maintenance/suspension must preserve identity/history. Reactivation is not permanent token revocation: unchanged credentials/unexpired device tokens resume only until original exp; expired tokens require login. This supersedes D07/D34 restrictions; D36 adds deletion.

## D36 - Guarded installation hard deletion

Reuse installationForWrite/precondition utilities and shared admin budget for bodyless deletion of empty active/inactive installations. Compare precondition, force parent write, then check history/delete in one transaction; retries repeat all checks. Separate/snapshot-only guards can orphan readings. Earlier ingestion blocks deletion; earlier deletion blocks reading commit. Preconditions precede history conflict. New replacement UUIDs exclude old tokens. [HTTP rules](API_DESIGN_RULES.md#installation-deletion) own responses/body framing; [architecture](architecture.md#admin-installation-management) owns persistence, README manual checks.

## Pending decisions

| Topic | Decision needed |
| --- | --- |
| Measurement validation | Set meter clock-drift, age and measurement bounds. |
| Deployment | Choose provider, HTTPS termination and trusted proxy/IP configuration. |
| Rate thresholds | Confirm remaining public/backstop policies; current initial values/status live in [architecture](architecture.md#rate-limits). |
