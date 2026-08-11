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
| `/event create title: when: [where:] [description:] [timezone:]` | `when` is `YYYY-MM-DD HH:MM` on a 24-hour clock. `timezone` is an IANA name like `Europe/Berlin`, defaulting to `DEFAULT_TZ`. |
| `/event edit [title:] [when:] [where:] [description:] [uncancel:]` | Run it **inside the event's thread**. Organizer or anyone with Manage Threads. `uncancel: True` brings a cancelled event back. |
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
npm install
npm test          # node --test, no framework
npm run dev       # reads .env via node --env-file
```

`src/` is the bot, `test/` mirrors it — `test/event.test.js` covers `src/event.js`, and so on.
Only three files have logic worth testing: timezone conversion, the embed⇄event codec, and
address formatting. Everything else is Discord I/O. The suite makes no network calls.

| File | Job |
|---|---|
| `src/index.js` | Config validation, boot, interaction routing, the 10-minute sweep |
| `src/event.js` | The model: embed codec, forum listing, RSVP rules |
| `src/digest.js` | Renders the digest and edits the pin in place |
| `src/interactions.js` | Slash command definitions, handlers, cancel/reinstate DMs |
| `src/places.js` | Address lookup for `where:` — Photon adapter and label formatting |
| `src/time.js` | `YYYY-MM-DD HH:MM` + IANA zone → instant, DST-correct |

### If embeds come back empty

The bot reads only its own messages, which is why it needs no privileged intents. If event
fields ever read back blank, enable **Message Content Intent** in the developer portal —
that's the one assumption in the design worth knowing about.

## Roadmap

Not commitments — the next three things worth doing, in the order they'd pay off.

**✅ done · 🚧 in progress · ❌ not started**

| Status | Change | Why, and what it costs |
|:---:|---|---|
| ❌ | **Convert to TypeScript** | The embed codec is where types earn their keep: `fromEmbed` returns a shape that `toEmbed`, the digest, the sweep and every handler all assume, and nothing enforces it today but one round-trip test. discord.js ships its own types, so the work is mostly a `tsc` step plus annotating `src/`. The cost is what's lost — this is currently plain ESM that runs straight off the filesystem, which is why `npm run dev` and the Dockerfile are three lines each. |
| ❌ | **Looser `when:` input** | `YYYY-MM-DD HH:MM` is the only accepted format and the most-rejected input in the bot. `tomorrow 7pm`, `friday 19:30`, `in 2 hours` should all parse. Autocomplete is the right surface — the plumbing already exists for `where:`, and echoing the resolved date back *before* submit is what makes fuzzy parsing safe rather than surprising. `timezone:` deserves it for a different reason: IANA names are impossible to guess. |
| ❌ | **A `tryCatch` wrapper** | Fallible calls are guarded ad hoc — `Promise.allSettled` for the DM fan-out, `.catch(() => {})` on the error reply, a hand-rolled try/catch in the autocomplete handler because the global one structurally can't reach it. One helper returning `[result, error]` would make those uniform, and more usefully make it visible which calls are *deliberately* left unguarded. |
