# TODO: maestro-action

**Open:** 1 · **Next ID:** 4

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

#### 3. A YAML 1.1 boolean reads as its word, not as true or false

- **Needs:** ready · **Repos:** maestro-action, platform-cli
- **Where:** `yamlSettings` in `src/logPolicy/extract.ts`; the CLI's YAML extraction in `internal/cirules`
- **Failure mode:** both interpreters parse YAML 1.2, so `OTEL_JAVAAGENT_DEBUG: yes` or `debug: on` reads as the
  word. SnakeYAML (Spring) and go-yaml v2 (Kubernetes, Helm) read YAML 1.1, where it is `true`, so an `otel_true`
  rule misses it. REASONED: an unquoted boolean in a Kubernetes `env` value is refused by the API server, so the
  reachable case is a Spring YAML file or a Helm value a template quotes.
- **Fix:** parse deployment YAML as 1.1 (`version: '1.1'` here; map `yes`, `no`, `on`, `off`, `y` and `n` to
  `true` or `false` in the CLI), with one shared case in each suite.
- **Options:** (a) parse as YAML 1.1 in both interpreters: matches the readers that apply the files, costs a
  parity test in each; (b) leave 1.2 and document it: no code, keeps the miss.
- **Recommendation:** (a), since the deployment readers are YAML 1.1 and the cost is two small changes.
