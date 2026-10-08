# Claude Project Context: Maestro GitHub Action

For what the action does, its inputs and outputs, see [README.md](./README.md).
For its modules, the request flow and the contracts it reads, see [CLAUDE_CONTEXT.md](./CLAUDE_CONTEXT.md).
The platform `CLAUDE.md` one directory up governs process: the standing rule, the working loop, the PR
checklist and the proven / observed / reasoned vocabulary.

- **Work base is `main`.** Branch from it and open PRs into it.
- **This runs on customer runners with a customer API key.** It is the one component a customer's security team
  reads first. Never echo a response body, a token or a signed URL into the log (`formatError` is the only path to
  `core.setFailed`).
- **`dist/` is what GitHub runs.** After any `src/` change run `npm run build` and commit `dist/`; `ci.yml` fails a
  stale bundle. The platform's `maestro-deploy.yml` callers pin a commit SHA, so a merge here reaches them only when
  their pin moves.
- **Build:** `npm ci`, then `npm run typecheck`, `npm test` (jest, HTTP mocked with nock), `npm run build`. There is no
  PIT for TypeScript: prove a new test by reverting the line it covers and watching it fail.
- **Open bugs live in [TODO.md](./TODO.md)**, in the platform register format.
