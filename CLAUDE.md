# Notes for Claude Code

Claude Code loads this file automatically at the start of every session in this repo, which is
why it's named `CLAUDE.md` rather than something like `HANDOFF.md`.

**Read `README.md` first.** It is accurate, current, and explains the design — Discord as the
database, the embed⇄event codec, `where:`/`timezone:` autocomplete, the deploy pipeline. The
host-specific half of that pipeline — the CI runner's WireGuard peer, the secrets, the forced
command — is in `docs/deploy-home-server.md`. This file only covers what isn't in either.

The WireGuard notes below are deliberately *not* in those two: they describe this host's own
server (two of them, sharing a keypair), where the docs file describes the runner's peer.

## Commands

```sh
bun install
bun run test       # vitest. NOT `bun test` — that starts bun's own runner, ignores the
                   # `test` script, and passes without running a single vitest assertion
bun run typecheck  # tsc, noEmit. The real gate: nothing here is compiled, only checked
bun run dev
```

Bun is the declared toolchain (`bun.lock` is the lockfile) and the only one installed on this
host — there is no `node` and no `npx`. Nothing in `src/` uses a bun-specific API, so Node 24
runs it fine elsewhere, but here `bun run …` is the only thing that works.

Watch the exit status when you pipe the gate through `tail` for a short log: a pipeline reports
the *last* command's status, so a missing interpreter prints nothing and the `&& echo "clean"`
after it fires anyway. Check `${PIPESTATUS[0]}`, or don't pipe.

## Invariants

- **Discord is the database.** A forum post's embed *is* the event record; the digest is found
  by looking up the bot's own pin. No DB, no volume, nothing to migrate.
- **The suite makes no network calls.** Keep it that way — `test/places.test.ts` deliberately
  has no fetch mock, so a live call would show up as a hang, not a pass.
- **Relative imports name `.ts` files.** Specifiers resolve literally; nothing rewrites
  `./event.js`. `tsconfig.json` sets `erasableSyntaxOnly`, so no enums, namespaces, parameter
  properties, or decorators — type stripping can't generate the code they need.
- **`src/index.ts` logs the client in at import time.** Never import a value from it; that's why
  `Config` and `Ctx` live in `src/types/config.ts` rather than beside the code that builds them.
  The rule for that directory: any type another module could import lives in `src/types/`, one
  file per concern. A type with exactly one consumer deliberately stays next to it — `ChoiceMeta`
  in `event.ts`, `Parts` in `time.ts`, `Result` in `utils/tryCatch.ts` — so moving those is not
  "finishing the job".
- The image name is spelled out lowercase in **two** places — `IMAGE` in
  `.github/workflows/publish.yml` and `image:` in `docker-compose.yaml`. GHCR rejects the
  capitals in `WangRyan408/GrassToucher`, so a repo rename means editing both.
- **The host's `authorized_keys` hardcodes the path to `deploy/host-deploy.sh`** as a forced
  command, and that script derives the compose directory from its own location. Moving or
  renaming the checkout on the host breaks the deploy with a bare "command not found" and no
  hint as to why — the fix is the `command=` line, not anything in this repo.
- **A forced command silently swallows a heredoc piped over SSH.** sshd runs the pinned command
  and leaves the client's string in `SSH_ORIGINAL_COMMAND`, so the body of an `ssh host <<'EOF'`
  lands on stdin unread and every variable it was carrying vanishes without an error. That is why
  the remote half is a versioned script and `deploy.yml` sends exactly one thing, the tag — don't
  "simplify" it back into a heredoc.
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

