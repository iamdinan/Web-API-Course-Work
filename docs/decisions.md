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
- **Status:** This lifecycle is designed but not yet implemented. Its implementation must include the agent verification requirements in [AGENTS.md](../AGENTS.md).

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

## Pending decisions

| Topic | Decision needed |
| --- | --- |
| Response-header instruction | Clarify whether “curl response headers” means curl evidence, CORS headers, or both. |
| Measurement validation | Set meter clock-drift and measurement bounds. |
| Energy counter resets | Finalize reset/baseline behavior for district energy calculations. |
| Deployment | Choose the deployment provider and HTTPS configuration. |
| Rate thresholds | Confirm or revise the initial architecture thresholds before implementing shared limits. |
