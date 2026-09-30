# spikes (historical)

Frozen proof-of-mechanism work, kept as evidence rather than as something to run. These scripts
were used to prove against the real Canton 3.5 binary, before any of it went into `agent/`, that:

- an external party survives the real death of its hosting participant and can be re-hosted
  elsewhere with only a signature from its own key;
- its state can be moved along with it (`repair.export_acs` / `import_acs`);
- it can act as a signatory, not only as an observer.

They target a throwaway extra participant (`participant5`) and hard-coded ids from those runs, so
they won't work against a fresh `make demo-reset` environment as they stand. The production
versions of these mechanisms are in `agent/src/rehostParty.ts`, `externalParty.ts` and `recover.ts`.
The chronological log is in [`external-party/FINDINGS.md`](external-party/FINDINGS.md), and the
resulting design is in [`docs/DECISIONS.md`](../docs/DECISIONS.md).
