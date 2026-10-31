# TODO: maestro-action

**Open:** 1 · **Next ID:** 9

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

## MEDIUM

#### 8. Customers' `@v0` does not set aside a build's side files or note a JDK AOT cache until the Action is released

- **Needs:** approval · **Repos:** maestro-action, oteligence-frontend
- **Where:** the floating `v0` tag (`release.yml`, moved by a pushed `v0.x.y` tag); `pickJar` in `src/steps/upload.ts` and `aotNotes` in `src/logPolicy/aot.ts` are on `main` only
- **Failure mode:** **OBSERVED**: `git show v0:src/steps/upload.ts` still refuses any glob matching two files ("v0 expects exactly one JAR per invocation"), so a shade or Gradle Boot build's first CI run fails as before, and no AOT notice is printed. The frontend's Help describes the new behaviour and keeps the old refusal as a troubleshooting row until then.
- **Fix:** push the next `v0.4.x` tag from `main` once this work is merged; `release.yml` re-tests, releases and moves `v0`.
- **Options:** (a) release now: every `@v0` pipeline gets the set-aside and the notes on its next run, and the published behaviour changes for anyone pinned to `@v0`; (b) release with the prod UI deploy that ships the matching Help: Help and `@v0` change together, and `@v0` keeps the refusal until then.
- **Recommendation:** (b), because Help's Action rows describe `@v0` and the two then change at once.

## LOW
