# Accepted pre-production attestations

This directory intentionally contains no passing attestation yet. The fail-closed checker accepts these exact filenames only after the corresponding drill has actually run. Each file must declare `result=passed`, match the current release commit, contain non-empty evidence and redaction confirmations, and identify different operator/reviewer values:

- `backup-restore.json`
- `monitoring-alerts.json`
- `worker-capacity.json`
- `migration-rollback.json`
- `deployment-policy.json`

Rules:

1. Validate each file against `../attestation.schema.json` and its control-specific acceptance criteria.
2. `operator` and `reviewer` must identify different people or independently accountable roles.
3. Evidence must reference sanitized screenshots/logs/manifests; never embed keys, JWTs, signed query strings, passwords or raw environment dumps.
4. Empty objects, copied examples, planned dates, synthetic “passed” values and local-only dry runs do not satisfy the gate.
5. A failed or expired drill remains `failed`; do not delete it to hide history. Add a new version and link the remediation.
