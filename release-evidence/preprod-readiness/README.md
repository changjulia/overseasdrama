# Pre-production readiness evidence

- Audit date: 2026-08-31 (Asia/Shanghai)
- Scope: repository/local runtime evidence only
- Release candidate inspected: `3944d05dc0da8b36376a9040fd7e409a25ea4116`
- Decision: **NO-GO**
- Safety boundary: no deployment, push, migration, queue mutation, credential read/creation/rotation, or signed URL request was performed.

## Files

- `current-checks.json`: sanitized, machine-readable result summary.
- `risk-register.csv`: P0/P1 blockers and required closure evidence.
- `attestation.schema.json`: minimum structure for operator-supplied drill evidence.
- `templates/*.example.json`: examples only; they do not satisfy the pre-production gate.
- `attestations/README.md`: accepted filenames and anti-bypass rules.

The current audit proves selected local contracts and read-only runtime checks. It does not prove the target pre-production topology, cloud control-plane settings, real alert delivery, backup restoration, peak capacity, or production deployment policy.

Run the fail-closed gate with:

```bash
bash scripts/preprod-readiness-check.sh
```

The gate never prints secret values. A non-zero exit is expected until all P0 controls have real evidence.
