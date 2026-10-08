# maestro-action: architecture and contracts

The customer-facing GitHub Action for Maestro's Step 6. It runs in the customer's CI after their JAR build, drives
the platform's API through the gateway with a short-lived token minted from their API key, and leaves the generated
extension bundle and configs on the runner for their image build. All analysis and generation happens server-side.

## Layout

| Path | Purpose |
|---|---|
| `action.yml` | Inputs, outputs, `runs: using: 'node20'`, entry `dist/index.js`. |
| `src/index.ts` | `run()`: the step order below, the removed-service guard, the two opt-in degradations (`skip-on-removed-service`, `skip-generate-on-inactive`), and the deploy-run report at start and end. |
| `src/inputs.ts` | `parseInputs`: reads the inputs, requires `project` or `project-id`, enforces an `https://` `api-url` on an `*.oteligence.com` host unless `MAESTRO_ALLOW_CUSTOM_API_URL=1`. |
| `src/api.ts` | `MaestroApi` over `@actions/http-client`: bearer auth, retry on transient failures (`util/retry.ts`), signed-URL reads and writes without the auth header, `expectOk` mapping a 402 `subscription_inactive` to `SubscriptionInactiveError`. |
| `src/steps/` | One module per step, each with its own suite under `tests/steps/`. |
| `src/util/errors.ts` | The only messages that reach the log. `formatError` never echoes a response body or stack. |
| `dist/` | The ncc bundle GitHub executes; committed, and `ci.yml` fails when it is stale. |

## Flow and the endpoints it calls

1. `auth`: `POST /api/auth/cli/token` with the API key, keeping the JWT.
2. `resolveLockedConfig`: `GET /api/auth/tenant-projects` to resolve a project name, then
   `GET /api/job-manager/projects/{uid}/envs/{env}/locked` and `.../versions` (newest first, for `lockedVersionUid`).
   A 404 on `locked` means the environment was never locked.
3. The removed-service guard: once the lock's `registeredJars` is non-empty, a `service` input it does not contain is
   refused before any upload, listing the registered names.
4. `uploadJar`: one glob match; `POST /api/file/artifact/upload/batch` with this JAR plus the other registered
   services by SHA; a signed `PUT` of the bytes when the server asks for them; `PUT /api/file/artifact/status`.
5. `submitAnalysis` and `submitBuild`: `POST /api/job-manager/jobs` for `MULTI_JAR_ANALYSIS`, then
   `MULTI_JAR_EXPLORER_BUILD` with the profile `buildProfileFromLocked` derives from the lock; `pollJob` on
   `/api/job-manager/jobs/{id}/status` after each.
6. `analysisServiceNames`: the analysis preview (`/jobs/{id}/preview`, then its signed JSON) gives the uploaded JAR's
   `serviceKey` (its name, or `name@<8 hex>` when uploads share a name) and display name.
7. `downloadArtifacts`: `/jobs/{id}/download`; extracts the bundle and writes this service's `javaagent.config`,
   chosen by the analysis key, then the `service` input, then a unique letters-only match.
8. `registerJarForEnv`: `PUT .../envs/{env}/services/{service}/jar` under the `service` input; a warning names the
   analysis's display name for the JAR when it differs.
9. `warnStalePeers`: `.../envs/{env}/staleness`, warning (or failing, with `fail-on-warnings`) for peers this run's
   analysis made stale. `reportDeployRun` posts to `.../deploy-runs` at start and end, best-effort.

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
is tested as well as each step. `e2e.yml` runs the action with `uses: ./` against a configured host.
