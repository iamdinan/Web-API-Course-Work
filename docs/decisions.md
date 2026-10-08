# Design Decisions

This file records choices, their reasons, and unresolved questions. Concrete schemas and operations live in [architecture.md](architecture.md), HTTP behavior in [API_DESIGN_RULES.md](API_DESIGN_RULES.md), and seed operations in the [README](../README.md#sample-data). Historical implementation and verification records live in [prompt-log.md](prompt-log.md).

## D01 — Hierarchy and public IDs

- **Choice:** Store authoritative parent references; keep User separate. Use random UUID v4 public IDs and internal MongoDB IDs.
- **Reason:** One parent relationship determines geography. Public identity stays independent of database identity; stable seed lookup keys allow reruns to retain existing UUIDs.

## D02 — Meter identity and history

- **Choice:** Bind meter identity and its hashed secret to the installation. Keep append-only readings with unique installation/measurement-time pairs.
- **Reason:** History supports time queries and latest-reading views without duplicating measurements on the installation. The binding prevents devices from writing to other installations.

## D03 — Client access

- **Choice:** Devices write for one active installation. Users read within stored jurisdictions; admins have national analyst reads and the limited installation-management capabilities in D07.
- **Reason:** Verifying current principal state and resource ancestry for reads, counts, aggregates, and validators prevents cross-jurisdiction disclosure and stale-token privilege retention.

## D04 — Derived resources

- **Choice:** Derive latest readings, installation overviews, and district generation summaries from history.
- **Reason:** Current power must exclude stale and inactive sites. Local-day energy requires counter differences and incomplete/reset handling rather than summing cumulative counters. Inactive history remains relevant to energy totals.

## D05 — URI and HTTP contract

- **Choice:** Use a versioned base path, JSON representations, bounded paging, one error schema, and stable representation validators. Follow the detailed [HTTP contract](API_DESIGN_RULES.md).
- **Reason:** Versioned paths allow later versions to coexist. Created-resource links and conditional requests give clients consistent navigation and caching without inventing unreliable modification times.

## D06 — Shared rate limits

- **Choice:** Share rate counters across deployed instances; initial thresholds and keys are in the [architecture](architecture.md#rate-limits).
- **Reason:** Per-process counters would allow limits to be bypassed when traffic reaches multiple instances. Final thresholds remain subject to the pending implementation decision below.

## D07 — Admin role and installation lifecycle

- **Choice:** Admin is a User role with national reads, installation creation, deactivation, and hard deletion only without readings. There is no user management, general installation edit, reactivation, or reading-write privilege.
- **Reason:** Administrators can manage onboarding and empty installations while preserving measurement history and geographic attribution. Inactive installations retain their meter identity and history but immediately lose device token issuance and ingestion.
- **Integrity:** Coordinate ingestion and deletion through a shared transactional installation write or an equivalent guarantee. Snapshot checks alone cannot prevent orphaned readings. Replacements receive new public IDs so old installation tokens cannot address them.
- **Conditional writes:** Optional strong `If-Match` protects against stale admin changes while retaining unconditional clients. Compare against the same public detail representation used by GET and PATCH; internal lock fields must not change its ETag. Request ordering and status rules belong to the [HTTP contract](API_DESIGN_RULES.md#caching-and-access); persistence guarantees belong to the [architecture](architecture.md#admin-installation-management).
- **Provisioning:** Use controlled account setup and current stored roles, with no public registration or committed passwords.

## D08 — Environment configuration and health

- **Choice:** Load environment configuration centrally using Node.js's built-in loader and mount relative routes under the configured prefix. Keep health as application liveness, separate from database readiness.
- **Reason:** Central configuration avoids inconsistent URLs and extra environment-loader dependencies. Liveness describes whether the application is running; a future readiness endpoint can report dependency availability separately.

## D09 — MongoDB connection lifecycle

- **Choice:** Centralize connection/disconnection in `src/config/database.js`; connect before listening and close both HTTP and MongoDB on shutdown. Preserve the actual connection error for diagnostics without explicitly logging the configured URI.
- **Reason:** Prevent accepting requests before initial persistence is available and make failures diagnosable. Startup does not seed data automatically.

## D10 — Models and full seed

- **Choice:** Use shared Mongoose schema helpers for UUIDs, parent validation, safe public JSON, and credential projections. Protect reading history at the model layer; setup tooling may use validated insert-only raw upserts.
- **Reason:** Common helpers prevent model rules drifting. Raw collection operations bypass model guards, so API persistence must maintain the same invariants explicitly.
- **Seed choice:** Use a fixed seven-day synthetic dataset with deterministic profiles, random IDs for new records, stable lookup keys, and transactional insert-only batches. See the [architecture seed section](architecture.md#seed-dataset-and-persistence) for profiles and persistence, and the [README](../README.md#sample-data) for operating instructions.
- **Seed reason:** Fixed profiles make results reproducible; lookup keys and insert-only writes make interrupted runs resumable without resetting IDs, statuses, credentials, or history. Preserve the former demo separately rather than mixing it into the full dataset.
- **Time choice:** Store UTC instants and display public reading timestamps in Sri Lankan time, matching the operational local-day interpretation without shifting measurements.

## D11 - Controlled user seeding

- **Choice:** Provision the 36 configured admin/analyst accounts through a separate setup command, resolving existing geographic public IDs and hashing passwords with salted scrypt. See the [architecture](architecture.md#user-seeding) and [README](../README.md#user-accounts) for the contract and operation.
- **Reason:** Keeping account setup separate from synthetic readings avoids coupling credentials to dataset generation. Insert-only email upserts preserve subsequent password rotations and access changes. Complete-document validation and transactional verification protect jurisdiction constraints and prevent partially provisioned accounts.
- **Credentials:** Use the ignored `seed-users.env` as the account source and `.env` for database configuration. Do not expose passwords/hashes or add user-management routes.

## D12 - User credential exchange

- **Choice:** Implement only the user/admin token exchange with HS256, a private environment signing key, configured issuer/audience, and a bounded short lifetime. Use MongoDB fields for all authorization claims and the standard `sub` claim for the public UUID. Use [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) for signing.
- **Reason:** Reuse seeded salted scrypt hashes, prevent request-supplied privilege claims, and keep tokens independent of internal MongoDB identity. Identical invalid-credential errors and dummy password derivation reduce account disclosure; no-store responses prevent credential caching.
- **Limits:** Adopt the initial 5-attempt/15-minute IP/account threshold for this endpoint with atomic shared MongoDB counters. Other rate thresholds and deployment/proxy configuration remain pending. Device authentication and refresh tokens remain outside this feature; subsequent protected-route verification is covered by D13.

## D13 - Current-user verification and the first protected read

- **Choice:** Verify user JWTs and reload stored identity/access on every protected request; attach a credential-free current principal. Start with the existing architecture's province collection and reuse shared counters for 120 reads/minute per User.
- **Reason:** A valid signature does not establish that the User still exists or retains the token's role/jurisdiction. Scoped database filters and counts prevent leakage; principal-specific private validators prevent stale or foreign cache validators bypassing current access.

## D14 - Development device credential derivation

- **Choice:** For development only, derive each installation password from the private `.env` common prefix followed by its exact meter ID. Use the same salted scrypt format and verification helper as user passwords. Credential replacement requires an explicit setup operation.
- **Reason:** This avoids managing 220 separate development secrets while retaining normal password verification against stored hashes. Prefix compromise exposes all derived device passwords, so production devices must have independent credentials.
- **Reruns:** New installations use this derivation by default. Existing hashes, statuses, IDs, ancestry, and readings remain unchanged on normal seed reruns; prefix changes require explicit credential replacement. Device token issuance is covered by D15; credential replacement remains outside the HTTP API.

## D15 - Device credential exchange

- **Choice:** Verify submitted meter credentials against the stored scrypt hash, then allow token issuance only for active installations. Reuse user-token HS256 configuration and response shape, with installation-only claims and separate shared IP/meter login counters.
- **Reason:** Stored-hash verification supports both development-derived and independent production secrets. Credential verification before status prevents disclosing inactive installations to clients without valid secrets. Actor separation keeps installation tokens out of user reads.

## D16 - Current-installation verification and ownership

- **Choice:** Reuse cryptographic bearer checks, require the installation actor and exact write scope, reload installation state by its public UUID, and attach only the authenticated public ID. Apply a separate URL ownership check after authentication.
- **Reason:** Unexpired tokens must lose access when the installation is deleted or inactive; token claims cannot override current stored state or permit another installation's writes. Keep user and installation principal lookups separate.

## D17 - Transactional device reading submission

- **Choice:** Coordinate installation-bound reading insertion and lifecycle changes through a real parent-document write in the same transaction. Use the shared device limits from the [architecture](architecture.md#rate-limits).
- **Reason:** Authentication alone cannot stop concurrent deactivation/deletion. A shared parent document write serializes ingestion with lifecycle transactions and protects history from orphaning; timestamp uniqueness prevents overwrites.
- **Validation reason:** Explicit-zone timestamps avoid server-timezone ambiguity; millisecond precision preserves timestamp identity in BSON dates. Measurement ceilings and clock-drift/age bounds require domain decisions before enforcement. Input rules belong to the [HTTP contract](API_DESIGN_RULES.md#device-reading-submission).

## D18 - Individual reading access and validators

- **Choice:** Resolve current user jurisdiction through the complete installation ancestry before a reading lookup bound to both URL UUIDs. Preserve inactive history and distinguish forbidden jurisdiction access from missing resources.
- **Reason:** A globally unique reading UUID alone does not establish ownership or regional access. Ancestry authorization before representation construction prevents reading data and validator disclosure. Explicit forbidden responses make jurisdiction failures distinguishable from missing-resource failures; they may reveal that the parent installation exists.
- **Validator reason:** All authorized readers receive the same immutable reading representation, so POST and GET share its strong ETag. Private caching and renewed authorization on every request prevent a cached tag from bypassing changed access.

## D19 - Installation history pagination and caching

- **Choice:** Reuse installation ancestry authorization for reading lists and calculate count/page in one read snapshot. Default to newest-first order using the existing history index.
- **Reason:** Concurrent ingestion must not produce a count from one dataset and a page from another. Public-ID tie-breaking gives deterministic ordering; a context-aware full-envelope ETag tracks filters, paging, count and current access.
- **Time validator:** Omit collection Last-Modified without a reliable revision covering the entire response. A page's maximum receivedAt cannot establish when count, membership, links or authorized context changed.

## Pending decisions

| Topic | Decision needed |
| --- | --- |
| Measurement validation | Set meter clock-drift and measurement bounds. |
| Energy counter resets | Finalize reset/baseline behavior for district energy calculations. |
| Deployment | Choose the deployment provider and HTTPS configuration. |
| Rate thresholds | Confirm or revise thresholds for remaining traffic classes; user/device token issuance uses 5 attempts/15 minutes and protected user reads use 120/minute, and device ingestion uses the initial 30/minute per installation and IP. |
