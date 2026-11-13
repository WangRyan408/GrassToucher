# GrassToucher

Discord bot to create and manage events in discord threads.

`/event create` opens a forum post for an event, with RSVP buttons on it. One pinned message
in a board channel lists every upcoming or undated event, and attendees get a ping before a
scheduled start time. One bot serves every server that invites it; no guild ID is needed.

Discord stores each event record in its forum post's embed, and the digest is found by looking up
the bot's own pin. SQLite stores the forum and digest channel IDs for each server in one shared
table; Docker Compose keeps that small configuration database in a named volume.

## Setup

**1. Create the application**

At <https://discord.com/developers/applications>: New Application → Bot → Reset Token. No
privileged intents are needed — leave all three toggles off.

**2. Invite it**

Replace `YOUR_APP_ID` and open:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=2252126231284736
```

That grants View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Manage
Threads, **Pin Messages**, Embed Links, and Read Message History.

Pin Messages is its own permission now — Discord split it out of Manage Messages, and the current
pins endpoint only accepts the new one. If the log says it can't pin the digest, this is why.

**3. Make the channels**

A **forum** channel for events and a normal **text** channel for the digest. Both are required,
and their names are up to you. Give the bot the invite permissions above in those channels.

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

Slash commands are registered globally on every boot and work in every server that invites the
bot. Discord may take a little time to show a new global definition. They are server-only, so they
do not appear in DMs. Old guild-scoped `/event` commands are removed automatically during startup
and when joining a server, so they cannot hide the global definition.

`DISCORD_TOKEN` is the only required environment variable. Timezone, reminder and address-bias
settings apply across all servers. `DATABASE_PATH` defaults to `./data/grasstoucher.sqlite` for
local runs; Compose sets it to `/data/grasstoucher.sqlite` inside the container. `GUILD_ID`,
`EVENT_FORUM_ID` and `DIGEST_CHANNEL_ID` are no longer used and can be removed from an existing
`.env`. Existing pinned setup records are imported automatically the first time the new version
starts, then unpinned best-effort.

The `grasstoucher-data` Docker volume survives container rebuilds and `docker compose down`. Keep
it when deploying new images; `docker compose down -v` removes it and erases the saved channel
selections. To back up the database, stop the bot and copy the SQLite file from that volume.

For the existing image-only CI deployment, install the updated Compose file on the host **before
deploying the first SQLite image**. CI does not update that file, so the previous version would
start the new image without its volume. See [the host upgrade notes](docs/deploy-home-server.md#what-ci-never-updates).

**6. Set up each server**

Someone with **Manage Server** runs:

```
/setup forum:#your-event-forum digest:#your-digest-channel
```

Both options are required. The bot checks the channel types and its permissions, saves both IDs in
SQLite under this server's ID, and posts or refreshes the digest. Run `/setup` again to change
either channel. No channel name or environment variable supplies a default.

Until setup is complete, every `/event` command and RSVP/cancel button returns a private setup
error, and autocomplete stays empty. Deleting a selected channel or removing required permissions
also blocks commands until the problem is fixed or `/setup` is run again. Changes to the selected
channels or their categories trigger validation again; unrelated channel activity leaves commands
available. Each sweep checks the selected channels too.

## Commands

| Command | Notes |
|---|---|
| `/setup forum: digest:` | Requires Manage Server. Selects both channels for this server, validates permissions and saves setup in SQLite. Run it again to change the selection. |
| `/event create title: when: [where:] [description:] [timezone:] [recurring:]` | `when` takes what you'd say out loud and previews the resolved time as you type; use `TBD` for a date still to be decided. `timezone` accepts a city (`Berlin`), an abbreviation (`PST`) or a full IANA name, and defaults to `DEFAULT_TZ`. Optional `recurring` choices: `daily`, `weekly`, `bi-weekly`, `monthly`. |
| `/event edit [title:] [when:] [where:] [description:] [timezone:] [uncancel:] [recurring:]` | Run it **inside the event's thread**. Organizer or anyone with Manage Threads. Set `when:TBD` to clear a date, or supply a time to schedule an undated event. `recurring` changes the cadence; `none` stops repeating. `uncancel: True` brings a cancelled event back. |
| `/event cancel` | Run it **inside the event's thread**. Asks you to confirm, then marks the post CANCELLED and DMs everyone who RSVP'd. |
| `/event pause duration:` | Run it **inside the event's thread**. Organizer or anyone with Manage Threads. Hides only that post from the digest for `30m`, `2h`, `3d`, `1 week`, etc., then the pause expires automatically. |

Times are stored as an instant and rendered with Discord's own timestamp markup, so everyone reads
them in their own local timezone.

## Times

`when:` reads what you'd say out loud — `tomorrow 7pm`, `friday 7:30 PM`, `Aug 15 7pm`,
`in 2 hours`, `next saturday`, `7:30` on its own. The old `YYYY-MM-DD HH:MM` still works, and is
still what gets submitted under the hood.

Use `when:TBD` when the date hasn't been decided. It accepts any capitalization and appears in
autocomplete. `when` is still required on create; blank or unreadable text is rejected. Omitting
`when` on edit keeps the existing date, while `when:TBD` clears it.

Undated posts show **When: TBD**, keep their green status dot unless cancelled or paused, and appear
after scheduled events in the digest. The embed stores TBD explicitly, so it survives a restart. They
receive no reminders and the bot won't archive them as finished; Discord's normal inactivity
archiving still applies. Use `/event edit when:tomorrow 7pm` to schedule one later. Changing the
date resets its reminder so attendees can be pinged for the new time. An undated event stays in
the digest until it is given a date, paused, or its post is deleted, including if it is cancelled.

The dropdown echoes the resolved time back **before** you submit — `Sat, Aug 15, 2026 · 7:30 PM
PDT · in 3 days`. That preview is what makes loose parsing safe rather than surprising: you see
which Friday it picked while you can still fix it, and picking a suggestion submits the canonical
form, so the text and the instant can't disagree. Focus the option before typing and it offers this
evening out to a week away, never anything already past.

Two things it deliberately won't guess:

- **An unwritten AM/PM is offered both ways.** `7:30` lists 7:30 PM *and* 7:30 AM, soonest first,
  because silently picking one is how somebody ends up at a 7 AM party.
- **A date with no clock time means midnight, and says so.** `Aug 15` lists `12:00 AM` first. The
  rough edge: `tonight` is a date, not a time, so it resolves to midnight — behind you by the
  evening, so the dropdown drops it and offers the later hours instead.

Anything it can't read gets the same fallback as `where:` — an empty list, no error toast, typed
text still submits. A time daylight saving skips is rejected whichever way you write it, since the
loose parser hands its wall clock to the same strict converter that `timezone:` feeds.

Bot-written text is 12-hour; **embeds are not forced either way**, because Discord's `<t:…>` markup
renders in each viewer's own zone. That markup also covers the one thing the bot cannot know:
**Discord tells a bot nothing about a user's timezone** — no field, no OAuth scope among the 28 that
exist, only `locale`, which is a *language*. So confirmations echo the instant back as `<t:…>`: type
`7pm` with `DEFAULT_TZ` three zones west and it reads 10:00 PM, caught immediately. Autocomplete
can't — choice names are plain strings, which is why `formatWhen` names its zone instead.

## Locations

`where:` searches OpenStreetMap as you type — three characters in, suggestions appear. Picking one
stores a real, consistently formatted address instead of whatever each person felt like typing. It
suggests, it never requires: "behind the gym" still submits fine.

Suggestions come from [Photon](https://photon.komoot.io), which needs no API key and no account, so
the only thing to configure is `PLACE_BIAS_LAT` / `PLACE_BIAS_LON` — coordinates near you, which
decide which "Dolores Park" you meant. Unset, results are ranked globally and the bot warns on boot;
somewhere genuinely far away still resolves, since the bias only breaks ties.

A picked address is capped at 100 characters, Discord's limit on an autocomplete choice, and
trailing parts drop off (state, then city) rather than a word being cut in half. Text you type
yourself isn't a choice, so it can still run to 1024.

Addresses are **© OpenStreetMap contributors**, [ODbL](https://www.openstreetmap.org/copyright) —
which is also *why* the bot can keep one in an embed forever. Google's and Mapbox's terms don't
permit storing their geocoding results, ruling both out of a design where the post is the record.

### When suggestions go quiet

Photon's public instance is free, shared, and promises nothing: *"We do not guarantee for the
availability."* On 2026-08-12 it took ~30 seconds to answer or 502'd, reproducible with plain
`curl`. Nothing here can fix that — an autocomplete interaction can't be deferred and dies at 3s,
so `src/places.ts` budgets 2s, and a longer timeout only moves the failure to Discord discarding a
late reply. You get the designed fallback: an empty list, no error toast, typed text still submits.
The bot is a heavy client by construction, one request per keystroke, which is why self-hosting
Photon is on the Roadmap.

## Timezones

`timezone:` suggests zones as you type, from whatever tzdata the runtime ships — no list to keep
current and nothing to configure. A city is enough (`berlin`, `new york`), and so is a US or UK
abbreviation (`PST`, `ET`, `CET`, `UTC`). Full IANA names still work, including legacy links like
`US/Eastern`. Before the first keystroke it offers `DEFAULT_TZ` and a handful of common zones.

Typed text that pins down exactly one zone is accepted. Something that matches many — `america`,
`europe` — is not: the reply lists the nearest few instead of picking a city on your behalf.

Abbreviations map to city zones on purpose. ICU accepts `EST` as a real zone ID, but it's a fixed −5
that never observes daylight saving, so a July event booked in "EST" landed an hour late; `EST` now
means `America/New_York`. Ambiguous ones are left out rather than guessed — `IST` is India, Ireland
*and* Israel, so it falls through to the candidate list.

## Recurring events and pauses

Create a recurring post with:

```
/event create title:Weekly walk when:tomorrow 7pm recurring:weekly timezone:America/Los_Angeles
```

`recurring` is optional and accepts `daily`, `weekly`, `bi-weekly` (every 14 days), or `monthly`.
Omit it for a one-off event. The post and digest show its cadence. When the start time is reached,
the next sweep updates **the same post** and digest to the next future occurrence, normally within
ten minutes. Existing RSVPs carry over; the reminder marker resets for the new occurrence.

The event stores the selected timezone and original calendar date in its embed. Daily and weekly
events keep the same local clock time across daylight-saving changes. Monthly events use the
original day, clamped to the month's last day when necessary: January 31 → February 28 → March 31.
A clock time skipped by daylight saving skips that occurrence, keeping later ones at the chosen
clock time. A restart skips missed occurrences directly, without a burst of old reminders.

`when:TBD` also works with a cadence; automatic advancement waits until a date is assigned.
`/event edit when:` assigns a new anchor date. As with create and autocomplete, its timezone is
the explicit `timezone:` option or `DEFAULT_TZ` if omitted. `/event edit recurring:` changes the
cadence without moving the current instant; `recurring:none` stops repeating. An unrelated title
or description edit leaves the original anchor intact. Old boolean recurring records stay listed
with **Schedule not set** until an organizer chooses a cadence with `/event edit recurring:`.

Recurring posts stay in the digest and the bot doesn't archive them as finished. Discord may
still archive a quiet post; the bot searches every archive page and reopens the post when its
next occurrence needs updating. Cancelled recurring posts stay listed, struck through, and don't
advance until reinstated.

To take a post out of the digest temporarily, run this **inside that post**:

```
/event pause duration:3d
```

Only the organizer or someone with **Manage Threads** can pause it. There is no target-channel
option: the command changes only the event post it's run in, within this server's configured
forum. It also works on one-off events. Durations accept minutes, hours, days or weeks, including
decimals such as `1.5h`; a day means 24 hours. Running pause again replaces the deadline from now.

Pausing hides the entry immediately, adds **Paused until** to its post and turns its status dot
yellow. It leaves RSVPs intact and suppresses reminders and date advancement during the pause.
Both the schedule and exact pause deadline live in the event embed, so restarts don't lose them.
Once the deadline passes, the next sweep catches up to the next future occurrence and restores
the recurring post to the digest, normally within ten minutes or on startup. A paused one-off
returns if it still meets the normal date cutoff. Cancelled posts keep their red status while paused.

## Post status

Every forum post's name opens with a dot saying where its event stands: 🟢 upcoming or recurring,
⚫ started or done, 🟡 paused, 🔴 cancelled. That reads from the channel list, which the embed colour
inside the post can't reach. An emoji is all that's available — Discord won't colour a thread name, and its only
genuinely coloured text is an ANSI block, which can't hold a link.

The dot and the colour come off one rule, paired in a single `STATUS` record so they can't drift,
and both follow **event state** rather than archive state. Those look like the same question and
aren't: posts auto-archive after a week of quiet, so an upcoming event nobody chats in would go
red — and renaming an archived thread reopens it, so a dot meaning "archived" destroys the thing it
reports. The sweep only renames open posts, and sets the final dot on the way out. A recurring
rollover intentionally reopens its post so its new date can be saved.

So a post archived before this landed keeps its undotted name until something reopens it, and an
open post's name is fully derived — the sweep puts a hand-edited one back within ten minutes.
Retitle with `/event edit title:`, which changes both.

## Cancelling

`/event cancel` keeps the post. It renames it to `🔴 Title — CANCELLED`, turns the embed red,
strikes the title through, drops the RSVP buttons, and DMs Going + Maybe plus the organizer with the
event name, the server, the old start time and a link back. The digest keeps the event listed but
struck through until its start time passes, so anyone who missed the DM still sees what happened.
Recurring and undated events stay listed until paused or deleted. The DM is best effort — a
member with server DMs off just won't get one, and the confirmation says how many couldn't be
reached.

`/event edit uncancel: True` reverses all of it — marker off, dot and embed back to green, buttons
back with everyone's answers intact — down to a second DM to the same people, because anyone who
read the first has already written the event off. Add `when:` to reinstate at a new time and the DM
quotes it. No confirm button here: un-cancelling isn't the destructive direction.

**To remove an event entirely, delete its forum post** — the post is the record, so cancelling only
marks it. The digest catches up a second later, since the bot watches for thread deletions rather
than waiting for the sweep. Archiving does *not* cancel: archived posts stay in the digest on
purpose, since an event nobody chats in shouldn't vanish.

Only the organizer or someone with Manage Threads can edit, cancel or pause. The *bot* authors every event
post, so Discord's own "delete post" is mod-only here — which is why cancelling is a command.

## Development

```sh
bun install
bun run test       # vitest — `bun test` is bun's own runner and ignores this script
bun run typecheck  # tsc — the real gate; it only checks, it never emits
bun run dev        # reads .env via --env-file
```

Bun 1.4 or newer, because it runs the TypeScript sources directly and provides `node:sqlite`. No
build step and no `dist/` — which is also why every relative import names a `.ts` file: specifiers
resolve literally, and nothing rewrites `./event.js` for you. Node 24 runs it fine too, but
`bun.lock` pins the versions in a format only bun reads.

`src/` is the bot, `test/` mirrors it. Tests cover time parsing and timezone conversion, the
embed⇄event codec, address formatting, configuration, setup persistence, permissions and routing
between servers. Discord I/O is stubbed; the suite makes no network calls.

| File | Job |
|---|---|
| `src/index.ts` | Boot, per-guild contexts and lifecycle, schedules the 10-minute sweep |
| `src/sweep.ts` | Recurring occurrence updates, reminders, status updates and archiving for finished events |
| `src/recurrence.ts` | Cadence choices and calendar arithmetic using the event's stored timezone and anchor |
| `src/config.ts` | Environment validation and defaults |
| `src/database.ts` | Per-guild SQLite setup records and schema initialization |
| `src/context.ts` | Per-guild setup cache and validation of the explicitly selected channels |
| `src/setup.ts` | Reads and retires legacy pinned setup records during the SQLite migration |
| `src/event.ts` | The model: embed codec, forum listing, RSVP rules, the status rule |
| `src/digest.ts` | Renders the digest and edits the pin in place |
| `src/interactions.ts` | Assembles `/event` from `src/commands/`, routes interactions, owns the RSVP buttons and autocomplete |
| `src/commands/create.ts` · `edit.ts` · `cancel.ts` · `pause.ts` | One file per subcommand: its slice of the `/event` definition beside the handler that serves it. `cancel.ts` also owns the confirm button and the DMs |
| `src/commands/setup.ts` | Defines `/setup`, checks Manage Server and confirms the saved channel selection |
| `src/commands/shared.ts` | What more than one subcommand needs: reply shapes, `when:`/`timezone:` parsing, the organizer-or-mod guard |
| `src/places.ts` | Address lookup for `where:` — Photon adapter and label formatting |
| `src/time.ts` | Wall clock + IANA zone → instant, DST-correct. Also the loose `when:` parser and the one place a 12-hour string is built |
| `src/types/` | Shapes that cross module boundaries, one file per concern. Declarations only, so it erases at compile time. A type with one consumer stays next to it |
| `src/utils/tryCatch.ts` | `await tryCatch(promise)` → `{ data, error }`, for calls allowed to fail |

### If embeds come back empty

The bot reads only its own messages, which is why it needs no privileged intents. If event fields
ever read back blank, enable **Message Content Intent** in the developer portal — that's the one
assumption in the design worth knowing about.

## Deployment

Three workflows in `.github/workflows/`, each doing a single thing:

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | pull requests, and whenever Publish calls it | `bun run typecheck`, `bun run test`, and builds the image without pushing |
| `publish.yml` | push to `main` | Calls CI, then pushes `ghcr.io/wangryan408/grasstoucher:latest` and `:<sha>` |
| `deploy.yml` | a successful Publish, or the Run workflow button | SSHes to the host, pulls the new tag, restarts, and fails if the container isn't up |

Merging to main is the deploy. Tests failing means nothing reaches GHCR, and nothing reaching GHCR
means no deploy — `needs:` does that, which is why the tests live in a workflow Publish can call
rather than a separate run nobody is waiting on.

Every image is tagged with its commit sha as well as `latest`, so a rollback is **Actions → Deploy →
Run workflow** with an older sha in the tag box. The automatic path deploys the sha rather than
`latest`, so `docker compose ps` on the host names the commit that's actually running.

The deploy sends one thing over the wire: the tag. `deploy/host-deploy.sh` is pinned as a forced
command on the host's key, so the runner can't ask for a shell, a directory of its own choosing, or
a script of its own — it names a tag and reads back the log. Anyone holding a leaked `SSH_KEY` gets
the same narrow deal.

**Deploying to a host with no public address** — the WireGuard peer config, the secrets, and the
traps that cost time getting there: [docs/deploy-home-server.md](docs/deploy-home-server.md).

## Roadmap

Not commitments — what's worth doing next, and what's already landed.

**✅ done · 🚧 in progress · ❌ not started**

| Status | Change | The finding, and what it costs |
|:---:|---|---|
| ✅ | **Recurring posts and timed pauses** | Optional `daily`, `weekly`, `bi-weekly` or `monthly` advances the same post to its next occurrence; `/event pause duration:3d` hides only the post it's run in until the deadline expires. The finding: fixed millisecond intervals drift across daylight saving, and advancing from February's clamped date loses a January 31 anchor. Costs: cadence, timezone and original date stored in the embed, calendar arithmetic with month-end clamping, full archive discovery, and one sweep of up to ten minutes before rollover or pause recovery. RSVPs carry over, reminders reset, and restarts jump over missed occurrences. Old boolean records need an explicit cadence selection. |
| ✅ | **TBD event dates** | `when:TBD` creates an undated event or clears an existing date; an ordinary `when:` schedules it later. The finding: the start time also drives the embed codec, digest order, status and sweep, so accepting one extra word in the slash command wasn't enough. Costs: a nullable start time stored as an explicit **When: TBD** field, undated events listed after scheduled ones, and reminders and timed archiving held until a date exists. Date changes reset the reminder marker. |
| ✅ | **Run across servers without env IDs** | Global commands and a separate context for each server, with `/setup forum: digest:` choosing both channels explicitly. The finding: channel names cannot tell you which forum an admin intended, and in-memory setup disappears with the container. One SQLite `guild_config` table stores channel IDs by guild; a named Docker volume carries it across container replacement. Costs: Manage Server for setup, Pin Messages for the digest, a one-time scan to migrate old pinned setup records, and one channel fetch per server per sweep. Every event command and button stays blocked until both channels are configured. Back up the volume; `docker compose down -v` removes it. |
| ❌ | **Self-host Photon** | The public instance disclaims its own availability, and on 2026-08-12 spent ~30s per query against a 2s budget — indistinguishable from down. Code cost is one env var (`ENDPOINT` in `src/places.ts`); the rest is operational, and that's the catch — Java 21+, a search index, and a 64GB RAM recommendation at planet scale, so a 16GB box means a country dump and a capped heap. Plausible, untested. Hosted providers want an account and a key, the exact thing Photon avoided. |
| ✅ | **Status dots on post names** | 🟢/⚫/🔴 on post names, so state reads from the channel list. The finding: **archive state can't carry it** — renaming an archived thread reopens it, so a dot meaning "archived" destroys what it reports, and auto-archive-on-quiet would redden upcoming events anyway. Discord won't colour a thread name either, so the dot follows event state off the existing `embedColor` rule. Costs: a post now greys at its start time rather than at archive time, one rename per state change against a 2-per-10-min limit, and posts archived before this keep undotted names. |
| ✅ | **Looser `when:` input** | `tomorrow 7pm` via `chrono-node`, with the resolved instant echoed back before submit — a parser that guesses without showing its work just moves the mistake to after the post exists. The finding: **chrono's own `Date` is the wrong output**, since it resolves against one fixed offset, so a November date parsed in August comes out an hour off; the bridge hands its wall-clock *components* to `zonedToDate` instead, which `test/time.test.ts` pins. Cost: the first runtime dep past discord.js, 2.76 MB. date-fns and Luxon can't parse `tomorrow` at all; `Temporal` would replace `zonedToDate` outright but is still `undefined` in Bun 1.3.2. |
| ✅ | **Deploy on merge** | CI on pull requests, a GHCR image on push to `main`, a deploy at the sha just built — so dispatching an older sha is the rollback, free. Both real faults *succeeded* rather than failing: a forced command leaves the client's string in `SSH_ORIGINAL_COMMAND`, so a piped heredoc lands on stdin unread and its variables vanish silently — hence a versioned `deploy/host-deploy.sh`; and `wg-quick up` exits 0 without ever handshaking, which is why the job pings. Standing cost: `docker-compose.yaml` and `host-deploy.sh` live on the host, and CI never updates either. |
| ✅ | **Looser `timezone:` input** | Autocompleted from `Intl.supportedValuesOf('timeZone')` — no dependency, no list to maintain. The finding: strictness wasn't buying correctness, since ICU accepts `EST`, a fixed −5 with no daylight saving, so the old validator waved through the input most likely to be an hour wrong. `DEFAULT_TZ` goes through the same resolver now. |
| ✅ | **Convert to TypeScript** | The embed codec is where types earn it: `fromEmbed` returns a shape the digest, the sweep and every handler assume, and one round-trip test was the only thing enforcing it. Cost: a Node 24 floor and `.ts` in every relative import — but no build step, since Node strips types natively. |
| ✅ | **A `tryCatch` wrapper** | Five fallible calls were guarded three different ways — `Promise.allSettled`, `.catch(() => {})`, bare try/catch. `{ data, error }` covers all of them, and makes the exception visible: `handleAutocomplete` keeps its own try/catch because `getFocused(true)` throws *synchronously*. |
