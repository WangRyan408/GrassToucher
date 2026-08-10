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
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417607680
```

That grants View Channel, Send Messages, Send Messages in Threads, Create Public Threads,
Manage Threads, Manage Messages (to pin the digest), Embed Links, and Read Message History.

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
| `/event edit [title:] [when:] [where:] [description:]` | Run it **inside the event's thread**. Organizer or anyone with Manage Threads. |

Times are stored as an instant and rendered with Discord's own timestamp markup, so
everyone reads them in their own local timezone.

**To cancel an event, delete its forum post.** The post is the record, so deleting it is the
cancellation — there's no command for it. Archiving does *not* cancel: archived posts stay
in the digest on purpose, because forum posts auto-archive after a week of quiet and an
event nobody chats in shouldn't vanish.

## Development

```sh
npm install
npm test          # node --test, no framework
npm run dev       # reads .env via node --env-file
```

`src/time.js` and `src/event.js` hold the only logic worth testing — timezone conversion
and the embed⇄event codec. Everything else is Discord I/O.

| File | Job |
|---|---|
| `src/index.js` | Config validation, boot, interaction routing, the 10-minute sweep |
| `src/event.js` | The model: embed codec, forum listing, RSVP rules |
| `src/digest.js` | Renders the digest and edits the pin in place |
| `src/interactions.js` | Slash command definitions and handlers |
| `src/time.js` | `YYYY-MM-DD HH:MM` + IANA zone → instant, DST-correct |

### If embeds come back empty

The bot reads only its own messages, which is why it needs no privileged intents. If event
fields ever read back blank, enable **Message Content Intent** in the developer portal —
that's the one assumption in the design worth knowing about.
