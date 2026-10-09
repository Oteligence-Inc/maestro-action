# Maestro Instrumentation — GitHub Action

Wire [Maestro](https://oteligence.com) into your CI/CD so every JAR build is
instrumented with your **locked** observability rules — server-side, deterministic —
and the resulting OpenTelemetry agent + extension JAR are emitted for `docker build`.

This is the client for **Step 6** of the Maestro flow. The whole instrumentation
pipeline (bytecode scan, cross-service graph, scoring, ByteBuddy hooks, config
resolution) runs on Maestro; this Action is a thin orchestrator.

> **Status: v0 pilot.** Single JAR per invocation; happy-path + retries + staleness
> warning. See [Limitations](#limitations).

## Quick start

1. In the Maestro wizard, **lock** the target environment (Step 5 → Save & Lock).
2. Create a per-environment **API key** and add it to each service repo as the
   `MAESTRO_API_KEY` GitHub Secret.
3. Add the step to your deploy workflow **after** `mvn package`:

```yaml
# .github/workflows/deploy.yml  (in each service repo)
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - run: mvn -B package -DskipTests

      - id: maestro
        uses: Oteligence-Inc/maestro-action@v1
        with:
          api-key: ${{ secrets.MAESTRO_API_KEY }}
          project: 'banking-app'                # same across all service repos
          service: 'fund-transfer-service'      # this service's name in Maestro
          environment: ${{ github.ref == 'refs/heads/main' && 'prod' || (github.ref == 'refs/heads/staging' && 'staging' || 'dev') }}
          jars: 'target/*.jar'

      # Consume the outputs in your image build
      - run: |
          cp -r "${{ steps.maestro.outputs.extension-dir }}" ./otel
          test -n "${{ steps.maestro.outputs.config-path }}" && cp "${{ steps.maestro.outputs.config-path }}" ./otel/javaagent.config
          docker build --build-arg OTEL_DIR=otel -t myapp:${{ steps.maestro.outputs.locked-version }} .
```

Deploy the `collector-config-path` file to your OpenTelemetry **Collector** — not into
the app image.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | Maestro API key. **Use a GitHub Secret**, never inline. |
| `project` | yes | — | Project name (e.g. `banking-app`) or `proj_` UID. |
| `org-id` | no | — | The organization to act for (`org_...`). Needed only when the API key is not scoped to a project and its owner belongs to several organizations; the token exchange refuses such a key without it. |
| `service` | yes | — | The name the environment registers this service under: the analysis's name for the JAR (its `spring.application.name`, else the JAR's file name without its version), or, for one of two JARs that share that name, the file-derived name the wizard registered it under. A run whose input the environment's latest lock does not register fails and lists the names it does. A run warns when the analysis keys the JAR differently from the key the lock recorded for the registration (the build may then carry none of its locked methods), or, under a lock that recorded none, when the analysis names it differently. |
| `environment` | yes | — | Target env: `dev` / `staging` / `prod` / custom. |
| `jars` | yes | — | Glob to the JAR (e.g. `target/*.jar`). v0 expects exactly one match. |
| `api-url` | no | `https://api.oteligence.com` | Override base URL. Must be `https://` and an `*.oteligence.com` host unless `MAESTRO_ALLOW_CUSTOM_API_URL=1`. |
| `timeout-seconds` | no | `300` | Max wait for each Maestro job. |
| `fail-on-warnings` | no | `false` | Fail the step if this run made peer services stale. |

## Outputs

| Output | Description |
|---|---|
| `extension-dir` | Local dir with the extracted OTel agent + extension JAR. |
| `config-path` | This service's `javaagent.config` from the build. Empty, with a warning, when the lock selects none of its methods or its name matches more than one service. |
| `collector-config-path` | Resolved collector config (deploy to your Collector). |
| `locked-version` | The locked version applied (e.g. `22`). |
| `jar-sha` | SHA-256 of the uploaded JAR. |
| `job-id` | Maestro build job ID, for audit. |

## What it does (the 9-step flow)

1. Exchange the API key for a short-lived JWT (`POST /api/auth/cli/token`).
2. Resolve the project UID + the env's **locked config** and locked-version UID.
3–5. Upload the changed JAR (referencing the env's other services by the artifact the lock recorded for each,
   or by SHA for a lock entry that recorded none) and confirm.
6. Submit `MULTI_JAR_ANALYSIS` (re-applies locked rules; refreshes the cross-service
   staleness signatures), then `MULTI_JAR_EXPLORER_BUILD` (generates the extension from
   the locked selection).
7. Poll each job to completion.
8. Download + extract the bundle and configs → step outputs.
9. Register the JAR's SHA for this `(env, service)` (silent; the lock is unchanged).

After step 9 the Action calls `GET .../staleness` and emits a **`::warning`** naming any
**peer** services *this run* made stale (so they can be re-built). This is the only
staleness signal that reaches CI/CD-only users.

## Cross-service staleness

When this service's change alters the cross-service call graph, peer services' deployed
extensions can become **stale**. The Action surfaces that as a workflow warning:

```
This run changed the cross-service graph and made these peer services stale:
order-service. Re-run each one's CI to refresh its instrumentation.
```

Set `fail-on-warnings: true` to make that a hard failure instead.

## Troubleshooting

| Message | Cause / fix |
|---|---|
| `API key is invalid or has been revoked` | Create a new key in Maestro and update the `MAESTRO_API_KEY` secret. |
| `Env "X" … has not been locked yet` | Complete Step 5 (Save & Lock) in the wizard before running CI. |
| `Project "X" not found` | Use the exact project name, or its `proj_` UID. |
| `No single javaagent.config for service "X"` | The build has no config for this service: the lock selects none of its methods, or its name matches more than one service. `config-path` is empty. |
| `Service "X" is not part of "env"'s locked config` | The environment's latest lock registers no service by that name. Set `service` to one of the names the message lists, or add the service in the wizard and lock again. |
| `The analysis names this JAR "Y", the name its lock entries and build use` | The lock and build know the service as `Y`. Register it as `Y` in the wizard and set `service: Y`. |
| `matched N files` | v0 expects one JAR; narrow the `jars` glob. |
| `No uploaded artifact … to reference for <service>.jar` | A JAR the environment's lock recorded is no longer stored, or its stored bytes differ from the lock's SHA-256 ("… with that SHA-256"). Upload that service again in the wizard and re-lock the environment. |
| `Job … still running after Ns` | Raise `timeout-seconds`, or check the job in Maestro. |

## Limitations (v0 pilot)

- **One JAR per invocation.** Monorepos: add one step per service.
- **Backend flag required:** the server must have `maestro.staleness.enabled`
  (job-processor) on for the staleness warning.
- Per-service `javaagent.config` enrichment (`agentConfigContextByService`) from the
  analysis preview is **not** forwarded yet — the locked selection drives the build.
- Deferred to v1: artifact-hash verification, OIDC auth, GitHub Check / Slack surfaces,
  release automation, integration/E2E against staging.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest (HTTP mocked with nock)
npm run build       # ncc bundle → dist/index.js (committed; runtime entrypoint)
```

## CI / workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR | typecheck + test + build, and **fails if committed `dist/` is stale** |
| `.github/workflows/e2e.yml` | manual / nightly | runs the Action via `uses: ./` against staging (or a custom host) and asserts outputs/artifacts |
| `.github/workflows/release.yml` | push tag `v*` | re-test + verify `dist/`, create a GitHub Release, move the floating `v1` tag |

### Test the GitHub layer locally with `act`

`act` runs a real workflow (and the `action.yml`→`INPUT_*` plumbing) without GitHub:

```bash
# 1. install Docker Desktop + nektos/act
# 2. provide a JAR the container can see
cp ../demo-jars/ecommerce-microservices/jars/order-service-0.0.1-SNAPSHOT.jar fixtures/service.jar
# 3. run the E2E workflow against your https endpoint (ngrok/caddy)
act workflow_dispatch -W .github/workflows/e2e.yml \
  -s MAESTRO_API_KEY=ak_xxx \
  -s MAESTRO_API_URL=https://<your-ngrok-host> \
  --input jars=fixtures/service.jar
```

### Releasing (v0 → v1)

`dist/` is committed and run as-is by GitHub, so it must be fresh before tagging:

```bash
npm run build && git add dist/ && git commit -m "build: bundle dist"
git tag v0.1.0 && git push origin v0.1.0   # release.yml builds, releases, moves `v0`
```

Consumers then pin `uses: Oteligence-Inc/maestro-action@v1` (see the parent repos' `deploy.yml`).
