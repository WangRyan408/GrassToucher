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
  brings up `wg0` from `WG_CONFIG`. Five things about that, each of which has already cost time:
  - **Two WireGuard servers run on this host, sharing one keypair.** The live one is the *host's*
    `wg0`, owned by NetworkManager —
    `/etc/NetworkManager/system-connections/wg0.nmconnection`, autoconnect on. That is why it
    survives reboots with no `/etc/wireguard/wg0.conf` and `wg-quick@wg0` disabled, and checking
    those two paths is not enough to conclude anything. It was imported from the container's config
    on 2026-01-09 and is a frozen copy: same private key, and the peer list *of that date*. The
    linuxserver container still runs its own `wg0` from the same keypair, but nothing routes to it —
    `docker exec wireguard wg show` has never recorded a handshake. `nmcli device status` and
    `ip route show dev wg0` both answer this without root.
  - **The router forwards UDP 51820, and the generated peer configs are wrong about it.** The
    container publishes `51820/udp -> 51821`, so linuxserver writes `Endpoint = <wan>:51821` into
    every peer config it generates, and nothing forwards 51821. A peer that trusts the generated
    file gets precisely the symptom below — `wg-quick up` succeeds, then silence, with every key
    verifiably correct.
  - **Adding a peer to the container does nothing.** `WIREGUARD_PEERS` regenerates the container's
    `wg0.conf`, which the live server never reads. A new peer has to go into the NM profile (a
    `[wireguard-peer.<pubkey>]` section with `preshared-key-flags=0`, then
    `nmcli connection reload`) *and* into the running interface (`wg set wg0 peer … allowed-ips …`,
    plus the `ip route` that NM's `peer-routes=yes` would add for you on activation). `wg syncconf`
    looks like the one-step version and is the wrong tool — it re-applies every peer from the file
    and can break live sessions whose secrets the container has since regenerated.
  - `wg-quick up` **exits 0 even when the far end is unreachable** — it configures an interface, it
    never handshakes. That's why the tunnel step pings, and why it then prints `wg show`: *no
    handshake* means the packets never reached a server that could authenticate them, so suspect
    the forward or the endpoint and not the keys, while *a handshake and no ping reply* is routing
    or firewall on the host. Without that split, every tunnel fault is an indistinguishable SSH
    timeout.
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
