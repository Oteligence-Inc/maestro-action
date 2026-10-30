# TODO: maestro-action

**Open:** 1 · **Next ID:** 7

Open bugs only. Severities reflect verified impact, not the original audit label.
A ticket is the facet line plus Where, Failure mode (the repro), and Fix. Essays belong in
`README.md`, `CLAUDE_CONTEXT.md`, or a comment next to the code.

Forward-looking only: a finished item is **deleted**, not annotated (git history holds it), and a
partial fix is rewritten as a **narrowed residual**. Numbers are **stable, sparse ids other repos
cite**: never renumber, never re-use a gap. Severity lives in the section heading. The line above is
machine-maintained: run `python3 platform-overview/scripts/check-todos.py --fix-header maestro-action`
from the work root rather than editing it. **The trailing repo name is the scope argument and is
not optional:** unscoped, that command rewrites every register it finds.

    #### 1. One-line problem statement, present tense, naming the symptom

    - **Needs:** decision · **Repos:** maestro-action
    - **Where:** `functionName` in `src/...`, never `file:line`, which drifts on every edit
    - **Failure mode:** what breaks, for whom, and how it would be noticed
    - **Fix:** the concrete change, or **Decision needed:** the closed question with its options

**`Needs`** is what the item waits on, and may list several. `decision` · `approval` · `input` **block**;
`capability` · `upstream` · `vendor` · `ready` queue; `ready` means the item was checked and nothing blocks it. Label any
*mechanism* sentence **PROVEN** / **OBSERVED** / **REASONED**.

**Add:** take `Next ID`, then raise it. **Remove:** delete an entry only once a failure-first test of
its *canonical* scenario passes and the fix's trigger is confirmed to be produced; otherwise rewrite
it as the narrowed residual, keeping its number. Never cite a number from code or a code comment.

Cross-repo items (the `v0` tag move and the pin bump in the platform's `maestro-deploy.yml` copies) live
in `platform-overview/TODO.md`.

---

## LOW

#### 6. A run that fails at the stale-peer check has already registered its JAR

- **Needs:** ready · **Repos:** maestro-action
- **Where:** `run` in `src/index.ts` (`registerJarForEnv`, then `warnStalePeers`)
- **Failure mode:** REASONED. With `fail-on-warnings: true`, a run whose analysis makes a peer stale throws in `warnStalePeers` after `registerJarForEnv` has committed the JAR, so the customer's pipeline stops before its deploy step while the environment records the new JAR as the service's. job-manager then checks debug windows and names attribution against that run's build, and staleness compares against a JAR that never deployed.
- **Fix:** call `warnStalePeers` before `registerJarForEnv`. The stale-peer read keys on the analysis job, not on the registration, so its answer does not change; then rebuild `dist/`, and move the platform's `maestro-deploy.yml` pins and the `v0` tag as for any release.
- **Options:** (1) move the check before the registration: a run that fails registers nothing; (2) keep the order and say in the README that a `fail-on-warnings` failure has already registered the JAR: no release, but the platform keeps reading an undeployed JAR.
- **Recommendation:** (1), a failed run should leave the environment as it found it.
