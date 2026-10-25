# Maestro Instrumentation: GitHub Action

Wire [Maestro](https://oteligence.com) into your CI/CD so every JAR build is
instrumented with your **locked** observability rules (server-side, deterministic)
and the resulting extension JAR and configs are emitted for `docker build`, beside the
upstream OpenTelemetry agent you download for the OTel version picked in the wizard.

This is the client for **Step 6** of the Maestro flow. The whole instrumentation
pipeline (bytecode scan, cross-service graph, scoring, ByteBuddy hooks, config
resolution) runs on Maestro; this Action is a thin orchestrator.

> **Status: v0 pilot.** Single JAR per invocation; happy-path + retries + staleness
> warning. See [Limitations](#limitations).

## Quick start

1. In the Maestro wizard, **lock** the target environment (Step 5 -> Save & Lock).
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
        uses: Oteligence-Inc/maestro-action@v0
        with:
          api-key: ${{ secrets.MAESTRO_API_KEY }}
          api-url: 'https://prod.api.oteligence.com'  # hosted Maestro; a private-cloud install uses its own
          # trusted-api-host: 'maestro.example.internal'  # a private-cloud install names its API host here
          project: 'banking-app'                # same across all service repos
          service: 'fund-transfer-service'      # this service's name in Maestro
          environment: ${{ github.ref == 'refs/heads/main' && 'prod' || (github.ref == 'refs/heads/staging' && 'staging' || 'dev') }}
          jars: 'target/*.jar'

      # Assemble otel/ for the image: the upstream agent, this service's extension JAR, its config
      - env:
          OTEL_AGENT_VERSION: '2.32.0'          # the OTel version picked in the wizard for this lock
          EXT_DIR: ${{ steps.maestro.outputs.extension-dir }}
          ENV_TAG: ${{ github.ref == 'refs/heads/main' && 'prod' || (github.ref == 'refs/heads/staging' && 'staging' || 'dev') }}
        run: |
          mkdir -p otel/extensions
          curl -fsSL -o otel/opentelemetry-javaagent.jar "https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OTEL_AGENT_VERSION}/opentelemetry-javaagent.jar"
          cp "$EXT_DIR/fund-transfer-${ENV_TAG}-extension.jar" otel/extensions/   # this service's only; the bundle holds every service's
          test -n "${{ steps.maestro.outputs.config-path }}" && cp "${{ steps.maestro.outputs.config-path }}" otel/javaagent.config
          docker build --build-arg OTEL_DIR=otel -t myapp:${{ steps.maestro.outputs.locked-version }} .
```

Deploy the `collector-config-path` file to your OpenTelemetry **Collector**, not into
the app image.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | none | Maestro API key. **Use a GitHub Secret**, never inline. |
| `project` | one of `project` / `project-id` | none | Project name (e.g. `banking-app`) or `proj_` UID. |
| `project-id` | one of `project` / `project-id` | none | Project UID. Wins over `project` when both are set; a name that disagrees is warned about and ignored. |
| `org-id` | no | none | The id of the organization to act for (`org_...` on hosted SaaS, a UUID on a private-cloud VM). Needed only when the API key is not scoped to a project and its owner belongs to several organizations; the token exchange refuses such a key without it. |
| `service` | yes | none | The name the environment registers this service under: the analysis's name for the JAR (its `spring.application.name`, else the JAR's file name without its version), or, for one of two JARs that share that name, the file-derived name the wizard registered it under. A run whose input the environment's latest lock does not register fails and lists the names it does. A run warns when the analysis keys the JAR differently from the key the lock recorded for the registration (the build may then carry none of its locked methods), or, under a lock that recorded none, when the analysis names it differently. |
| `environment` | yes | none | Target env: `dev` / `staging` / `prod` / custom. |
| `jars` | yes | none | Glob to the JAR (e.g. `target/*.jar`). v0 expects exactly one match. |
| `api-url` | yes | | The Maestro API this run talks to: `https://prod.api.oteligence.com` for hosted Maestro, or your private-cloud install's address. It must be `https://` in every case; a private-cloud install serves plain HTTP out of the box, so put a TLS terminator in front of it. The storage URLs it signs for uploads and downloads must be `https://` too. A host outside `*.oteligence.com` must also be named in `trusted-api-host`. |
| `trusted-api-host` | no | | A private-cloud install's API hostname, such as `maestro.example.internal`: no scheme, port or path. The Action then accepts `api-url` on that host and refuses every other, an `*.oteligence.com` host included. Leave it unset for hosted Maestro. |
| `timeout-seconds` | no | `300` | Max wait for each Maestro job. |
| `fail-on-warnings` | no | `false` | Fail the step if this run made peer services stale. Drift from the lock never fails the step. |
| `skip-generate-on-inactive` | no | `false` | When the subscription is inactive (402), skip generation, set `generated` to `false` and let the pipeline continue without a new extension, instead of failing the step. |
| `skip-on-removed-service` | no | `false` | When this service is no longer in the environment's lock, skip generation, set `generated` to `false` and let the pipeline continue, instead of failing the step. Off, a removed or mistyped service fails with a message. |
| `signing-public-key` | no | | The Ed25519 public key your Maestro platform signs builds with: its PEM, or the base64 of its X.509 SubjectPublicKeyInfo. Set, the step fails unless the build carries a statement this key signed (see *Verifying the download*). Unset, a signed build is reported as `not-checked` and an unsigned one as `unsigned`. Take it from your own records, for example a repository variable, never from the Maestro server; a private key is refused. |
| `require-signed-build` | no | `false` | `true` fails the step when `signing-public-key` is empty. A workflow variable that is missing in a repository, fork or environment reads as empty, which would otherwise switch the signature check off. |

## Outputs

| Output | Description |
|---|---|
| `generated` | `true` when the build ran and its bundle was extracted. `false` when generation was skipped: the subscription is inactive and `skip-generate-on-inactive` is set, or the service is not in the lock and `skip-on-removed-service` is set. When `false`, `extension-dir`, `config-path` and `collector-config-path` are empty. |
| `extension-dir` | Local dir with the extracted build bundle: the extension JARs and configs, and each extension JAR's generated Java source under `sources/<JAR name without .jar>/`, by package (the agent loads only the `*.jar` files directly in the folder, so the sources do not reach it). It holds every service's extension JAR and config, and no OTel agent JAR: download the upstream agent for the OTel version picked in the wizard. A JAR is named `{service}-{env}-extension.jar`: the service lower-cased, spaces and any character other than a-z, 0-9 or `-` turned into `-`, and one trailing `-service`, `-svc`, `-api` or `-svr` removed; the env the same way with repeated hyphens collapsed. So `fund-transfer-service` in `prod` is `fund-transfer-prod-extension.jar`. When two services reduce to the same name, the second gets `-extension-2.jar`. Empty when `generated` is `false`. |
| `config-path` | This service's `javaagent.config` from the build. Empty, with a warning, when the lock selects none of its methods or its name matches more than one service. |
| `collector-config-path` | Resolved collector config (deploy to your Collector). |
| `locked-version` | The locked version applied (e.g. `22`). |
| `jar-sha` | SHA-256 of the uploaded JAR. |
| `job-id` | Maestro build job ID, for audit. |
| `build-record` | How the build's files stand against the record of its inputs: `recorded` (the first build of these inputs) or `matched` (an earlier build of the same inputs produced the same files). Empty when `generated` is `false`. The Action refuses every other outcome. |
| `build-signature` | `verified` (the build is signed by `signing-public-key`), `not-checked` (it is signed, but `signing-public-key` is not set) or `unsigned` (the platform holds no signing key). Empty when `generated` is `false`. With `signing-public-key` set, every outcome but `verified` fails the step. |

## What it does (the 9-step flow)

1. Exchange the API key for a short-lived JWT (`POST /api/auth/cli/token`).
2. Resolve the project UID + the env's **locked config** and locked-version UID.
3 to 5. Upload the changed JAR (referencing the env's other services by the artifact the lock recorded for each,
   or by SHA for a lock entry that recorded none) and confirm.
6. Submit `MULTI_JAR_ANALYSIS` (re-applies locked rules; refreshes the cross-service
   staleness signatures), then `MULTI_JAR_EXPLORER_BUILD` (generates the extension from
   the locked selection: every entry except an auto-recommended SKIP one and a
   `user_removed` one; a SKIP row the user ticked is built, as the wizard builds it).
   The build names its project and environment, so job-manager holds it to that environment's lock.
   Before polling the build, the Action reports its **drift** from the lock (below), so a build that then fails
   still says how its inputs drifted.
7. Poll each job to completion. A job that fails names Maestro's reason for it in the step's error (for example
   `The build could not be recorded. Try again, or contact support if it keeps failing.`), else points at the
   dashboard.
8. Download + extract the bundle and configs -> step outputs. When the analysis left classes or embedded libraries
   of the JAR out (one it could not read, parse, or read for its Java version), the Action emits a **`::warning`**
   per kind, before it submits the build, such as `The analysis left part of order-service out: 1 class could not be parsed and is not analysed:
   com/acme/Broken.class.` The step still succeeds; `fail-on-warnings` does not apply to these.
9. Verify the download against the build's record and, with `signing-public-key` set, its signature (below), then
   register the JAR's SHA for this `(env, service)` (silent; the lock is unchanged).

## Verifying the download

Maestro records every build: one record per set of build inputs (the application JARs the build read, the lock as
built, the analysis it read, the environment and its overrides, the Java and OpenTelemetry lines, and the platform's
build code and JDK), holding the SHA-256 of every bundle file a rebuild reproduces. The first build of a set of inputs
writes the record; it is never changed, and every later build of the same inputs is held to it.

Before it registers anything, the Action checks that the record names the JAR this run uploaded and binds it to the
service the analysis made of that JAR, and that every file it extracted, the sources under `sources/` included, and
both configs it downloaded hash to the record. `build-annex.json`, `lock-record.json`, `summary.html` and
`SUMMARY.txt` name the build job, the project or the lock version, and `build-statement.json` and
`build-statement.sig` sign the record, so those six are outside the record and not checked against it. The
step fails, and removes what it downloaded, when:

- the build's files differ from the record of the same inputs (the platform could not reproduce the build; run the job
  again, and contact support if it keeps happening);
- a downloaded file's bytes differ from the record, a file is in the download but not in the record, or a recorded
  file is missing;
- the record does not name the uploaded JAR, binds another JAR to this service, or binds none to it (also when the
  analysis could not be read, so the Action cannot name the service), or there is no record or the record has no
  bindings (a Maestro server older than either says so in its own message);
- the record covers one of the six files above (a server newer than this action; update the action);
- the bundle holds a link, an empty folder, or a file in a folder the record does not hold.

A download that stops part way (a signed URL refused, a bundle that does not extract) also leaves no files behind.

**What it shows:** the files are the bytes the build produced, unchanged in storage or in transit, and, when the
output is `matched`, that a rebuild of the same inputs reproduced them. **What it does not show** on its own: it
trusts the Maestro platform that both builds the files and serves the record; a build whose Maven output differs on
every CI run reads `recorded` each time, since its inputs differ.

### The build's signature

A Maestro platform whose job processor holds a signing key (`OTELIGENCE_MAESTRO_BUILD_SIGNING_KEY`) signs every
Maestro build: the bundle carries `build-statement.json`, which names the key (`signingKey`, `sha256:` and the
SHA-256 of its X.509 SubjectPublicKeyInfo), the record's inputs digest, the application JARs, the upload bound to each
service, the lock version the build was made from and the SHA-256 of every file the record covers, and
`build-statement.sig`, the raw Ed25519 signature over those exact bytes. A rebuild of one lock under one key states and
signs the same bytes. Only the job processor holds the private key, so a server or storage that changes a file and its
record entry together cannot also make the signature verify.

With `signing-public-key` set, the step also fails, and removes what it downloaded, when:

- the bundle carries no statement or no signature (the platform holds no signing key, or the download was altered);
- the statement names another key, or the signature does not verify with this one (a statement or signature altered);
- the statement's inputs digest, JARs, bindings or files differ from the record the remaining checks use;
- the statement names another lock version than the one this run built, or a schema this action does not know.

Without it, the Action reports the signature and checks nothing about it; `require-signed-build: true` makes an
empty key an error instead.

**What the signature shows:** the files are the bytes a job processor holding the key built from the inputs its
statement names, so storage or a server that rewrites a file and its record afterwards is caught. **What it does not
show:** that those inputs are the lock you made. The lock, the analysis and the uploads reach the job processor
through the platform, and the lock version the Action compares is the one the server reports, so a compromised
platform can still have a genuine build made from inputs of its choosing. The four files outside the record
(`build-annex.json`, `lock-record.json`, `summary.html`, `SUMMARY.txt`) are not signed either.

To check a bundle by hand, from the folder it was extracted to, with the public key in `signing-public-key.pem`
(OpenSSL 3, which reads raw Ed25519 input with `-rawin`):

```bash
openssl pkeyutl -verify -pubin -inkey signing-public-key.pem -rawin -in build-statement.json -sigfile build-statement.sig
jq -r '.files | to_entries[] | "\(.value)  \(.key)"' build-statement.json | sha256sum -c -
```

The first prints `Signature Verified Successfully`; the second prints `OK` for each file the statement covers (on
macOS, `shasum -a 256 -c -` in place of `sha256sum -c -`). The two configs the Action downloads separately are in the
bundle too, under their bundle names. Then list every file the statement does not name, in bash:

```bash
export LC_ALL=C
comm -13 <(jq -r '.files | keys[]' build-statement.json | sort) <(find . -type f ! -name signing-public-key.pem | sed 's|^\./||' | sort)
```

It prints only `SUMMARY.txt`, `build-annex.json`, `build-statement.json`, `build-statement.sig`, `summary.html` and,
for a build from a lock, `lock-record.json`. Any other name is a file the build did not make. `LC_ALL=C` matters:
`comm` compares in the locale's order and reports every line when that differs from `sort`'s.

After step 9 the Action calls `GET .../staleness` and emits a **`::warning`** naming any
**peer** services *this run* made stale (so they can be re-built). This is the only
staleness signal that reaches CI/CD-only users.

Each run also appears on the project's CI/CD tab: the Action reports it in progress once the project
is resolved and the environment's lock includes the service, and completed with its outcome at the
end. The Action's post step, which GitHub runs after the job's other steps, closes a run that was left
open: as **cancelled** when the run was cancelled or stopped by a `timeout-minutes` before the Action
finished, or with its real outcome when the final report did not reach Maestro. It re-authenticates
with the same API key. Reporting is best-effort and never fails the step.

## Cross-service staleness

When this service's change alters the cross-service call graph, peer services' deployed
extensions can become **stale**. The Action surfaces that as a workflow warning:

```
This run changed the cross-service graph and made these peer services stale:
order-service. Re-run each one's CI to refresh its instrumentation.
```

Set `fail-on-warnings: true` to make that a hard failure instead.

## Drift from the lock

job-manager compares the build's analysis with the lock's own analysis when the build is submitted, and the
Action reports the result for the service it built. A **`::warning`** names, with job-manager's full count, the
methods the analysis now recommends that the lock does not hold, and the locked methods no longer in the JAR or no
longer instrumentable, for example:

```
Drift against lock v4 in fund-transfer-service: 1 method(s) the analysis now recommends are not in the lock:
fund-transfer-service::org.example.TransferAudit.record. Lock again to add them, or leave them out.
```

When the analysis engine or the goals changed since the lock, the warning says a new recommendation may come from
them rather than the JAR. A service the lock's analysis held methods for and this build's analysis holds none for is
named in a warning. Other services' drift is one count line, and their own runs name it. A run with no drift prints
`No drift against lock vN.`; one built from the lock's own analysis, or one job-manager could not compare, says so
as information, and one whose analysis was not made from this build's JARs says so in a warning. Drift never fails
the step: `fail-on-warnings` applies to peer staleness only, and the build is still the lock's.

## Troubleshooting

| Message | Cause / fix |
|---|---|
| `API key is invalid or has been revoked` | Create a new key in Maestro and update the `MAESTRO_API_KEY` secret. |
| `The member who owns MAESTRO_API_KEY has the Reader role` | job-manager and file-service refuse a Reader's writes. An organization admin can make the key's owner a Project Admin, or the secret can hold a key of a member who is one; the next run picks it up. |
| `Env "X" ... was not found` | Check that `environment` names an environment in the project. |
| `Env "X" ... has not been locked yet` | Complete Step 5 (Save & Lock) in the wizard before running CI. |
| `Input required and not supplied: api-url` | Add `api-url` to the step's `with:`. It has no default. |
| `Project "X" not found` | Use the exact project name, or its `proj_` UID. |
| `project-id "X" was not found for this API key's tenant` | Copy the exact Project ID from Maestro, or use the project name instead. |
| `API key does not have access to project "X"` | The tenant-projects listing refused the key (401 or 403). Use a key from the organization that owns the project. |
| `Listing this API key's tenant projects returned more than 1000 pages` | The listing never reported a last page. Set `project-id` to skip the name lookup, and report it. |
| `No single javaagent.config for service "X"` | The build has no config for this service: the lock selects none of its methods, or its name matches more than one service. `config-path` is empty. |
| `Service "X" is not part of "env"'s locked config` | The environment's latest lock registers no service by that name. Set `service` to one of the names the message lists, or add the service in the wizard and lock again. |
| `The analysis names this JAR "Y", the name its lock entries and build use` | The lock and build know the service as `Y`. Register it as `Y` in the wizard and set `service: Y`. |
| `matched N files` | v0 expects one JAR; narrow the `jars` glob. |
| `BUILD_LOCK_SUPERSEDED: production environment 'X' builds only from its current lock` | The environment was locked again while the run was in progress, so the build named an older version. Re-run the workflow; it reads the newest lock. |
| `No uploaded artifact ... to reference for <service>.jar` | A JAR the environment's lock recorded is no longer stored, or its stored bytes differ from the lock's SHA-256 ("... with that SHA-256"). Upload that service again in the wizard and re-lock the environment. |
| `Job ... still running after Ns` | Raise `timeout-seconds`, or check the job in Maestro. |

## Runner requirements

The action runs on Node 24 (`runs: using: node24`). GitHub-hosted runners provide it. A self-hosted runner needs
Actions Runner 2.327.1 or later, on an OS and architecture Node 24 supports (not macOS 13.4 or earlier, not ARM32).

## Limitations (v0 pilot)

- **One JAR per invocation.** Monorepos: add one step per service.
- **Backend flag required:** the server must have `maestro.staleness.enabled`
  (job-processor) on for the staleness warning.
- Per-service `javaagent.config` enrichment (`agentConfigContextByService`) from the
  analysis preview is **not** forwarded yet: the locked selection drives the build.
- Deferred to v1: artifact-hash verification, OIDC auth, GitHub Check / Slack surfaces,
  release automation.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest (HTTP mocked with nock)
npm run build       # ncc bundles -> dist/index.js and dist/post/index.js (committed; what GitHub runs)
```

## CI / workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR | typecheck + test + build, and **fails if committed `dist/` is stale** |
| `.github/workflows/e2e.yml` | manual / nightly | runs the Action via `uses: ./` against hosted dev (project `maestro-action-e2e`, fixture `fixtures/order-service-1.0.0.jar`) and asserts outputs/artifacts |
| `.github/workflows/release.yml` | push tag `v*` | re-test + verify `dist/`, create a GitHub Release, move the floating major tag (`v0` for a `v0.x.y` tag) |

### Test the GitHub layer locally with `act`

`act` runs a real workflow (and the `action.yml`->`INPUT_*` plumbing) without GitHub:

```bash
# 1. install Docker Desktop + nektos/act
# 2. from the repo root (the fixture JAR is committed; the key is the CicdTest org's MAESTRO_ACTION_E2E_DEV)
act workflow_dispatch -W .github/workflows/e2e.yml \
  -s MAESTRO_API_KEY=<ak_ key> \
  -s MAESTRO_API_URL=https://develop.api.oteligence.com
```

### Releasing

`dist/` is committed and run as-is by GitHub, so it must be fresh before tagging:

```bash
npm run build && git add dist/ && git commit -m "build: bundle dist"
git tag v0.<minor>.<patch> && git push origin v0.<minor>.<patch>   # the next unused version; release.yml builds, releases, moves `v0`
```

Customers pin `uses: Oteligence-Inc/maestro-action@v0`. The platform's own `maestro-deploy.yml` workflows pin a
commit SHA instead.
