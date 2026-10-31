# maestro-action: architecture and contracts

The customer-facing GitHub Action for Maestro's Step 6. It runs in the customer's CI after their JAR build, drives
the platform's API through the gateway with a short-lived token minted from their API key, and leaves the generated
extension bundle and configs on the runner for their image build. All analysis and generation happens server-side.

## Layout

| Path | Purpose |
|---|---|
| `action.yml` | Inputs, outputs, `runs: using: 'node24'`, `main` `dist/index.js` and `post` `dist/post/index.js` (no `post-if`, so it runs on every outcome). |
| `src/index.ts` | `run()`: the step order below, the removed-service guard, the two opt-in degradations (`skip-on-removed-service`, `skip-generate-on-inactive`), and the deploy-run report at start and end. |
| `src/post.ts`, `src/postMain.ts` | The post step, its own bundle so it can never run the pipeline. `post()` acts only while `deployRunProjectUid` is set (a run Maestro has not accepted as completed): it re-authenticates and reports the run completed with the `deployRunConclusion` the main step last tried to send, or `cancelled` when the main step was stopped before it got that far (a cancel, or a timeout, which therefore reads as cancelled). Warns when it cannot report, and never fails the step. |
| `src/inputs.ts` | `parseInputs`: reads the inputs, requires `project` or `project-id` and `api-url` (there is no default API), and holds `api-url` to `https://` on an `*.oteligence.com` host, or, when `trusted-api-host` names a hostname, on exactly that host. |
| `src/api.ts` | `MaestroApi` over `@actions/http-client`: bearer auth, retry on transient failures (`util/retry.ts`), signed-URL reads and writes without the auth header and over https only (`requireHttps` refuses another scheme by name, never echoing the URL), `expectOk` mapping a 402 `subscription_inactive` to `SubscriptionInactiveError`, a 403 `reader_read_only` to `ReaderKeyError` and a 403 `key_scope` (the run named a project or environment outside the key's scope) to `KeyScopeError`, each read flat or under `data`. |
| `src/steps/` | One module per step, each with its own suite under `tests/steps/`. |
| `src/ciRules.ts` | The log policy rule set's types and its evaluation: a copy of discrete-job-functions' djf-core `CiRules.evaluate` (`fold`, `matches`, `passesTest`), `unreadable` (the version and test check that makes an unknown rule set fail loudly), and `CASES_DIGEST`, the SHA-256 of the fixture suite copy in `tests/fixtures/ci-rules/` this release was tested against. |
| `src/logPolicy/extract.ts` | The settings a deployment file holds, with path and line: YAML (Kubernetes `env` entries, compose `environment`, nested keys read as their whole path and each tail of two or more segments, and the bare child of an `environment`, `env`, `data` or `stringData` map; anchors, aliases and `<<` merge keys (`!!merge <<` too) followed (`aliasTargets` resolves each alias once per document to the latest anchor before it, and refuses an undefined one or an anchor name outside `[0-9A-Za-z_-]`, as yaml.v3 does; `entries`, a mapping's own key first, merges nested at most `DEPTH_MAX` deep, up to `ALIAS_NODES_MAX` nodes read through aliases, checked before resolving, named at the outermost alias's line); every Secret `data` value base64-decoded (CR and LF ignored) before it is read; a `data` or `stringData` value whose key ends in `.yaml`, `.yml` or `.properties` read as that file from the bytes a mounted copy holds (`readEmbedded`: a literal block's lines at their own lines, any other value's at its key's line, one level deep); Helm templates with their actions removed and their line count kept), Dockerfile `ENV`, `CMD` and `ENTRYPOINT` (the `# escape=` directive honoured; each exec-form element read as one argument when it starts with `-`, else as a command line, and an exec form holding anything but strings a problem), `.env` and `.properties` files (`property` splits a line and reads its escapes as `java.util.Properties` does; a malformed `\u` escape names the line), command lines (`-Dk=v`, `--k`, split at ASCII whitespace) and `SPRING_APPLICATION_JSON`, read around its placeholders. `decode` reads a `.properties` file as ISO-8859-1 and any other as UTF-8; a YAML file that is not valid UTF-8 is not read, and a Dockerfile or env file that is not is read as ISO-8859-1, each with a problem. `lines` splits at CRLF, CR or LF; a leading byte order mark is dropped. Trims and splits use `SPACE`, Go's `unicode.IsSpace`, so the CLI reads the same characters as whitespace. The names one key is read as share an `origin`, so a setting gives one finding per rule. A file it cannot parse, or past `SETTINGS_MAX` settings, `DEPTH_MAX` nesting or `ALIAS_NODES_MAX` alias nodes, is a `Problem` by path and line, never its text. A YAML document that does not parse is a problem at its section's first line, and the rest of that `---` section is not read, as yaml.v3 stops there; a document after `...` without its own `---` is refused, as yaml.v3 refuses it; before naming a part, `parsed` re-indents (`reindent`, one reparse per collection) every line of a flow collection or quoted scalar the parser ended before its closing character (found by `closing`, not by the error message, which the parser omits when the cut line ends in an escaped quote), which is how the `yaml` parser treats one continued at or below its key's indentation and every deployment reader and yaml.v3 read, unless one of those lines is a document marker; a `%YAML` line is blanked first (`withoutYamlVersion`), so every file is read under one schema, as the CLI reads it. A node is placed at its content's line, not its anchor's or tag's. The template patterns (`{{...}}`, `${...}`) are replaced by `replaceTemplates` in one pass, and every regular expression on file text runs in linear time. |
| `src/logPolicy/aot.ts` | `aotNotes`: the lines of a deployment file that start the JVM with a JDK AOT cache (`-XX:AOTCache=`, `-XX:AOTCacheOutput=`, `-XX:AOTMode=` other than `off`, as a token, comment lines skipped), one note per line naming the flags; whitespace is ASCII only and a leading byte order mark is dropped, as in the CLI. `scan` collects them beside the settings (with `settings` false, only them, for an environment whose check is off, over the files the mapping gives the service) and `report` emits each as a `core.notice` on its file and line; a note never enters the findings or the verdict. The CLI's `AOTNotes` reads the same cases: each repo holds a copy of `tests/fixtures/ci-rules/aot-cases.json` and pins its SHA-256 (`tests/logPolicy/aotCases.test.ts`), so a case changed in one copy fails until the other is changed to match. |
| `src/steps/ciCheck.ts`, `src/steps/checkOnly.ts` | The log policy check. `runCheck` returns a `CheckRun` (outcome, result, reason) and never throws a failed check: the rule set from `GET .../envs/{env}/ci-rules?service=&versions=1&lockedVersionUid=`, the tracked files (`git -c core.fsmonitor=false ls-files`, `readRepo`) less links, oversized and NUL-holding files and, without a mapping, `SKIPPED` paths, the `.maestro/check.yml` mapping (`readMapping`: tracked, regular, contained, at most `MAPPING_MAX_BYTES`, no control characters, parsed silently as one document with its `%YAML` line blanked and refused on any parse error, a duplicate key
included; non-empty strings; each path through `globRefusal`, one linear pass that refuses the glob syntax the CLI's
`Glob` would read otherwise and braces past `GLOB_PATTERNS_MAX` patterns; `filesFor` compiles each glob once), findings, the verdict as job-manager decides it, the annotations and job summary, and the `CheckResult` the build carries. With no checkout it fails in `FAIL`, and in a check-only run in either enforcing mode; a mapping that maps no tracked file to the pair fails where the mode enforces. `logPolicyCheck` is the build's call, which sets the outputs and throws a failed run before the upload. `checkOnly` runs `runCheck` for each mapped pair, catches every error per pair, and aggregates the outcome and the findings of every pair, failed ones included. `printable` shows control characters as `?` in anything it logs from an input, a mapping or the server. `findingsOf` gives a finding two sources give once (an anchor read where it stands and through an alias) and sorts by path in UTF-16 code-unit order, line, rule and name, as the CLI sorts. |
| `src/util/errors.ts` | The only messages that reach the log. `formatError` never echoes a response body or stack. |
| `dist/` | The two ncc bundles GitHub executes, `dist/index.js` and `dist/post/index.js`; committed, and `ci.yml` fails when either is stale. |

## Flow and the endpoints it calls

1. `auth`: `POST /api/auth/cli/token` with the API key (plus `orgId` from the `org-id` input when set), keeping the
   JWT. A refusal with `code` `org_required` names the `org-id` input; any other 403 with a message reports the
   server's reason. The log line names the key's scope from the response (`scopeKind`, `scopeProjectUid`,
   `scopeEnvName`): a project, or one environment of it. A scoped key's tenant-projects listing holds only its
   project.
2. `resolveLockedConfig`: `GET /api/auth/tenant-projects`, page by page until the project name or `project-id`
   matches, or a page is empty or does not say another follows (refused past 1000 pages; an empty body is an error,
   not a missing project), then
   `GET /api/job-manager/projects/{uid}/envs/{env}/locked`, whose `uid` is the `lockedVersionUid` (read with the selection, so a lock taken between two reads cannot pair one version's selection with the next one's uid; `.../versions`, newest first, only when job-manager returns no `uid`).
   A 404 on `locked` means the environment does not exist; a 200 with `data: null` means it was never locked; an empty
   or unparseable 200 is reported as an empty response.
2b. `logPolicyCheck`, after the in-progress deploy-run report and before the upload: `off` returns null; outside a git
   checkout it warns and returns null (the build then carries no check), except in `FAIL` mode, where it throws
   because job-manager would refuse a build with no check; a mode that fails the findings throws a `UserError`, so
   nothing is uploaded. The result goes on the build submit as `requestJson.ciCheck`. With `check-only` set,
   `run()` calls `checkOnly` right after `auth` (step 1) and returns, so steps 2 to 7 never run.
3. The removed-service guard: once the lock's `registeredJars` is non-empty, a `service` input it does not contain is
   refused before any upload, listing the registered names.
4. `uploadJar`: the glob's matches, sorted, go through `pickJar`, which uploads a single match whatever its name and,
   of several, sets aside `original-*.jar|war`, `*-plain.jar|war`, `*-sources.jar`, `*-javadoc.jar` and `*-tests.jar`,
   refusing unless exactly one remains; `POST /api/file/artifact/upload/batch` with this JAR plus the other registered
   services, each named by the `artifactUid` its lock entry froze (resolved in any of the org's projects for an
   organization key, in the key's own project for a scoped one, where another project's is a 403 `key_scope`; a 404
   when gone) or, for an entry with none, by SHA in this project (skipped on a miss); a signed `PUT` of the bytes when the
   server asks for them; `PUT /api/file/artifact/status`.
5. `submitAnalysis` and `submitBuild`: `POST /api/job-manager/jobs` for `MULTI_JAR_ANALYSIS`, then
   `MULTI_JAR_EXPLORER_BUILD` with the profile `buildProfileFromLocked` derives from the lock (an auto SKIP entry and a `user_removed`
   entry are left out, a user-ticked SKIP entry is built, and a method selected in several flows is configured
   once). The build request carries `projectUid` and `requestJson.envName` (`ResolvedConfig.envName`, the `environment`
   input), because job-manager resolves the build's environment from them and refuses an unknown name (409
   `build_env_not_found`), and `requestJson.service` (the `service` input, the name the JAR is registered under), from
   which job-manager chooses, per service, the newest build that deployed it; `pollJob` on
   `/api/job-manager/jobs/{id}/status` after each. A FAILED or NO_ASSET job throws `JobFailed` carrying the status's
   `customerReason` (control characters collapsed, 500 characters at most) when job-manager gives one. A job id
   that is not letters, digits, `-` and `_` is refused at submit (`extractJobId`), since it becomes a path segment
   under `RUNNER_TEMP` and a log line.
6. `readAnalysisOfUpload` (called after the analysis completes and before the build is submitted): the analysis
   preview (`/jobs/{id}/preview`, then its signed JSON) gives the uploaded JAR's `serviceKey` (its name, or
   `name@<8 hex>` when uploads share a name) and display name, its `notices` (what the analysis left out of the
   JAR) and its `warnings` (each in-app tracer the service bundles beside the agent); `run` emits one `core.warning`
   per notice and one per warning, the latter as `Before you deploy <service>: ...`.
6b. `reportDrift` (`src/steps/drift.ts`), right after `submitBuild` returns `{jobId, drift}` and before the build is
   polled: job-manager's drift of the build from its lock. One `core.warning` per kind of drift for the services
   `readAnalysisOfUpload` named, or for every service when it named none (the method names only inside
   `core.warning`, which escapes workflow commands), a note on that warning when `engineChanged` or `goalsChanged`,
   one `core.warning` naming `unmatchedServices`, one for `unbound`, peers as one count line, and `core.info` for no
   drift and for a drift job-manager could not compare. A missing `drift` (an older job-manager), or a compared one
   whose `services` is not an object, prints nothing. Drift never fails the step, `fail-on-warnings` included.
7. `downloadArtifacts`: `/jobs/{id}/download`; empties the job's folder, extracts the bundle and writes this service's
   `javaagent.config`, chosen by the analysis key, then the `service` input, then a unique letters-only match. It returns
   the response's `buildRecord` (`undefined` when the field is absent, a server older than build records; `null` when
   the build has none) and the bundle names job-manager gives the two configs (`fileName`, `collectorConfigFileName`).
   A failure after the folder is emptied removes it again, so no unverified file is left.
7b. `verifyBuild` (`src/steps/verify.ts`): accepts only a well-formed record whose status is `recorded` or `matched`,
   which names the uploaded JAR's SHA, whose `bindings` bind the analysis's key for the upload (`serviceKey`, the
   first of `readAnalysisOfUpload`'s names) to that SHA (a run whose analysis named no key is refused), and whose
   `files` hash-match every extracted file (by its `/`-separated path: the walk enters folders, since the bundle ships
   each extension JAR's Java source under `sources/<JAR name without .jar>/`; no extra or missing file, no link, no
   empty folder) and both downloaded configs. A record file name must be a relative path with no empty, `.` or `..`
   segment and no backslash. `LEFT_OUT` (the annex, the lock record, the two summaries, `build-statement.json` and
   `build-statement.sig`) mirrors discrete-job-functions' `BundleFiles.UNCOVERED`, applies to top-level names only,
   and is carried here, not taken from the server; a record that covers one of them is refused by name.
   The signature (`checkSignature`) runs after the record's status check and before the bindings and file checks.
   With `signing-public-key` (`Inputs.signingKey`, parsed by `parseSigningKey`: PEM or base64 SPKI DER, Ed25519
   only, a private key refused; `require-signed-build: true` makes an empty one an input error) the bundle must carry `build-statement.json` and `build-statement.sig`; the
   statement's `signingKey` must be the key's fingerprint (`keyFingerprint`: `sha256:` and the hex SHA-256 of its
   SPKI DER), the signature must verify over the statement's bytes (`crypto.verify(null, ...)`), its `schema` must
   be `oteligence.build-statement/1`, its `lockedVersionUid` must be the lock this run resolved, and its
   `inputsDigest`, `applicationJars` (as a set), `bindings` and `files` must equal the record's, so every later check
   holds the files to the signed record. Without the input, a bundle carrying both files is `not-checked` and any other
   is `unsigned`; nothing is refused for it. The signature covers what the record covers and anchors the lock only
   to the uid the server reported, so it catches tampering after the build, not a platform that builds from inputs
   it chose. `run` sets `build-signature` to the outcome. Hosted Maestro's production key is published in the
   README (*Hosted Maestro's signing key*), on GitHub rather than on the platform that signs with it; Maestro's Help
   names its fingerprint and links there, so the README section's anchor is a contract with the frontend's
   `ACTION_README_URL`. A private-cloud installation's key comes from its own VM.
   A refusal is a `BuildVerificationError` (a `UserError`), the downloaded files (the bundle and both configs) are
   deleted, and nothing registers.
8. `warnStalePeers`: `.../envs/{env}/staleness`, warning (or failing, with `fail-on-warnings`) for peers this run's
   analysis made stale. It runs before the registration, so a run it fails registers nothing.
   `registerJarForEnv`: `PUT .../envs/{env}/services/{service}/jar` under the `service` input. It warns when the
   analysis key differs from the `serviceKey` the lock's `registeredJars` recorded for that registration; for a lock
   that recorded none, when the analysis names the JAR differently from the registration; and when a lock from
   before per-JAR keys files a shared-name pair's selection under the shared name.
9. `reportDeployRun` posts to `.../deploy-runs` at start and end, best-effort. The in-progress
   report sets the `deployRunProjectUid` state before its request; a completed report sets `deployRunConclusion` before
   its request and clears `deployRunProjectUid` only on a 2xx, so the post step closes a run that was stopped or whose
   final report failed. job-manager's CI matrix reads a `cancelled` conclusion as a cancelled cell.

## Contracts with the platform

- **Naming.** The lock and build key a service by the analysis's name for its JAR (DJF's `ArtifactKeys`, carried
  on the preview's `ServiceSummary` as `name` and `serviceKey`). The wizard creates the environment's registrations
  and the lock freezes them as `registeredJars`; the action registers under the `service` input, and the guard
  checks that input against the latest lock. A `serviceKey` of the form `name@<8 hex>` follows the JAR's class
  content, so the action never registers under it or advises it.
- **Billing.** A 402 `subscription_inactive` is `SubscriptionInactiveError`; with `skip-generate-on-inactive` the step
  exits 0 with `generated=false`. Other 402 codes fail the step with the server's message.
- **Callers.** The platform's six `maestro-deploy.yml` workflows pin this action by commit SHA and pass their
  `spring.application.name` as `service`.
- **Build record.** job-manager's download returns `buildRecord: {status, inputsDigest, applicationJars, files,
  firstJobId, bindings}` (lower-case hex SHA-256; `bindings` maps each service key to the upload the build bound to it) from the tenant's `build_records` row discrete-job-functions' build wrote.
  An Action release that verifies must reach customers (the `v0` tag) only after the servers it talks to return the
  record with its `bindings`: a server with no `buildRecord` is refused with "does not record its builds", and one
  whose record has no `bindings` with "does not record which upload it built each service from". The record may also
  carry `signature: {status, key, value}` (job-manager copies it from the build's result); the Action reads the
  signature from the bundle, never from this field.
- **Sources and signature in the bundle.** A job-processor whose discrete-job-functions ships `sources/` puts
  folders and `/`-separated record names in the bundle, which an Action from before that change refuses ("which is
  not a file", "malformed"). So this Action, and the six `maestro-deploy.yml` pins of it, must move before such a
  job-processor deploys. The key the workflow supplies must come from the operator's records: the private-cloud
  installer prints it once, and a job-processor that holds a key logs its public half at startup.

- **Log policy check.** job-manager's `GET .../envs/{env}/ci-rules?service=&versions=1&lockedVersionUid=` (the
  Action sends the lock it builds) serves `version`, `mode` (`OFF`, `WARN`, `FAIL`, `FAIL_ON_NEW`), `floor`,
  `exporter`, `lockFree`, `rules`, `digest`, `casesDigest`, `lockVersion`, `baseline` (the fingerprints
  `rule|name|path` of the service's first checked build, or null) and `packaged` (`matched`, `not_recorded`, `absent`,
  `unread`, `not_read`). It answers 400 `ci_rules_service_required`, 404 `ci_rules_service_unknown` (the locked
  analysis holds no such service) or `ci_rules_lock_unknown`, 409 `ci_rules_version_unsupported`, and 503
  `ci_rules_unavailable` when the locked analysis cannot be read and the mode enforces; `fetchRules` words the two
  404s. The build's
  `requestJson.ciCheck` is `{service, ruleSetDigest, total, findings: [{rule, name, path, line}]}` with at most 500
  findings, each name shaped by `findingName`; job-manager refuses a digest that is not the one it serves now (409 `ci_check_stale`), a check in the wrong
  shape (400 `ci_check_unreadable`) or a service its locked analysis does not hold (409 `ci_check_service_unknown`) where the mode enforces, and decides the build by the mode and each rule's severity (409
  `ci_check_required` / `ci_check_failed`); `verdict` in `src/steps/ciCheck.ts` makes the same decision before the
  upload. A finding's name must fold to `NAME` (`[a-z0-9._-]{1,200}`) and its path be repository-relative, so the
  extractor never sends another. The digest is opaque: the Action echoes it and never computes it. `casesDigest` is advisory: a mismatch
  warns, since this Action is pinned by commit SHA and must keep working when Maestro's copy of the fixture suite moves.
  The gateway admits the route for an API key in `CliRoutePolicy`.

## Tests

`npm test` runs jest with nock for HTTP and module mocks for `run()` (`tests/index.test.ts`), so the call-site wiring
is tested as well as each step. `tests/logPolicy/extractionCases.test.ts` runs the shared extraction cases
(`tests/fixtures/ci-rules/extraction-cases.json`: deployment files in, findings and problems out against the lock-free
rule set) through `scan` and `findingsOf`; the CLI's `internal/cirules/testdata/extraction-cases.json` is a
copy and both suites pin the same SHA-256. Each suite checks only its own copy, so a copy changed without its digest
fails that suite, and the two copies are kept equal by hand: a case is added by copying the file and the digest to
both repositories. `tests/postBundle.test.ts` runs the committed `dist/post/index.js` and fails if the
post bundle would run the pipeline.

**Proving the post step on a real runner.** A hosted cancel can take longer to reach the runner than the
Maestro step takes against hosted dev (about 20 seconds), so cancelling an E2E run usually lands after the step
has finished, and fractional `timeout-minutes` values do not fire. The step must be held open: push a
throwaway branch whose `dist/index.js` sleeps after the in-progress report, with a push-triggered copy of the
E2E job carrying a 1-minute step or job `timeout-minutes` (or cancel it by hand), read the run's
`Post Run ./` log and job-manager's `Recorded deploy run` lines, and delete the branch afterwards. The same
branch cut from `main` is the control. `e2e.yml` runs the action with `uses: ./` nightly against hosted dev: the CicdTest org's `maestro-action-e2e`
project, whose `dev` lock was made from the committed `fixtures/order-service-1.0.0.jar`; it fails unless the
`build-record` output is `recorded` or `matched`, so merge a change here only once hosted dev runs a job-manager that
serves build records.

**Running `dist/index.js` against devstack.** The action requires an https `api-url`, while devstack's gateway (`:8082`)
and MinIO (`:9000`) speak http. The signed upload and download URLs must be https too: `MaestroApi.requireHttps`
refuses any other scheme before sending anything, on every runner (a proxied runner used to send an http signed URL in
cleartext), so both services that sign storage URLs are pointed at the MinIO front.
`scripts/devstack-tls-proxy.mjs` fronts both (`:8443` and `:9443`, on 127.0.0.1 unless `TLS_PROXY_BIND` says
otherwise; the MinIO front keeps the Host header, which a presigned URL's signature covers; `TLS_PROXY_TAMPER=<text>`,
for tests only, flips the last byte of a MinIO response whose path holds the text, which the kit uses to show the
refusal), and file-service and job-manager, which sign upload and download URLs, are
restarted with `AWS_PRESIGN_ENDPOINT_URL` pointing at the MinIO front. From the work root, in bash or zsh:

```
mkdir -p /tmp/maestro-tls && openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/maestro-tls/key.pem -out /tmp/maestro-tls/cert.pem -days 2 -subj /CN=localhost -addext "subjectAltName=DNS:localhost"
node maestro-action/scripts/devstack-tls-proxy.mjs /tmp/maestro-tls/cert.pem /tmp/maestro-tls/key.pem   # long-running: background it
cp devstack/devstack.local.env /tmp/maestro-tls/local.env && echo AWS_PRESIGN_ENDPOINT_URL=https://localhost:9443 >> /tmp/maestro-tls/local.env
OTELIGENCE_LOCAL_ENV=/tmp/maestro-tls/local.env bash devstack/devstack.sh restart file-service
OTELIGENCE_LOCAL_ENV=/tmp/maestro-tls/local.env bash devstack/devstack.sh restart job-manager
env INPUT_TRUSTED-API-HOST=localhost NODE_EXTRA_CA_CERTS=/tmp/maestro-tls/cert.pem RUNNER_TEMP=/tmp/maestro-tls/runner GITHUB_OUTPUT=/tmp/maestro-tls/out.txt \
  INPUT_API-KEY=<ak_ key> INPUT_ORG-ID=<org id> INPUT_PROJECT=<project> INPUT_SERVICE=<service> INPUT_ENVIRONMENT=<env> \
  INPUT_JARS=<path to the service JAR> INPUT_API-URL=https://localhost:8443 node maestro-action/dist/index.js
```

**Running `dist/index.js` against a private-cloud VM.** The VM serves plain `http://<vm>:8080` and its presigned
URLs already point at https storage, so only the API needs a TLS front: start the proxy with
`TLS_PROXY_GATEWAY=<vm>:8080 TLS_PROXY_S3=none`, then run the same `env ... node maestro-action/dist/index.js`
line with `INPUT_ORG-ID` set to the VM organization's UUID. Create the files `GITHUB_OUTPUT` and
`GITHUB_STEP_SUMMARY` name before the run, as a runner does: the action fails at its last step if they are missing.

`<ak_ key>` is an API key created in the wizard's CI/CD step (or `POST /api/auth/users/api-keys`); `<org id>` is
needed when the key's account belongs to several organizations; the project's environment must be locked. Restore
devstack afterwards with `bash devstack/devstack.sh restart file-service` and `bash devstack/devstack.sh restart
job-manager`, without the variable, and stop the proxy: the browser cannot use the self-signed MinIO front.
