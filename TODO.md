# TODO: maestro-action

**Open:** 2 · **Next ID:** 6

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

#### 4. The Action and the CLI read a few unusual deployment files differently

- **Needs:** ready · **Repos:** maestro-action, platform-cli
- **Where:** `extract` in `src/logPolicy/extract.ts` and `findingsOf` in `src/steps/ciCheck.ts`; `Extract` and `FindingsOf` in
  the CLI's `internal/cirules`
- **Failure mode:** the two interpreters report the same findings on every case both suites share, but REASONED from
  source they can still differ on: YAML the two parsers accept differently (malformed indentation, a tag or anchor on
  its own line); a name holding a character whose lower case differs between JavaScript and Go; a `.properties` value
  with a `\uXXXX` escape; a Dockerfile with an `# escape=` directive; an exec-form element that is not a string;
  whitespace JavaScript's `trim` and Go's `TrimSpace` treat differently (U+FEFF, U+0085); and, past `FINDINGS_MAX`, the
  order of two findings on one line from a Spring JSON object or of paths with characters outside the Basic
  Multilingual Plane. A difference shows as a check that passes in one and fails in the other on the same files.
- **Fix:** add each case to both suites from one shared fixture and align the side that differs.
- **Options:** (a) a shared fixture of these cases run by both suites: catches each difference once, costs a fixture
  and a runner in each repo; (b) align each by hand as found: no fixture, a difference stays possible.
- **Recommendation:** (a), since the shared rule suite already shows a shared fixture keeps two interpreters equal.

#### 5. A setting inside a Spring config file carried in a Kubernetes ConfigMap is not checked

- **Needs:** capability · **Repos:** maestro-action, platform-cli
- **Where:** `walkYaml` in `src/logPolicy/extract.ts`; the CLI's YAML walk in `internal/cirules`
- **Failure mode:** a ConfigMap whose `data` holds `application.yaml: |` or `application.properties: |` is read as one
  string value, so `logging.level.root: DEBUG` inside it is no finding, and a check of a repository that configures
  Spring this way passes. REASONED from source; both interpreters read the embedded text as one value.
- **Fix:** read a `data` value whose key ends in `.yaml`, `.yml` or `.properties` as that kind of file, with its lines
  offset to the ConfigMap's, in both interpreters.
- **Options:** (a) read the embedded file in both: closes the miss, costs the offset handling and a shared case;
  (b) document that embedded config is not read: no code, keeps the miss.
- **Recommendation:** (a), since mounting Spring config from a ConfigMap is a common Kubernetes shape.
