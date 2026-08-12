# GrassToucher

Discord bot to create and manage events in discord threads.

`/event create` opens a forum post for an event, with RSVP buttons on it. One pinned
message in a board channel always lists every upcoming event, and attendees get a ping
before the start time.

**Discord is the database.** Each forum post's embed *is* the event record, and the digest
is found by looking up the bot's own pin. There is no database, no volume, and nothing to
back up — the container is disposable.

## Setup

**1. Create the application**

At <https://discord.com/developers/applications>: New Application → Bot → Reset Token.
No privileged intents are needed — leave all three toggles off.

**2. Invite it**

Replace `YOUR_APP_ID` and open:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=2252126231284736
```

That grants View Channel, Send Messages, Send Messages in Threads, Create Public Threads,
Manage Threads, **Pin Messages**, Embed Links, and Read Message History.

Pin Messages is its own permission now — Discord split it out of Manage Messages, and the
current pins endpoint only accepts the new one. If the log says it can't pin the digest,
this is why.

**3. Make two channels**

A **forum** channel for the events, and a normal **text** channel for the digest. Turn on
Discord's Developer Mode, then right-click each to copy its ID.

**4. Configure**

```sh
cp .env.example .env
$EDITOR .env
```

**5. Run**

```sh
docker compose up --build -d
docker compose logs -f
```

Slash commands are registered to your guild on every boot, so they show up immediately and
there's no deploy step.

## Commands

| Command | Notes |
|---|---|
| `/event create title: when: [where:] [description:] [timezone:]` | `when` is `YYYY-MM-DD HH:MM` on a 24-hour clock. `timezone` suggests zones as you type — a city (`Berlin`), an abbreviation (`PST`) or a full IANA name all work, and it defaults to `DEFAULT_TZ`. |
| `/event edit [title:] [when:] [where:] [description:] [timezone:] [uncancel:]` | Run it **inside the event's thread**. Organizer or anyone with Manage Threads. `uncancel: True` brings a cancelled event back. |
| `/event cancel` | Run it **inside the event's thread**. Asks you to confirm, then marks the post CANCELLED and DMs everyone who RSVP'd. |

Times are stored as an instant and rendered with Discord's own timestamp markup, so
everyone reads them in their own local timezone.

## Locations

`where:` searches OpenStreetMap as you type — three characters in, suggestions start
appearing. Picking one stores a real, consistently formatted address instead of whatever each
person felt like typing.

It suggests, it never requires. "behind the gym" and "the usual spot" still submit fine.

Suggestions come from [Photon](https://photon.komoot.io), which needs no API key and no
account, so there's nothing to configure beyond `PLACE_BIAS_LAT` / `PLACE_BIAS_LON` —
coordinates near you, which tell it which "Dolores Park" you meant. Leave them unset and
results are ranked globally; the bot warns about that on boot. Somewhere genuinely far away
still resolves either way, because the coordinates only break ties.

A picked address is capped at 100 characters, Discord's hard limit on an autocomplete choice.
Trailing parts drop off (state, then city) rather than a word being cut in half. Text you type
yourself isn't a choice, so it can still run to 1024.

Addresses are OpenStreetMap data — **© OpenStreetMap contributors**,
[ODbL](https://www.openstreetmap.org/copyright). That licence is also *why* this bot can keep
an address in an embed forever: Google's and Mapbox's terms don't permit storing their
geocoding results, which rules them out of a design where the post is the record.

### When suggestions go quiet

Photon's public instance is free and shared, and its terms promise nothing: *"please be fair —
extensive usage will be throttled"*, and *"We do not guarantee for the availability."* On
2026-08-12 it was taking **~30 seconds** to answer, or returning a 502 after a similar wait —
reproducible with plain `curl`, so not the bot's doing.

That looks like broken autofill, and nothing in here can fix it. An autocomplete interaction
can't be deferred and dies at 3s, so `src/places.ts` budgets 2s for the whole round trip; a
30-second upstream is indistinguishable from one that's down, and a longer timeout only moves the
failure to Discord discarding a late reply. What you get is the designed fallback instead — an
empty list, no error toast, and typed text still submits.

Note also that this bot is a heavy client of that shared instance by construction: one request
per keystroke from the third character on, so a typed-out address is thirty-odd of them. Worth
holding in mind before reading "extensive usage will be throttled" as somebody else's problem —
and the reason self-hosting Photon is on the Roadmap.

## Timezones

`timezone:` suggests zones as you type, from whatever tzdata the runtime ships — no list to
keep current and nothing to configure. A city is enough (`berlin`, `new york`), and so is a
US or UK abbreviation (`PST`, `ET`, `CET`, `UTC`). Full IANA names still work, including
legacy links like `US/Eastern`. Before the first keystroke it offers `DEFAULT_TZ` and a
handful of common zones.

Typed text that pins down exactly one zone is accepted. Something that matches many —
`america`, `europe` — is not: the reply lists the nearest few instead of picking a city on
your behalf.

Abbreviations map to city zones on purpose. ICU accepts `EST` as a real zone ID, but it's a
fixed −5 that never observes daylight saving, so a July event booked in "EST" landed an hour
late; `EST` now means `America/New_York`. Ambiguous ones are left out rather than guessed —
`IST` is India, Ireland *and* Israel, so it falls through to the candidate list.

## Cancelling

`/event cancel` keeps the post. It renames it to `Title — CANCELLED`, turns the embed red,
strikes the title through, drops the RSVP buttons, and DMs Going + Maybe (plus the organizer)
with the event name, the server, the old start time, and a link back to the thread. The digest
keeps the event listed but struck through until its start time passes, so anyone who missed the
DM still sees what happened instead of wondering where the event went.

The DM is best effort. A member who has "allow direct messages from server members" switched
off just won't get one — the confirmation tells you how many couldn't be reached.

`/event edit uncancel: True` reverses all of that: the marker comes off the name and title, the
embed goes back to green, the RSVP buttons return with everyone's answers intact, and the same
people get a second DM saying it's back on. That correction is the point — anyone who read the
first DM has already written the event off. Combine it with `when:` in the same command to
reinstate an event at a new time, and the DM quotes the new one. No confirmation button here:
un-cancelling isn't the destructive direction.

**To remove an event entirely, delete its forum post.** The post is the record, so deleting it
erases the event; cancelling only marks it. The digest catches up a second or two later — the
bot watches for thread deletions instead of waiting for its next sweep. Archiving does *not*
cancel: archived posts stay in
the digest on purpose, because forum posts auto-archive after a week of quiet and an event
nobody chats in shouldn't vanish.

Only the organizer or someone with Manage Threads can edit or cancel. Note that the *bot*
authors every event post, so Discord's own "delete post" is a mod-only action here — which is
why cancelling is a command rather than something you do from the post's context menu.

## Development

```sh
bun install
bun run test       # vitest — `bun test` is bun's own runner and ignores this script
bun run typecheck  # tsc — the real gate; it only checks, it never emits
bun run dev        # reads .env via --env-file
```

Bun 1 or newer, because it runs the TypeScript sources directly. There is no build step and no
`dist/` — which is also why every relative import names a `.ts` file: specifiers resolve
literally, and nothing rewrites `./event.js` for you.

`bun.lock` is the lockfile. Node still runs this fine if you'd rather — the sources use no
bun-specific API, and Node 24 strips types too — but the dependency versions are pinned in a
format only bun reads.

`src/` is the bot, `test/` mirrors it — `test/event.test.ts` covers `src/event.ts`, and so on.
Only three files have logic worth testing: timezone conversion, the embed⇄event codec, and
address formatting. Everything else is Discord I/O. The suite makes no network calls.

| File | Job |
|---|---|
| `src/index.ts` | Config validation, boot, interaction routing, the 10-minute sweep |
| `src/event.ts` | The model: embed codec, forum listing, RSVP rules |
| `src/digest.ts` | Renders the digest and edits the pin in place |
| `src/interactions.ts` | Assembles `/event` from `src/commands/`, routes every interaction, owns the RSVP buttons and autocomplete |
| `src/commands/create.ts` · `edit.ts` · `cancel.ts` | One file per subcommand: its slice of the `/event` definition next to the handler that serves it. `cancel.ts` also owns the confirm button and the cancel/reinstate DMs |
| `src/commands/shared.ts` | What more than one subcommand needs: reply shapes, `when:`/`timezone:` parsing, the organizer-or-mod guard |
| `src/places.ts` | Address lookup for `where:` — Photon adapter and label formatting |
| `src/time.ts` | `YYYY-MM-DD HH:MM` + IANA zone → instant, DST-correct |
| `src/types.ts` | The shapes that cross module boundaries: `Event`, `Config`, `Ctx` |
| `src/utils/tryCatch.ts` | `await tryCatch(promise)` → `{ data, error }`, for calls allowed to fail |

### If embeds come back empty

The bot reads only its own messages, which is why it needs no privileged intents. If event
fields ever read back blank, enable **Message Content Intent** in the developer portal —
that's the one assumption in the design worth knowing about.

## Deployment

Three workflows in `.github/workflows/`, each one doing a single thing:

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | pull requests, and whenever Publish calls it | `bun run typecheck`, `bun run test`, and builds the image without pushing |
| `publish.yml` | push to `main` | Calls CI, then pushes `ghcr.io/wangryan408/grasstoucher:latest` and `:<sha>` |
| `deploy.yml` | a successful Publish, or the Run workflow button | SSHes to the host, pulls the new tag, restarts, and fails if the container isn't up |

Merging to main is the deploy. Tests failing means nothing reaches GHCR, and nothing reaching
GHCR means no deploy — `needs:` does that, which is why the tests live in a workflow Publish
can call rather than a separate run nobody is waiting on.

Every image is tagged with its commit sha as well as `latest`, so a rollback is
**Actions → Deploy → Run workflow** with an older sha in the tag box. The automatic path
deploys the sha rather than `latest`, so `docker compose ps` on the host names the commit
that's actually running.

The deploy sends one thing over the wire: the tag. `deploy/host-deploy.sh` is pinned as a forced
command on the host's key, so the runner can't ask for a shell, a directory of its own choosing,
or a script of its own — it names a tag and reads back the log. Anyone holding a leaked `SSH_KEY`
gets the same narrow deal.

### Reaching a host behind NAT

A home server has no public address to SSH to, and port-forwarding 22 to get one means exposing
sshd to the internet for the sake of a job that runs a few times a week. Instead the runner joins
the WireGuard tunnel that's already there, as a peer of its own, and reaches sshd through it. Only
WireGuard's UDP port is forwarded, and it already was.

**`SSH_HOST` is the host's LAN address** (`192.168.50.9` in `deploy.yml`), not the WireGuard server
address. The server address is the ambiguous one: `10.13.13.1` can belong to a bridged
`linuxserver/wireguard` container, which claims it as a local address and runs no sshd, or to a
`wg0` on the host itself, which does — and nothing about the address says which you have. Both at
once is possible too, if the container's config was ever imported onto the host. Aiming a deploy at
the wrong one gets connection refused and reads exactly like a firewall problem. Two commands
disambiguate — `docker exec wireguard ip route get 10.13.13.1` (`local … dev lo` means the
container owns it) and `ip -brief addr show wg0` on the host — but the LAN address needs neither,
and it's the path every other peer already uses to reach services on the box.

That peer's config is the `WG_CONFIG` secret, and it wants three edits over whatever your WireGuard
server generates:

```ini
AllowedIPs = 192.168.50.9/32   # NOT the 10.13.13.0/24,192.168.50.0/24 it hands you
PersistentKeepalive = 25
# and delete the DNS = line entirely
```

`AllowedIPs` is the routing table for the tunnel, so the generated value points a CI runner at your
whole LAN — every other box in the house, one leaked secret away. The deploy needs exactly one
host. And a `DNS =` line makes `wg-quick` rewrite the runner's own `resolv.conf` to your LAN
resolver, which errors out without `resolvconf` installed and breaks the runner resolving
`github.com` if it doesn't.

**Don't try to lock this down with `from=` in `authorized_keys`.** What source address sshd sees
depends on which side of the box terminates the tunnel: a host-side `wg0` hands it the peer's
tunnel address intact, while a bridged container MASQUERADEs and hands it the docker bridge
address instead. Neither is a stable identity for a runner, and getting it wrong locks you out of
your own deploy for reasons no log explains. The forced command is doing the restricting here, not
the source address. (Whichever terminates it, the interface needs to be in a firewalld zone that
permits ssh.)

`Endpoint` is your public IP, the one place it appears — **and check its port against what the
router actually forwards.** A containerised WireGuard server listens on 51820 inside the container
and gets published on some other host port, and the generator writes *that* port into every peer
config it hands out; if the router forwards the standard one to a server on the host, every
generated config is pointing at a port nothing is listening on. This fails in the most expensive
way available: `wg-quick up` still exits 0, every key is valid, and the packets are discarded
upstream of any instance that could log them, so there is nothing to find on either end. If the IP
is dynamic, put a DDNS name there — WireGuard resolves an Endpoint hostname only at interface
bring-up, which is a problem for long-lived peers and free for a runner that builds and destroys
`wg0` every run.

**Environment secrets, not repo secrets** — Settings → Environments → `production`, matching
`environment: production` in `deploy.yml`, with its deployment branch rule set to `main`. Repo
secrets are readable by `ci.yml` on any same-repo pull request; environment secrets only reach a job
that names the environment, and `ci.yml` doesn't.

| Secret | Value |
|---|---|
| `WG_CONFIG` | The tunnel peer config above |
| `SSH_USER` | User to connect as — needs to be in the `docker` group |
| `SSH_KEY` | Private half of a key dedicated to this and nothing else — its public half goes in the host's `authorized_keys`, behind the forced command below |
| `SSH_KNOWN_HOSTS` | One line pinning the host's key, so the deploy verifies a fingerprint instead of trusting whatever answers |

No `SSH_HOST`: it's a literal in the workflow. An RFC1918 address only reachable through the tunnel
hides nothing, and reading it in the diff beats an opaque secret when a deploy misbehaves.
No `DEPLOY_PATH` either — the host script derives it from its own location, because a path the
runner could name is a path the forced command isn't restricting.

**On the host**, once — clone the repo, write `.env` (see Setup), then generate a key for this
and nothing else:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -C deploy@github-actions -N ''
printf 'command="%s/deploy/host-deploy.sh",restrict %s\n' \
  "$PWD" "$(cat ~/.ssh/gh_deploy.pub)" >> ~/.ssh/authorized_keys
cat ~/.ssh/gh_deploy        # this half goes in SSH_KEY, then delete it from the host

# and this goes in SSH_KNOWN_HOSTS, verbatim
printf '192.168.50.9 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

`known_hosts` matching is a literal string compare, so the entry must name the **exact string the
workflow hands `ssh`** — the same address as `SSH_HOST`, whatever you set it to. Reading the host's
own key file also beats `ssh-keyscan`, which asks the network who it is; there's no reason to when
you're already standing on the machine. (`ssh-keyscan -H` is worse still here: it hashes the
hostname, so it can only ever produce an entry for the name you scanned.)

`restrict` turns off pty, agent, port and X11 forwarding — none of which a deploy needs, all of
which a stolen key would enjoy having.

Verify the forced command before GitHub is ever involved, from the host itself:

```sh
ssh -i ~/.ssh/gh_deploy you@localhost latest              # deploys
ssh -i ~/.ssh/gh_deploy you@localhost                     # same thing — not a shell
ssh -i ~/.ssh/gh_deploy you@localhost 'rm -rf /tmp/x'     # exits 64, runs nothing
```

Three layers have to fail before a leaked secret matters: `WG_CONFIG` routes to one address,
`SSH_KEY` is useless without it, and the forced command reduces that key to "restart the bot at a
validated tag".

Verify the tunnel half separately, from a phone or laptop peer already on the VPN — and **do it off
your LAN**, on cell data rather than the house wifi, or the connection never enters the tunnel and
proves nothing. `ssh you@192.168.50.9`; any response is a pass, `Permission denied (publickey)`
included, since it means packets made the round trip. If that works and the deploy still doesn't,
the problem is the CI peer's config, not the firewall — worth knowing before you start editing
zones.

**The GHCR package has to be readable by the host**, and a public one needs no registry
credentials there at all. Check it under package → Package settings → Change visibility after the
first Publish run — not before, because a package doesn't exist to be configured until something
has pushed to it. A private one shows up as a 401 on `docker compose pull` in the deploy log; flip
the visibility and re-run, or keep it private and `docker login ghcr.io` on the host with a
`read:packages` PAT.

`docker-compose.yaml` and `deploy/host-deploy.sh` on the host are the two things CI never
updates — a change to either needs a `git pull` there.

## Roadmap

Not commitments — what's worth doing next, and what's already landed.

**✅ done · 🚧 in progress · ❌ not started**

| Status | Change | Why, and what it costs |
|:---:|---|---|
| ❌ | **Looser `when:` input** | `YYYY-MM-DD HH:MM` is the only accepted format and now the most-rejected input in the bot. `tomorrow 7pm`, `friday 19:30`, `in 2 hours` should all parse. Autocomplete is the right surface — the plumbing exists for `where:` and `timezone:` both — and echoing the resolved date back *before* submit is what makes fuzzy parsing safe rather than surprising. |
| ❌ | **Self-host Photon** | `where:` leans on a free shared instance that disclaims its own availability, and on 2026-08-12 it spent ~30s per query or 502'd — against a 2s budget, the same thing as being down. A local one answers in single-digit milliseconds, is throttled by nobody, and takes an external service out of a per-keystroke hot path. The code cost is nearly nothing: `ENDPOINT` in `src/places.ts` becomes an env var. Everything else is operational. Photon wants Java 21+ and a search index, and GraphHopper publishes weekly prebuilt dumps — planet is ~95GB and growing 10% a year, with smaller per-country sets alongside it. Disk is the easy part. The catch is the 64GB RAM it recommends at planet scale, which a 16GB box is not going to satisfy, so the version that fits here is a country dump with a capped heap: plausible, unproven, and worth testing before it's promised. Hosted Photon-compatible providers (Geoapify and friends) are the cheaper escape hatch and still ODbL, so the storage-permission reasoning above survives — but they need an account and a key, which is precisely the property that made Photon the pick. |
| ✅ | **Deploy on merge** | Three workflows: CI on pull requests, a GHCR image on push to `main`, and a deploy that SSHes to the host and restarts it at the sha just built — so a dispatch with an older sha is the rollback, for free. The design cost was all in the last step, because the host is behind NAT with no public SSH address, so the runner joins the WireGuard tunnel as its own peer and reaches sshd through it. What made it expensive was that both of the real faults *succeeded* rather than failing. A forced command in `authorized_keys` runs the pinned command and leaves the client's string in `SSH_ORIGINAL_COMMAND`, so the heredoc that used to carry the remote body landed on stdin unread and `TAG` silently vanished — that's why the remote half is `deploy/host-deploy.sh`, checked into the repo, and why `DEPLOY_PATH` stopped being a secret. And `wg-quick up` configures an interface without handshaking, so it exits 0 into a tunnel that isn't there; the `ping` after it exists purely to make that fail out loud instead of surfacing as an SSH timeout half a job later. Both traps are now documented above, along with the two that only bit this host: a `wg0` on the host and one in a container sharing a keypair, and generated peer configs naming a port the router doesn't forward. The standing cost is that `docker-compose.yaml` and `host-deploy.sh` live on the host too, and CI never updates either. |
| ✅ | **Looser `timezone:` input** | IANA names are impossible to guess, so the option is autocompleted from `Intl.supportedValuesOf('timeZone')` — no dependency, no list to maintain, and it tracks the runtime's own tzdata. Typed text resolves when it pins down one zone. The find was that strictness wasn't even buying correctness: ICU accepts `EST`, and `EST` is a fixed −5 with no daylight saving, so the old validator waved through the one input most likely to be an hour wrong. `DEFAULT_TZ` goes through the same resolver now, since it had the same hole. |
| ✅ | **Convert to TypeScript** | The embed codec is where types earn their keep: `fromEmbed` returns a shape that `toEmbed`, the digest, the sweep and every handler all assume, and only one round-trip test enforced it. Nothing was lost to a build step in the end — Node strips types natively, so it still runs straight off the filesystem and the Dockerfile is still three lines; `typescript` is a devDependency that only ever type-checks. The cost is a Node 24 floor and `.ts` in every relative import. |
| ✅ | **A `tryCatch` wrapper** | Fallible calls were guarded ad hoc — `Promise.allSettled` for the DM fan-out, `.catch(() => {})` on the error reply, a bare try/catch around the digest pin and the starter-message fetch. `src/utils/tryCatch.ts` returns `{ data, error }` and now covers all five, which also makes the exception visible: `handleAutocomplete` keeps its own try/catch because `getFocused(true)` throws *synchronously* and the helper only takes a promise. |
