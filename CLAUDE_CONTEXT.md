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
| `src/inputs.ts` | `parseInputs`: reads the inputs, requires `project` or `project-id` and `api-url` (there is no default API), and enforces an `https://` `api-url` on an `*.oteligence.com` host unless `MAESTRO_ALLOW_CUSTOM_API_URL=1`. |
| `src/api.ts` | `MaestroApi` over `@actions/http-client`: bearer auth, retry on transient failures (`util/retry.ts`), signed-URL reads and writes without the auth header, `expectOk` mapping a 402 `subscription_inactive` to `SubscriptionInactiveError`. |
| `src/steps/` | One module per step, each with its own suite under `tests/steps/`. |
| `src/util/errors.ts` | The only messages that reach the log. `formatError` never echoes a response body or stack. |
| `dist/` | The two ncc bundles GitHub executes, `dist/index.js` and `dist/post/index.js`; committed, and `ci.yml` fails when either is stale. |

## Flow and the endpoints it calls

1. `auth`: `POST /api/auth/cli/token` with the API key (plus `orgId` from the `org-id` input when set), keeping the
   JWT. A refusal with `code` `org_required` names the `org-id` input; any other 403 with a message reports the
   server's reason.
2. `resolveLockedConfig`: `GET /api/auth/tenant-projects`, page by page until the project name or `project-id`
   matches, or a page is empty or does not say another follows (refused past 1000 pages; an empty body is an error,
   not a missing project), then
   `GET /api/job-manager/projects/{uid}/envs/{env}/locked`, whose `uid` is the `lockedVersionUid` (read with the selection, so a lock taken between two reads cannot pair one version's selection with the next one's uid; `.../versions`, newest first, only when job-manager returns no `uid`).
   A 404 on `locked` means the environment does not exist; a 200 with `data: null` means it was never locked; an empty
   or unparseable 200 is reported as an empty response.
3. The removed-service guard: once the lock's `registeredJars` is non-empty, a `service` input it does not contain is
   refused before any upload, listing the registered names.
4. `uploadJar`: one glob match; `POST /api/file/artifact/upload/batch` with this JAR plus the other registered
   services, each named by the `artifactUid` its lock entry froze (resolved in any of the org's projects, a 404 when
   gone) or, for an entry with none, by SHA in this project (skipped on a miss); a signed `PUT` of the bytes when the
   server asks for them; `PUT /api/file/artifact/status`.
5. `submitAnalysis` and `submitBuild`: `POST /api/job-manager/jobs` for `MULTI_JAR_ANALYSIS`, then
   `MULTI_JAR_EXPLORER_BUILD` with the profile `buildProfileFromLocked` derives from the lock (an auto SKIP entry and a `user_removed`
   entry are left out, a user-ticked SKIP entry is built, and a method selected in several flows is configured
   once). The build request carries `projectUid` and `requestJson.envName` (`ResolvedConfig.envName`, the `environment`
   input), because job-manager resolves the build's environment from them and refuses an unknown name (409
   `build_env_not_found`); `pollJob` on
   `/api/job-manager/jobs/{id}/status` after each.
6. `readAnalysisOfUpload`: the analysis preview (`/jobs/{id}/preview`, then its signed JSON) gives the uploaded JAR's
   `serviceKey` (its name, or `name@<8 hex>` when uploads share a name) and display name, and its `notices` (what
   the analysis left out of the JAR); `run` emits one `core.warning` per notice.
7. `downloadArtifacts`: `/jobs/{id}/download`; extracts the bundle and writes this service's `javaagent.config`,
   chosen by the analysis key, then the `service` input, then a unique letters-only match.
8. `registerJarForEnv`: `PUT .../envs/{env}/services/{service}/jar` under the `service` input. It warns when the
   analysis key differs from the `serviceKey` the lock's `registeredJars` recorded for that registration; for a lock
   that recorded none, when the analysis names the JAR differently from the registration; and when a lock from
   before per-JAR keys files a shared-name pair's selection under the shared name.
9. `warnStalePeers`: `.../envs/{env}/staleness`, warning (or failing, with `fail-on-warnings`) for peers this run's
   analysis made stale. `reportDeployRun` posts to `.../deploy-runs` at start and end, best-effort. The in-progress
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

## Tests

`npm test` runs jest with nock for HTTP and module mocks for `run()` (`tests/index.test.ts`), so the call-site wiring
is tested as well as each step. `tests/postBundle.test.ts` runs the committed `dist/post/index.js` and fails if the
post bundle would run the pipeline.

**Proving the post step on a real runner.** A hosted cancel can take longer to reach the runner than the
Maestro step takes against hosted dev (about 20 seconds), so cancelling an E2E run usually lands after the step
has finished, and fractional `timeout-minutes` values do not fire. The step must be held open: push a
throwaway branch whose `dist/index.js` sleeps after the in-progress report, with a push-triggered copy of the
E2E job carrying a 1-minute step or job `timeout-minutes` (or cancel it by hand), read the run's
`Post Run ./` log and job-manager's `Recorded deploy run` lines, and delete the branch afterwards. The same
branch cut from `main` is the control. `e2e.yml` runs the action with `uses: ./` nightly against hosted dev: the CicdTest org's `maestro-action-e2e`
project, whose `dev` lock was made from the committed `fixtures/order-service-1.0.0.jar`.

**Running `dist/index.js` against devstack.** The action requires an https `api-url`, and its uploader and download
fetches accept only https, while devstack's gateway (`:8082`) and MinIO (`:9000`) speak http.
`scripts/devstack-tls-proxy.mjs` fronts both (`:8443` and `:9443`, on 127.0.0.1 unless `TLS_PROXY_BIND` says
otherwise; the MinIO front keeps the Host header, which a presigned URL's signature covers), and file-service and job-manager, which sign upload and download URLs, are
restarted with `AWS_PRESIGN_ENDPOINT_URL` pointing at the MinIO front. From the work root, in bash or zsh:

```
mkdir -p /tmp/maestro-tls && openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/maestro-tls/key.pem -out /tmp/maestro-tls/cert.pem -days 2 -subj /CN=localhost -addext "subjectAltName=DNS:localhost"
node maestro-action/scripts/devstack-tls-proxy.mjs /tmp/maestro-tls/cert.pem /tmp/maestro-tls/key.pem   # long-running: background it
cp devstack/devstack.local.env /tmp/maestro-tls/local.env && echo AWS_PRESIGN_ENDPOINT_URL=https://localhost:9443 >> /tmp/maestro-tls/local.env
OTELIGENCE_LOCAL_ENV=/tmp/maestro-tls/local.env bash devstack/devstack.sh restart file-service
OTELIGENCE_LOCAL_ENV=/tmp/maestro-tls/local.env bash devstack/devstack.sh restart job-manager
env MAESTRO_ALLOW_CUSTOM_API_URL=1 NODE_EXTRA_CA_CERTS=/tmp/maestro-tls/cert.pem RUNNER_TEMP=/tmp/maestro-tls/runner GITHUB_OUTPUT=/tmp/maestro-tls/out.txt \
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
