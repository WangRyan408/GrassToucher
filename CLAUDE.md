# Notes for Claude Code

Claude Code loads this file automatically at the start of every session in this repo, which is
why it's named `CLAUDE.md` rather than something like `HANDOFF.md`.

**Read `README.md` first.** It is accurate, current, and explains the design — Discord as the
database, the embed⇄event codec, `where:`/`timezone:` autocomplete, the deploy pipeline. This
file only covers what isn't in there.

## Commands

```sh
bun install
bun run test       # vitest. NOT `bun test` — that starts bun's own runner, ignores the
                   # `test` script, and passes without running a single vitest assertion
bun run typecheck  # tsc, noEmit. The real gate: nothing here is compiled, only checked
bun run dev
```

Bun is the declared toolchain (`bun.lock` is the lockfile), but nothing in `src/` uses a
bun-specific API. On a machine without bun, `npx vitest run` and `npx tsc --noEmit` under Node
24 do the same job — worth knowing, because that is how the current work was verified.

## Invariants

- **Discord is the database.** A forum post's embed *is* the event record; the digest is found
  by looking up the bot's own pin. No DB, no volume, nothing to migrate.
- **The suite makes no network calls.** Keep it that way — `test/places.test.ts` deliberately
  has no fetch mock, so a live call would show up as a hang, not a pass.
- **Relative imports name `.ts` files.** Specifiers resolve literally; nothing rewrites
  `./event.js`. `tsconfig.json` sets `erasableSyntaxOnly`, so no enums, namespaces, parameter
  properties, or decorators — type stripping can't generate the code they need.
- **`src/index.ts` logs the client in at import time.** Never import a value from it; that's
  why shared types live in `src/types.ts`.
- The image name is spelled out lowercase in **two** places — `IMAGE` in
  `.github/workflows/publish.yml` and `image:` in `docker-compose.yaml`. GHCR rejects the
  capitals in `WangRyan408/GrassToucher`, so a repo rename means editing both.

## House style

Comments explain *why*, not what — read a few in `src/time.ts` or `src/places.ts` before
writing any. A `ponytail:` comment marks a deliberate simplification and names its ceiling
(`// ponytail: crude bound, not an LRU — …`); leave them alone unless the ceiling is actually
being hit, and write one when you take a shortcut on purpose.

The README's Roadmap table is kept honest: when a row lands, flip it to ✅ and write what the
change cost, in the voice of the rows already there.

## Where things stand — 2026-08-11

*Delete this section once both branches below are merged.*

Two stacked branches, both pushed, **no PRs opened yet**. Nothing is on `main`.

`feat/timezone-autocomplete` — three commits off `main`:

1. `6482829` — scripts run on bun.
2. `5d928e5` — `timezone:` autocompletes from `Intl.supportedValuesOf('timeZone')` and accepts
   loose input, plus `src/interactions.ts` split into `src/commands/{create,edit,cancel,shared}.ts`.
3. `98827f4` — `bun.lock` in, `package-lock.json` out, Dockerfile moved to `oven/bun:1-alpine`.

`feat/ci-and-deploy` — branched off that one, not off `main`, because the workflows assume the
bun Dockerfile and the GHCR image name from commit 3. Off `main` they would be wrong. So it is
either merged after `feat/timezone-autocomplete`, or its PR targets that branch.

4. `0680df0` — the three workflows, `image: …:${TAG:-latest}` in `docker-compose.yaml`, and the
   README's Deployment section. `.github/workflows/ci.yml` is `on: pull_request` +
   `workflow_call` only: `publish.yml` calls it, so a `push:` trigger would run the suite twice
   per merge.
5. This file.

### Three things nobody has verified

1. **The image has never been built.** `bun install --frozen-lockfile --production` against
   this `bun.lock` is unproven — Docker was unavailable on the machine this was written on.
   `ci.yml`'s `image` job is exactly that build, so **watch it on the first PR** rather than
   assuming it works.
2. **vitest under bun.** CI runs `bun run test`; the tests have only ever been run under Node.
   If it misbehaves, add `actions/setup-node@v6` to the `test` job and use `npx vitest run`,
   keeping bun for the install.
3. **The deploy has never run.** It needs repo secrets that don't exist yet (see the README's
   Deployment table) and a `docker login ghcr.io` on the host, since the GHCR package is
   private until someone changes it. The first run is the test.

### Next steps

1. Open the PRs — `ci.yml` runs on any PR, which is what proves the Dockerfile. Mind the
   stacking: `feat/timezone-autocomplete` merges first, or `feat/ci-and-deploy` targets it.
2. Human-only, can't be done from here: add the five deploy secrets, put the public key in the
   host's `authorized_keys`, and `docker login ghcr.io` there.
3. Merge → Publish pushes the image → Deploy fires on its own. Check `docker compose ps` on the
   host names the new sha.
4. Then the open roadmap row: **looser `when:` input**. `YYYY-MM-DD HH:MM` is now the
   most-rejected input in the bot. The autocomplete plumbing that `timezone:` and `where:` use
   is already there, and echoing the resolved date back before submit is what would make fuzzy
   parsing safe rather than surprising.
