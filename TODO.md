# TODO: maestro-action

**Open:** 1 · **Next ID:** 2

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
`capability` · `upstream` · `vendor` queue; `queued` means no blocker was recorded. Label any
*mechanism* sentence **PROVEN** / **OBSERVED** / **REASONED**.

**Add:** take `Next ID`, then raise it. **Remove:** delete an entry only once a failure-first test of
its *canonical* scenario passes and the fix's trigger is confirmed to be produced; otherwise rewrite
it as the narrowed residual, keeping its number. Never cite a number from code or a code comment.

Cross-repo items (the `v0` tag move and the pin bump in the platform's `maestro-deploy.yml` copies) live
in `platform-overview/TODO.md`.

---

## MEDIUM — correctness, resilience, and operations

#### 1. The nightly E2E smoke fails on every run because the repo has no API key or URL secret

- **Needs:** input · **Repos:** maestro-action
- **Where:** the `e2e` job in `.github/workflows/e2e.yml` (`api-key: ${{ secrets.MAESTRO_API_KEY }}`, `api-url: ${{ secrets.MAESTRO_API_URL }}`)
- **Failure mode:** the `schedule` trigger runs nightly and fails at the action's first step with `Input required and not supplied: api-key`, so the job has never exercised the action against a platform. **OBSERVED:** all 103 recorded runs are `failure`; `gh secret list -R Oteligence-Inc/maestro-action` returns no secrets. A real regression in the action would land in the same red column and go unseen.
- **Decision needed:** (a) mint an API key in hosted dev for a project whose `dev` environment has a lock, and set `MAESTRO_API_KEY` and `MAESTRO_API_URL` (recommended: it is the only check that runs the action contract on a GitHub runner); (b) drop the `schedule` trigger and keep `workflow_dispatch`, accepting no nightly coverage.
