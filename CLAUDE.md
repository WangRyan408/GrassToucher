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
- **The host's `authorized_keys` hardcodes the path to `deploy/host-deploy.sh`** as a forced
  command, and that script derives the compose directory from its own location. Moving or
  renaming the checkout on the host breaks the deploy with a bare "command not found" and no
  hint as to why — the fix is the `command=` line, not anything in this repo.
- **The deploy only works from inside the WireGuard tunnel.** The host is behind NAT with no
  public SSH address, so `SSH_HOST: 192.168.50.9` in `deploy.yml` is unreachable until the runner
  brings up `wg0` from `WG_CONFIG`. Three things about that, each of which has already cost time:
  - **It is the LAN address, not `10.13.13.1`.** The WireGuard server is a *bridged* container, so
    it owns `10.13.13.1` itself — `docker exec wireguard ip route get 10.13.13.1` says
    `local … dev lo` — and runs no sshd. Aiming a deploy there gets connection refused and reads
    exactly like a firewall problem. The container MASQUERADEs onto the LAN instead. (Confusingly
    the *host* also has a `wg0` holding `10.13.13.1`, with its own socket on 51820; the router
    forwards 51821, which Docker publishes to the container, so peers land in the container. The
    LAN address is correct either way, which is why it's the one to use.)
  - `wg-quick up` **exits 0 even when the far end is unreachable** — it configures an interface, it
    never handshakes. That's why a `ping` follows it; delete that ping and every tunnel fault
    becomes an indistinguishable SSH timeout.
  - `Endpoint` in `WG_CONFIG` is a literal public IP. When the ISP moves it, deploys fail at the
    ping and the fix is the secret, not the repo.

## House style

Comments explain *why*, not what — read a few in `src/time.ts` or `src/places.ts` before
writing any. A `ponytail:` comment marks a deliberate simplification and names its ceiling
(`// ponytail: crude bound, not an LRU — …`); leave them alone unless the ceiling is actually
being hit, and write one when you take a shortcut on purpose.

The README's Roadmap table is kept honest: when a row lands, flip it to ✅ and write what the
change cost, in the voice of the rows already there.

## Shelved

Decided against for now, not forgotten. The reason it was left is the useful part.

- **A circuit breaker in `searchPlaces`.** When Photon's public instance degrades it doesn't
  refuse, it *stalls* — on 2026-08-12 it was answering in ~30s or 502ing after a similar wait — so
  every keystroke opens a connection that burns the whole of `TIMEOUT_MS` before returning empty.
  One `/event create` produced 32 consecutive failures and not a single success. The fix is small
  and fits the cache idiom already in that file: count consecutive failures and, past a threshold,
  return `[]` without fetching for ~60s. Worth doing whether or not the upstream recovers, for two
  reasons — it stops the bot piling doomed requests onto a service whose terms ask you to be fair,
  and it makes a degraded autocomplete instantly empty rather than laggy-empty.

  Not built because nothing is actually broken: an empty list is already the designed fallback and
  typed text still submits. Read the README's *When suggestions go quiet* first — in particular why
  raising `TIMEOUT_MS` is not the alternative (autocomplete can't be deferred and dies at 3s), and
  why self-hosting Photon is the roadmap answer rather than this.

## Where things stand — 2026-08-11

*Delete this section once `feat/ci-and-deploy` is merged.*

**On `main`** (merged as PR #4, `fa3aa5e`): bun is the toolchain and `bun.lock` the lockfile,
the Dockerfile runs `oven/bun:1-alpine`, `timezone:` autocompletes from
`Intl.supportedValuesOf('timeZone')` and takes loose input, and `src/interactions.ts` is split
into `src/commands/{create,edit,cancel,shared}.ts`.

**Open: `feat/ci-and-deploy`**, pushed, four commits off `main`, **PR not opened yet**.

Opening it has to happen in a browser: this host has no `gh` CLI, no GitHub token in the
environment, and sudo wants a password, so there is no way to do it from a session here. The
compare URL is `https://github.com/WangRyan408/GrassToucher/compare/main...feat/ci-and-deploy`.

1. `0680df0` — the three workflows, `image: …:${TAG:-latest}` in `docker-compose.yaml`, and the
   README's Deployment section. `.github/workflows/ci.yml` is `on: pull_request` +
   `workflow_call` only: `publish.yml` calls it, so a `push:` trigger would run the suite twice
   per merge.
2. `3298a0d`, `f27996e` — this file, and a correction to it.
3. The head commit — `deploy/host-deploy.sh`, `deploy.yml` cut down to `ssh … "$TAG"` plus the
   WireGuard tunnel, and the README's Locations notes. Two independent findings forced that shape,
   and both are already written up above as invariants:
   - A forced command silently breaks a heredoc piped over SSH. sshd runs the pinned command and
     leaves the client's string in `SSH_ORIGINAL_COMMAND`, so the heredoc lands on stdin unread and
     `TAG` vanishes. Both halves had to move to the host together, and `DEPLOY_PATH` stopped being
     a secret.
   - The host is behind NAT, so the workflow brings up `wg0` from `WG_CONFIG` and SSHes to
     `192.168.50.9`. `SSH_HOST` stopped being a secret too. The four that remain (`WG_CONFIG`,
     `SSH_KEY`, `SSH_KNOWN_HOSTS`, `SSH_USER`) are **environment** secrets under `production`
     rather than repo secrets — `ci.yml` can read repo secrets on any same-repo PR.

### What's verified now, and the one thing that isn't

Two of the three old unknowns were settled locally on 2026-08-12, on this host, before CI ever
ran:

1. ✅ **The image builds.** `bun install --frozen-lockfile --production` resolves 24 packages
   against this `bun.lock` with no complaint, and the container logs in and reaches `Ready.`
2. ✅ **vitest under bun.** `bun run test` → 39 tests, 3 files, all passing. No `setup-node`
   fallback needed.
3. ❌ **The deploy has still never run end to end**, and can't be until the human-only half
   exists: the `ci` WireGuard peer, the four environment secrets, the forced-command line in
   `authorized_keys`, and a GHCR package the host can read. The first run is the test. Two
   things make its failures legible rather than silent — the `ping` after `wg-quick up` (which
   exits 0 even when the far end is unreachable) and the healthcheck in `host-deploy.sh` (so a
   wrong `DISCORD_TOKEN` fails the deploy instead of passing it).

### Next steps

1. Watch the PR's `ci.yml` run — the first time that workflow has ever executed. The `image` job is
   the interesting one; typecheck and the suite have both been run locally under bun already.
2. Human-only, can't be done from here. `.env` on the host is already written; what's left is the
   `ci` WireGuard peer (add it to `WIREGUARD_PEERS` in `~/jellyfin-setup/.env` and recreate the
   container — that briefly drops the phone/laptop/tablet peers, whose keys survive in the config
   volume), then narrow the generated peer config's `AllowedIPs` to `192.168.50.9/32` and delete
   its `DNS =` line before it becomes `WG_CONFIG`. Then the four environment secrets and the
   forced-command line in `authorized_keys`. All the recipes are in the README.
3. Merge → Publish pushes the image → Deploy fires on its own and **401s**, because Publish
   creates the GHCR package private. Flip it to public, then re-run Deploy from the Actions tab.
   That ordering is unavoidable: the package doesn't exist to be made public until something has
   pushed to it.
4. Then the open roadmap row: **looser `when:` input**. `YYYY-MM-DD HH:MM` is now the
   most-rejected input in the bot. The autocomplete plumbing that `timezone:` and `where:` use
   is already there, and echoing the resolved date back before submit is what would make fuzzy
   parsing safe rather than surprising.
