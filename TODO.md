# TODO: maestro-action

**Open:** 1 · **Next ID:** 8

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

#### 7. The upload refuses a glob that matches two jars, so the README's own example fails a shade or Gradle Boot build

- **Needs:** capability · **Repos:** maestro-action
- **Where:** `uploadJar` in `src/steps/upload.ts`; the `jars` example (`target/*.jar`) in `README.md`
- **Failure mode:** **REASONED**. `uploadJar` throws `UserError` when the glob matches more than one file. A Maven shade build leaves `original-*.jar` beside the shaded jar and a Gradle Boot build leaves `*-plain.jar`, so a customer copying the README fails their first CI run. Source: `platform-overview/documentation/market/research/aspire-java.md`.
- **Fix:** drop `original-*`, `*-plain`, `*-sources`, `*-javadoc` and `*-tests` jars from the matches before counting, and log the files skipped.
- **Options:** (a) skip the known side-artefact names: one filter and its tests; (b) prefer the jar whose manifest has `Start-Class` or `Main-Class`: reads each match's manifest, and a library jar has neither; (c) change the README example to an exact file name: docs only, and every customer still has to know their build's output.
- **Recommendation:** (a), because those names never hold the deployable, and the log line shows what was skipped.

## LOW
