# Dogfight: Martial Arts TTRPG — Project Plan

**This document describes the project as it is now.** It is the single source of truth for what the app does and why, and it is kept current in the same commit as every change (see Working rules). Earlier versions, which kept a running history of every phase, measurement and playtest, are in git history; the last of them is commit `031f550`.

## Overview
A small, self-hosted virtual tabletop for one group (a GM and their players), used remotely from several devices at once. There is no login: one shared link, and a role picked on each visit. The look is a fighting game's (red and black, cut corners).

The game system is **Panic at the Dojo: Patch'd Up** (Vel Mini / Liberi Gothica; CC-BY-SA 4.0). Its fights are **fully automated**: people lay dice and tokens on Actions and answer the choices that come up; the engine does the rest (damage, movement, tokens, triggers, the End Phase). Around the fights sit the table's shell: characters and their sheets, the Scene tab for roleplay, chat with a Dice Tray, music, Events, Relationships.

## Working rules
- **Keep this plan current, always, in the same commit** as the change: a mechanic, a column, an event payload, a UI behaviour, a decided item, a rule stated in conversation.
- **Commit straight to `main`** (the user's standing instruction: no PRs). Every push deploys (Render builds `main`). Before each commit: `npm test`, `npx eslint .`, `npm run build --prefix client`, and the fight playtests the change touches.
- **Never poll GitHub**; events arrive on their own. There is no CI.
- **Ask** whenever a choice is genuinely the user's.
- **Nothing is left "by hand"** in a fight (the user's standing rule): the core rules are fixed, so custom code for any of them is worth writing.
- **No sound effects, ever** (decided). The only audio is the Audio Player's music.
- "**Automate homebrew content**" means the runbook in Commit Homebrew.

## The pivot
The app's original game system (Moves, Perks, Quirks, the 8 Stat dice, Stamina, the Combat Arena, the Compendium, the Rules page) was removed in one pass and replaced by Panic at the Dojo. Its code and docs are in git history. At the first boot after the pivot the old data was archived inside the database (`compendium_archive`, append-only; no pictures) and the old tables dropped. The GM can download the archive from Settings → Old System Archive (`GET /api/compendium-archive[/:id]`).

## Stack and hosting
- **Frontend:** React + Vite, Tailwind CSS v4 (`@tailwindcss/vite`, tokens in `client/src/index.css`), Framer Motion, lucide icons, game-icons (`react-icons/gi`, CC BY 3.0, credited in the app). An installable PWA.
- **Backend:** Node 22 + Express, which also serves the built client (one deployable app). Socket.io for everything live. An unknown `/api/*` path answers a JSON 404.
- **Database:** Turso (libSQL) in production, a local `local.db` file in development. The server connects straight to the primary (no embedded replica). Missing tables and columns are created at startup (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`), so schema additions must be additive. libSQL enforces foreign keys on this connection.
- **Hosting:** Render's free web service (`render.yaml`: `healthCheckPath: /api/health`, the `TURSO_*` secrets, `GITHUB_TOKEN` for Commit Homebrew). It sleeps when idle. The server listens before it opens the database and answers `503` until boot finishes.
- **Keeping it fast (what the code relies on):**
  - **Round trips, not queries, cost time.** Statements that can go together go in one batch (`readMany` / `writeMany` in `server/db.js`). `server/dbProfile.js` (`DOGFIGHT_PROFILE=1`), `scripts/profile-actions.mjs` and `scripts/latency.mjs` measure it.
  - **Pictures are URLs, never bytes in JSON.** Every picture is stored as base64 in its row with a content hash and served at `/api/img/:kind/:id/:hash` with long caching (`server/images.js`). Payloads carry the URL. Hashes are backfilled at boot.
  - **Lists never read picture bytes** (`server/lightSelect.js`: `lightAll(table)` selects every column but `*image_data`, with a `has_…` flag). Used by the Scene, character, Temp NPC and Scene Picture lists.
  - **The stage payload is small:** hashes and flags, not pictures; drawings only when the active Scene changes (strokes have their own events); fighter setup only for the active Scene's characters; derived builds cached until a build is saved (`fighterStances.loadAllDerived`). HTTP responses are compressed.
  - **Clients keep lists for the session.** The Scene tab's lists (Scenes, folders, characters, Temp NPCs) load once and stay live from socket events (`client/src/lib/liveList.js`, `sceneLists.js`); `useRoster` is one shared copy.
  - Requests made on every stage update are debounced (Interrupt offers, the active range, the dice board's fighter state).
- **Mobile:** every page works on a phone (bottom nav below `md:`, 44px touch targets). The Scene tab is landscape-only on a phone (an orientation gate asks to rotate). In Combat and Simple Combat a phone gets a small fullscreen toggle in the bottom-left corner (`FullscreenButton.jsx`; hidden where the browser can't fullscreen a page, e.g. iPhone Safari). Playwright drives a phone matrix (`playwright.config.js`, `e2e-mobile/`).

## Roles and access
- **A role is picked on every fresh load** (`RoleModal`): **GM**, or **Play as…** one of the PCs. It is a display filter, not authentication (the accepted trust model; never add accounts). The server keeps the identity per connection (`identity:set`, re-sent on reconnect) and uses it wherever an answer depends on the viewer.
- **A Player** lands on their own sheet; there is no roster for them. **The GM** sees and edits everything.
- **NPCs assigned to a player:** on an NPC's sheet the GM picks "Assigned to: Nobody / <PC>'s player" (`character:assign`). That player then controls the NPC everywhere, like their own character. One server rule decides control: `controlsCharacter(viewer, characterId)` (`server/control.js`); the client's copy is `useControl()`. Deleting a PC hands their NPCs back to the GM.
- **Privacy by absence:** whatever a viewer may not see is left out of their payload (secret Counter Gates, GM-only Event lanes, hidden summons, other players' Relationships boards), never sent with a "hide this" flag.

## Pages
Header: logo (→ home), Characters/Character, Scene, Events, Search, Chat, Settings; the GM also gets Homebrew (flask). Below `md:` a bottom nav (Characters, Chat) and a More menu.
1. **Role modal** — every fresh load.
2. **Characters** (`/`, GM) — the roster: cards with portraits in nested folders (`character_folders.parent_id`, GM-managed; deleting a folder moves its contents up). **Add Character**: name, PC/NPC, folder, optional portrait with crop.
3. **Character sheet** (`/character/:id`) — a header with the name and portrait (crop editor), and tabs: **Counters**, **Combat** (the builder), **Role-play**, **Relationships** (PCs), **Scene Pictures**. A back arrow returns the GM to the folder the sheet was opened from.
4. **Scene** (`/scene`) — chromeless and fullscreen; the roleplay stage and both fight modes.
5. **Events** (`/events`).
6. **Homebrew** (`/homebrew`, GM).
7. **Settings** (`/settings`).
Chat is a side panel on desktop and a full-screen overlay on a phone (with an unread badge). One error boundary shows a reload prompt if a page throws.

## Characters
- **Role-play tab:** answers to seven fixed questions (keyed by their exact text) plus up to 20 custom ones.
- **Scene Pictures tab:** the transparent-PNG art a character shows on the Scene stage (`scene_pictures`), with crops; "copy from profile picture".
- **Deleting a character** cascades through everything they own. Relationships nodes pointing at them become board-local people (the delete would otherwise be refused by a foreign key).

## Counters
Persistent clocks on a character's Counters tab: a name, 2-20 pips, +/−, and an optional **Reward** tag (Story, Statistic, Perk, Move, Combat Prowess; a label only).
- **Gates:** the GM marks one pip with a name, a description and a **Secret** switch. The pip is drawn twice the size for everyone; a secret Gate's words are left out of Players' payloads (`visibleGate`, `server/counterGates.js`; its own per-viewer channel `counter_gates:updated`). One Gate per pip. Reaching one (counting up) posts a chat line naming it, never a secret one.
- A `+` on a chat roll card adjusts or creates the roller's Counters (`CounterAdjustDialog`).

## Chat and the Dice Tray
One shared feed (`ChatPanel.jsx`). The last 300 entries load; the log is cleared on every boot and by the GM's Clear Chat.
- **Messages:** text (≤2000) and/or a picture or GIF, posted as your character (a **Post as** picker for assigned NPCs) or, for the GM, as **GM** (`character_id` sentinel 0).
- **Dice Tray:** d4-d12 buttons and a ±20 modifier; the server rolls and posts `1d{N} + mod`.
- **Fight cards:** reminders and notices from the engine (orange "by hand" style for text-only rules) and **Stance rolls** (the turn's dice, shown only; the dice board opens from the Action button).

## Relationships board
A PC's infinite 2D board (pan and zoom): NPCs dragged from the world roster or invented people, joined by named, coloured, directional relationships with bendable edges, nicknames and notes, emoji labels (with favourites), undo, and keyboard controls. It is private to that character's viewer and the GM, who can both edit. Phones are view-only. Players see the NPC roster in its rail (knowing who exists is not reading their sheet). Code: `RelationshipBoard.jsx` and its parts (`RelationshipNode`, `RelationshipEdges`, `RelationshipEditor`, `RelationshipVoid`, `RelationshipRail`), handlers in `server/index.js` (`relationships:*`, per-viewer `relationships:updated`); tables `relationship_people / nodes / edges`. The feature is complete.

## Events tab
Sticky notes in lanes, for the story's threads (`server/events.js`, `EventsPage.jsx`).
- **Lanes (GM):** a name and a visibility, **Everyone** or **GM only**; rename, reorder, delete (notes move to the first lane of the same visibility, or Everyone → GM only, never the reverse).
- **Notes:** up to 280 characters, five colours, an author. Only the author or the GM edits or deletes; anyone who sees a note may drag it along its lane or into another lane they can see (touch drags by a grip).
- Shaped per viewer (`shapeBoard`): a GM-only lane never reaches a Player.

## Settings
Per browser unless noted:
- **Primary Color** — the brand hue (`client/src/lib/theme.js`).
- **Scene Stage** — figure height, spacing, picture size, name plates (`sceneSettings.js`).
- **Fight animations** — Normal, Fast (half the time) or Off; a device asking for reduced motion starts at Fast (`vtt-board-fx-speed`).
- **Simple Combat Lanes** (GM, whole table) — 1-3 lanes of ten, and the lanes' height on the screen (`table_settings`).
- **Old System Archive** (GM).

## GM Tools
A round widget on every page, GM-only (`GmToolsWidget.jsx`); the server checks the role itself.
- **Fight Setup** (`CombatWeightTool.jsx`; was "Preset Narrative Combat Weight"): on the Scene in a fight mode, the fight's Cinematic Weight and each fighter's level and table (**Apply** resets them to full bars), **infinite HP** per fighter, and the book's Complications and Battle Parameters. See Fights → Fight Setup.
- **Audio Player:** a GM-run soundtrack every client hears at the same point of the same song. Songs are YouTube links played in an off-screen iframe. The server stores an **anchor** (track, start time, offset) and clients measure their clock against the server's (lowest-RTT ping, retried with backoff). **Better silent than out of sync:** a client that can't place itself goes quiet. Playlists, shuffle, repeat, per-device volume.
- **Re-encode Images:** finds oversized stored pictures and re-encodes them.
- **Commit Homebrew:** see Commit Homebrew.

## Scene tab
A GM-controlled fullscreen stage for roleplay, in the visual language of a light novel: a background picture (**a Scene**) with characters' art sliding on and off as they are summoned.
- **Scenes** live in nested folders (`scene_folders`). Activating one **force-navigates every Player** to `/scene`. A Scene can be copied (sharing the backdrop's bytes via `image_source_id`). Background fit per Scene.
- **Temp NPCs:** a light, GM-only roster for Scene figures (`temp_npcs`, own folders). They never take part in fights.
- **Summons:** a figure is summoned with one of its owner's Scene Pictures (swappable on stage), on the GM's side (right) or a Player's (left, from their dock). Summons are **per Scene** (prepared in advance). Figures can be moved, resized, hidden (GM; hidden ones are left out of Players' payloads) and unsummoned.
- **Drawings** (pen and eraser, both roles), **Scene notes** and the **master note** (GM), **Timestamps** (GM cutscene cards played to everyone), and the **hide-UI** cinematic mode.
- **The GM's drawers:** the cast (characters in their folders, Temp NPCs) on the left, Scenes on the right; both keep their lists for the session.
- **The mode toggle (GM):** Scene / Simple Combat / Combat, per Scene; everyone follows. See Fights.

## Fights (Panic at the Dojo)

### The content
- **The rules data** is the user's export of *Panic at the Dojo 2e / PATCH'D UP Beta* in `client/src/data/patd/` (content, JSON Schema, import guide): 12 Forms, 65 Styles, 12 Freestyles, 21 Archetypes with Focused / Fused / Frantic variants, 6 Builds, Skills, 183 Actions, 169 Abilities as event rules, 34 Super Moves, advancement tracks, Features, Warrior's Paths, NPC types and token mechanics. Ids are stable strings; builds store ids.
- **It is declarative:** effects are trees of `op` nodes with `{ ref }` values and `{ operator, args }` expressions, run by the interpreter (`client/src/lib/patd/interpreter.js`) through an explicit dispatch table, never `eval`. Shared by the client and the server. `server/test/patdContent.test.js` validates it against the schema and checks every reference.
- **Rulings** (`client/src/lib/patd/rulings.js`, applied when the content is indexed; their note joins the rules text): Halcyon Style discards only a Status token. Tough It Out costs 3+ or 9+. Fused Trickster stays allied turns. The Untouchable's Dodge costs 1 (read plainly). Deadly Trap deals 3.
- **House rules (decided):**
  - **The diamond grid:** a diagonal counts 2 (`|dx| + |dy|`) for Ranges and movement; "adjacent" is the four lateral neighbours. (The book counts a diagonal as 1.)
  - **Token cap 9** (Training 4, Shield 8, Challenge 1).
  - **Challenge is a Unique token:** a "discard a Unique / any token" may take a held Challenge.
  - **Gates add up:** every Gate a number reaches applies, unless it says "instead".

### The character builder (the sheet's Combat tab)
- **Everyone builds** from the content: a hero type (Focused / Fused / Frantic) or NPC type (Warrior / Boss / Stooges), Archetypes, Forms, Styles or a Freestyle, a Build, Skills (one may be the free two-word Skill). Nothing is locked; **legality only warns**.
- **Derived Stances** ("{Style} {Form alias} Stance"): the Form's dice (Freestyle-modified), the level's bonus die, range from the Style and the Form's construct rules. The Machine has two Forms per Stance.
- **Levels 1-10 and XP** (Victory 2, Defeat 1; End Combat awards it). **Level up** opens a window with everything the level brings and every choice it needs (Super Move, Stance, Archetype, Form or Style, Warrior's Path…).
- **Hit spends:** Ask / Auto / Never for Power, Iron and Shield (players Ask, NPCs Auto).
- **The sheet's reference:** Actions as book-style cards (Basic and Personal side by side, then Super Moves), and the Abilities ("Active effects") with their rules text.
- **The combat token picture** (round, cropped) is set here too.
- Code: `client/src/lib/patd/build.js` (`deriveBuild`, `normalizeBuild`, `levelInfo`…), `server/builds.js` (`build:save|clear`), `components/builder/`.

### Fight modes
Each Scene has two independent fights: **Simple Combat** and **Combat**, each with its own placements, HP, tokens, tiles and initiative.
- **Simple Combat:** the Scene stays (figures locked in place) with 1-3 perspective lanes of 10 spaces over it. Fighters stand on it as miniatures (their Scene Picture on a plinth, grabbed by the base). Lanes are a small grid (lane = row) with the same rules; extras wait in a tray.
- **Combat:** a top-down map — the Scene's **Combat Background** (or its artwork), with a square grid (size, offset, opacity; 10% padding). The GM places fighters as round tokens (several copies of one character are independent). Players move their own. Zoom 0.5-5×, wheel, pinch and pan; the camera may leave the map until a strip is left. The Giant fills 2×2.
- **Map tiles:** Fog, Pit, Pit Trap, Rubble, Trap, Wall, Deadly Trap, and markers (Danger Zone, King Zone, Control Zone, the Important Thing), placed from the palette by anyone; moved or removed only by who placed them (the GM: any). The book's stacking rules (`client/src/lib/mapTiles.js`). A personal **lock** makes placed obstacles a picture only (drags pan the camera). **Copies** (a fighter's replicas) are tiles too.
- **Hand moves:** dragging a fighter just moves them, unless they hold Speed in a fight: then "Do you need to spend Speed tokens?" **No** moves them; **Yes** is the engine's Free Movement to that square (cheapest path, Fatigue applied, Speed paid for the spaces moved).

### Starting a fight, rounds and turns
- **Start Combat** (GM): Allies / Enemies columns, the side that starts and the opener. **Initiative:** each HP bar is one turn a round; round 1 alternates sides at random after the opener, never the same fighter twice in a row (`client/src/lib/initiative.js`). **Later rounds repeat it** (`repeatRound`); the GM drags entries on the rail (`fight:reorder`).
- **Cinematic Weight** (the GM tool): Featherweight to Worldweight sets HP per bar (10-30), Heal Value, Bleed Value and Super Moves per side per round (0-2). Level bonus HP per bar and the bonus die come from the Hero or Warrior table (`client/src/lib/cinematicWeight.js`).
- **The turn** (the book's phases): a Frantic Hero assembles a Stance, or several Stances ask which; the Stance's dice roll into chat; start-of-turn rules; Early Movement (everyone holding Speed: Move or Done); the Action Phase (the active fighter); Late Movement; the **End Phase**: end-of-turn rules, Traps, Burning (damage, discard half rounded up, no Iron), the Challenge removed if its holder tried to damage their Challenger, everyone discards 3 Speed, Fatigue discard if they didn't move.
- **Ending a turn:** the active player's **End Turn** button (asks first), the dice board's End turn, or the GM's Next turn. When a Commit finishes with nothing left in the Action Pool, End Turn is offered by itself (End turn / Keep going).
- **End Combat** (GM) clears that mode's initiative and awards XP.

### Playing a turn
- **The Action button** (bottom centre, for whoever controls the active fighter, the GM always) opens the **dice board**; **End Turn** sits beside it.
- **The dice board** (`components/actions/DiceBoard.jsx`): Basic Actions left, Personal right (the rolled Stance's, the always-available ones, Super Moves). **Drag or tap** a die onto an Action to place it: it shows an order number, and the card lights every Gate the number reaches (tap a lower Gate to stop there). A number below the Action's lowest cost is refused (`dieFits`). **Token costs** are placed by tapping (a dialog asks only what must be chosen). **Power · N · On/Off** Enhances the placed Actions' hits. **Commit** performs everything placed, in order, and closes the board; commits can repeat. The GM can **Retrieve** a committed die, undoing it from a snapshot.
- **Super Moves:** tap the card to use a pair of matching numbers 3+ (from Round 2, once per fight, the side's limit per round).
- **"No valid targets":** asked before anything is paid; No takes the Action back.
- **Picks happen on the board:** legal targets and squares glow (the Range faint red); a slim top bar names what is asking ("One-Two Form (Move 2)") with Skip where skipping is allowed. A required pick with one candidate asks nobody. Everyone sees every pick (`pick:view`). "Perform an Action" choices (Remember Your Training…) show the Actions as cards with the Gates reached lit.
- **Free Movement:** **Move** before each Action (reachable squares show their Speed cost; back arrow to undo); the movement phases offer Move or Done to everyone holding Speed.
- **Interrupts:** whoever can take a Reactive Action right now (a token Action they can pay and whose conditions allow it, or a dice Action a Chaos token can pay as a 4) gets **⚡ Interrupt · name**. Pressing it locks the table ("‹name› is interrupting") until they commit or give up; pressed while something resolves, it waits its turn. The GM can cancel a lock.
- **Mastermind Style** delegates: the Mastermind pays, an ally in sight performs.
- **The resolve stack:** while the fight's chain is busy, a plaque shows "Step N of M · ‹name›" (tap for the list); it lingers 1.6s once done.

### The engine
- **Server-authoritative.** `server/triggers.js` builds each fight's **world** (fighters, copies, tiles, the board, and every write: tokens, HP, Shield, damage, Challenge, movement, obstacles) and runs everything on the fight's chain (`onChain`), one job at a time. `server/engine/`: `actions.js` (perform, Commit, payments, Mastermind, Poltergeist), `hits.js` (Damage Resolution), `moves.js` (movement), `runtimeStore.js`. Pure rules in `client/src/lib/patd/engine/` (runtime, bus, modifiers, damage, board, turn) and beside the interpreter (`diceBoard.js`, `tokenCost.js`, `coverage.js`).
- **Runtime** (`fights.runtime`, persisted): per fighter the Action Pool, placements, turn flags, persistent choices, usage counters; temporaries with every content duration; scheduled effects; Super counts per side and round.
- **Event bus:** `emit(event, subject, payload)` routes each content event to the listening rules by relation (`self.*`, `ally*`, `enemy*`, `*_in_range.*`, …). Engine event payloads are a tested contract (`branches.test.js ENGINE_EVENT_FIELDS`).
- **Modifiers:** which `modify_rule` values apply to a fighter now — continuous Stance and constant Abilities (with their conditions), temporaries, the current Action's scope (`modifiersOn`, `ENFORCED_RULES`).
- **Damage Resolution (WEPIA)** (`engine/damage.js resolveDamage`, applied by `hits.js`): Weakness, (Pit), Power (the attacker's, plus the target's Weakness under Exploit Weakness, spent first and free), Iron (and Iron Form's "1 less from any source"), Shield (absorbs, breaks), Armor (3, then 2, then 1 per source per turn; temporary Armor last). Dizzy fighters take no damage; immunities by source. Unblockable lists skip steps.
- **Movement** (`moves.js`, `engine/board.js`): Action Movement, Teleport, Push and Pull (the pusher taps the landing; World of Cardboard smashes Walls into Rubble), Swap, Free Movement, Save Yourself, Traps, Rubble (Fatigue), Pits, the Outside (removed from play, Dizzy; Comeback), per-mover rules (Parkour, Spirit, Weightless, the Giant…). Fatigue only affects your own movement.
- **Prompts** (`trigger:prompt` / `trigger:answer`): confirm, choose (optionally `display: 'actions'` with a `rating`), targets (with squares and the Range), square; `skippable` ('__skip'). A turn's prompts close when the turn ends.
- **Every step shows as it happens:** writes mark the stage dirty and each prompt, move and job flushes it.
- **Coverage is 100%** (`coverage.js census`): every triggered and continuous Ability rule, every Action and every Super Move runs automatically. Engine-native rules (Mythical, Persistant, Poltergeist, Frenzy, Showdown, Transcendant Spirit…) and builder-built ones are listed there.

### Tokens, HP and states
- **Tokens:** Basic (Iron, Power, Speed), Status (Burning, Fatigue, Weakness), Unique (Challenge, Control, Chaos, Luck, Mentor, Inspired, Poltergeist, Training…, attached by the build), Super (Rapid Strike), and the special Armor (count of sources), Temporary Armor and Shield (`client/src/lib/panicTokens.js`, `panicIcons.jsx`). Held tokens show above a fighter with a count badge; a tap spends one (for whoever controls it).
- **HP:** a stack of bars sharing one Max HP; damage never carries into the next bar; a broken bar makes you **Dizzy** until the end of the turn; breaking the last bar is **Taken Out** (0 HP; healing revives). **Bleeding** at or below the Bleed Value (announced once per round on crossing). Shield shows as a blue extension of the bar; Armor as one ring per source (faint once used; the Tank's black).
- **Taken Out:** enemies can't target them; their Abilities are off (except a few named moments); no movement phases; grey and half-transparent with a skull; they keep their square.
- **Challenge:** damaging Actions must target the Challenger when legal; a Shield may block a Challenge; protections (Showdown, Distracting Style) enforced. The **target lock** (a red reticle on the Challenger and an arrow) shows during the holder's own turn.
- **The token panel** (tap a fighter): token +/−, the Challenge slot, the HP bars with +/−, Heal, Take damage (resolved by the engine in a fight), Stance.

### Fight Setup: Complications, Battle Parameters, infinite HP
The book's options for shaping a fight (pp.40-50), set in the **Fight Setup** GM tool **at any time**, before or during the fight, applying from that moment. Decided with the user:
- **Infinite HP — implemented** (not a book rule; for special fights). **Per fighter** (an ∞ switch in Fight Setup's list; GM only, `fighter:infinite { ref, on }`). A hit resolves in full — Shield, Iron, Armor, triggers, the animation — but HP never drops: no Bleed, no broken bar, never Taken Out. Every loss is counted (`combatants.damage_taken`, reset when switched on or when Apply refills HP; kept in undo snapshots), engine and manual alike (`changeHp` in `triggers.js`; `fighter:hp`, `fighter:damage`). The HP bar is a golden ∞ bar with "N damage taken". Playtest: `scripts/playtest-fight-setup.mjs`.
- **Complications** (all, planned): **Guest Heroes** (an NPC Warrior or Boss with one bar on the heroes' side, adding a slot each side; **every hero player controls it**), **Uneven Fights** (the GM sets each side's Health Bars; for the heroes Even — extra HP spread on every bar, rounded up — or Uneven — whole bars to chosen heroes — entered by the GM in the tool; Bosses up to 6 bars; a 1v1 is 2 bars each), **Switched Sides**, **Three Way Battles** (a full third **Renegade** side: a third column at Start Combat, initiative Heroes → Enemies → Renegades, and "enemy" meaning anyone not on your side everywhere in the engine).
- **Tilted Parameters** (one per side, planned): Chained Down (each chained fighter's controller places their named Wall next to them; 3 spaces from it, 5 from its Rubble, free once that is destroyed; immune to Open The Path), Disarmed (Range 1; also as an Arena Parameter for everyone), Enraged, Handcuffs (the GM pairs them), Keep Em Coming (applied to what they hold now: half HP on the current bar, half their Status tokens rounded up), Overwhelming Power, Too Slow, Weakened State.
- **Arena Parameters** (planned): Cage Match (no Outside: the edge holds everyone), Endless Field (the grid goes on past the map), Factory (**Conveyor Belt tiles** with a direction; everything on them is pushed 1 at the end of every turn unless 1 Iron or Speed is spent), Icy Floor (one more space after each movement), Pyroclasm (the Outside is Traps; Pits become Pit Traps; Rubble becomes Pit Traps each round end; removed Traps/Pits leave Rubble), **Second Floor** (a second floor beside the first, same size; Stairs in matching spots; Pits drop you a floor, 3 Fall damage by force), Traffic (Danger Zone: 6 damage at each round end), Trick Room (the edges wrap). Only one parameter replacing the Outside at a time. **The GM sizes the map; parameters only change the edges.**
- **Victory Parameters** (one per fight, planned): Last One Standing (default), King of the Hill, Outlast, Protect the VIP, Sabotage (Key Locations, Bombs with HP = Bleed Value, the Sabotage Action), Secure the McGuffin (Control Zones, the Important Thing, the Grab It! Action), Tournament Play (best of 3 or 5; a lost round resets positions, HP and tokens; a draw continues). All but Last One Standing and Outlast add **The Fight Must Go On!** (everyone heals 2× the Heal Value at each round end). **When a side wins, a card announces it; the GM ends the fight.**
- **Simple Combat:** everything that makes sense on a lane (Complications, Tilts, Victory; Cage Match, Icy Floor, Pyroclasm, Traffic, Trick Room by its lane ends); Factory and Second Floor are map-only.
- **Phases:** 1. Fight Setup and infinite HP (done). 2. Tilted Parameters. 3. Victory Parameters. 4. Complications and the third side. 5. Arena Parameters. 6. Factory and Second Floor.

### Board animations
Every change the engine makes is played back as a short animation, one beat at a time in strict order, on both fight views.
- **Server** (`server/fx.js`): the world records effects `{ kind, combatantId, before, after, data }` — tokens, damage (one beat for a hit's Shield, Iron and HP), heal, shield, challenge, dizzy, move (how: move, push, pull, teleport, swap; out of / into play), tile (placed, destroyed, moved; Copies included), turn, action (with the targets it landed on), super. Same-kind effects on different fighters back to back are one beat. `emitStageUpdated` sends `fight:effects` just before `stage:updated`, per viewer.
- **Client** (`client/src/lib/boardFx.js`, `useBoardFx.js`, `components/fx/`): a queue; **the display is held** — HP, tokens, Shield, Challenge, positions and tiles change exactly when their beat plays (rules and buttons use the real state). Over 4 beats waiting plays at 2×; a reconnecting client replays nothing. Manual edits stay instant.
- **The catalogue:** token gains/losses (icon with +/++/−/−−, side by side, 1000ms); damage (impact, red number; the Shield's share blue; shards when it breaks; a gold ring for Armor; "BLOCKED"; cracks for a broken bar; stars for Dizzy; a slam for Taken Out; 800-1100ms); heal (green number; light when revived); gaining a Shield (a shell closes over the figure, 1200ms); a Challenge (the lock, 600ms); moves (slides; push streaks and a dust puff; teleport flashes; swaps pass side by side; smoke out of play); tiles (drop-in, debris, trails); turn start (gold rings and the name); an Action (the attacker lunges at its first target with streaks); a Super Move (a banner across the screen).

### Phones in a fight
`useIsPhone` (under 768px wide, or a touch screen whose short side is under 600px): no Map Tiles palette (only the lock), no turn order rail, no zoom buttons, no pen and eraser during Simple Combat. Action and End Turn sit side by side at 44px.

## Homebrew builder
A GM page (`/homebrew`) for the GM's own **Forms, Styles and Archetypes**, which join the book's content everywhere.
- **Abilities:** rules text plus rules built in a simple editor: a moment (start/end of your turn, an ally's, an enemy's, every turn, when you Bleed, when you take damage, after you Challenge), an optional "you may", and effects (tokens, Shield, heal, damage, pay HP, Challenge, discard, temporary Armor, an Action Pool number, "choose one of", or a **text notification** card). Aimed at you, an ally or enemy in range, or all of them. They compile to the content's op trees and run like the book's.
- **Actions:** name, cost text and rules text; automated by Claude (Commit Homebrew).
- **Visibility:** drafts are the GM's; **Published** items appear in every builder. Unpublishing never breaks a character using one.
- **Copy from book** starts an item from a book entry. A Form's Skill may be a book Skill or a custom one.
- Code: `client/src/lib/patd/homebrew.js` (`cleanHomebrew`, `compileRule`, `itemToContent`, `mergeHomebrew`…), `server/homebrew.js` (`homebrew:save|publish|delete` → `homebrew:updated { items, automation, coreIds }`), `components/HomebrewPage.jsx`. Each Ability and Action has a stable `uid`. Not in homebrew: Freestyles, Super Moves, Builds, Features.

## Commit Homebrew
A GM tool that commits the published homebrew into the repo, so Claude can automate it.
- **The core lives in the repo:** `homebrew/items/<id>.json` (one file per published item, written by the app) and `homebrew/automation.json` (written only by Claude: per item and part `uid`, the automation, the wording `fingerprint` it was made for and the commit it was `basedOn`).
- **The app commits itself** to `main` with `GITHUB_TOKEN` through the Git Data API (`server/githubCommit.js`; retries if `main` moved; skips when unchanged). Every commit redeploys. Without a token the tool offers **Download snapshot** instead.
- **The wrench** by each item and part: blue (automated), grey (automated, but the wording changed since — the old automation keeps running), hollow (committed, not automated yet), none (never committed). Only rules wording greys it.
- **Live edits win:** the `homebrew` table is what runs; an empty table is restored from the core at boot.
- Code: `client/src/lib/patd/homebrewSync.js` (fingerprints, wrench states, commit plan), `server/homebrewCore.js`, `CommitHomebrewTool.jsx`, `scripts/homebrew-automation.mjs`. Tests: `homebrewPipeline.test.js` (also checks the repo's own `homebrew/`), `scripts/playtest-commit-homebrew.mjs`.

### Runbook: "automate homebrew content" (Claude)
1. `git pull` to fetch the app's Commit Homebrew commits, then run `node scripts/homebrew-automation.mjs` for the to-do list.
2. **New parts:** write the automation into `homebrew/automation.json` under the item id and the part's uid.
   - An Ability gets `rules`: book-shaped, using only what `ruleSupport` accepts.
   - An Action gets `effect`, plus a structured `cost` and the rest as needed.
   - If something genuinely needs engine code, add it to the engine like any book mechanic, and say so in the commit.
   - A part that needs nothing still gets an entry, via `stamp --all`.
3. **Stale parts:** read the word diff and adjust only what the change touches. A changed number is a changed number.
4. `stamp <itemId> [uid…]` every part you wrote or checked, then `prune` the leftovers.
5. Run `npm test`. `homebrewPipeline.test.js` refuses unstamped entries, leftovers and automation the engine would run by hand. Then lint, build, commit `homebrew/automation.json` (and any engine code) to `main`, and push.
6. If the user sent a snapshot file instead (no token yet): `import` it, commit the items first (stamps name that commit), then automate.

## Data model
Every table is created by `server/db.js` (`CREATE TABLE IF NOT EXISTS`, columns via `ensureColumn`). Picture-bearing rows store base64 `image_data`, `image_mime_type`, `image_hash` and, where cropped, `crop_x/y/w/h`.
- **characters** (`name, character_type 'pc'|'npc', folder_id, assigned_to`, picture), **character_folders** (`parent_id`).
- **character_builds** (`character_id, data JSON, updated_at`) — the builder's choices (ids only), XP and its log, hit spends.
- **combat_profiles** — the combat token picture per character.
- **counters** (`character_id, name, target_pips, current_pips, reward_type`), **counter_gates** (`counter_id, pip_index, name, description, secret`; unique per pip).
- **roleplay_entries**; **relationship_people / relationship_nodes / relationship_edges**.
- **chat_log** (`kind 'message'|'roll'|'reminder'|'stance_roll', character_id, dice_rolled, modifier, content, picture, payload, created_at`).
- **Scene tab:** **scenes** (picture, `folder_id, background_fit, image_source_id, timestamp_id, combat_mode 'scene'|'simple'|'combat', combat_image_*, grid_size/offset_x/offset_y/opacity, simple_weight, combat_weight`), **scene_folders**, **scene_state** (`active_scene_id`), **scene_pictures** (owned by a character or a Temp NPC), **scene_summons** (`scene_id, character_id|temp_npc_id, scene_picture_id, side, pos_x, pos_y, scale, is_hidden, lane_slot`), **scene_drawings**, **scene_notes**, **scene_timestamps**, **master_note**, **temp_npcs**, **temp_npc_folders**.
- **Fights:** **combatants** (one per placed fighter per mode: `scene_id, mode, character_id, summon_id, grid_col, grid_row, tokens JSON, challenge_id, hp_max, hp_current, hp_bars, hp_broken, dizzy, active_stance_key, level, fighter_kind, bled_round, infinite_hp, damage_taken`), **fights** (`scene_id, mode, allies, enemies, turn_order, turn_index, round, pending_stance…, movement_phase, armor_used, runtime JSON`), **dice_marks** (`roll_id, combatant_id, character_id, data JSON, active`; the last 300), **map_tiles** (`scene_id, mode, col, row, kind, owner_id` for Copies, `placed_by`), **table_settings** (`simple_lanes, lane_y`).
- **event_lanes** (`name, visibility, position`), **event_notes** (`lane_id, text, color, position, author_role, author_character_id`).
- **homebrew** (`kind, data JSON, published`).
- **audio_playlists, audio_tracks, audio_state** (the anchor).
- **compendium_archive** (append-only).
- **Unused leftovers** (harmless; drop when their table next changes shape): `chat_log.move_id`, `combatants.notes`, the pre-pivot standalone Counters.

## Real-time events (Socket.io)
Clients emit; the server validates, writes and broadcasts. Most writes answer with `stage:updated` (the Scene) or their own `*:updated`.
- **Identity:** `identity:set { role, characterId? }` (answered with `audio:state`).
- **Characters:** REST create/update/delete broadcast `character:created|updated|deleted`; `character_folder:create|rename|delete`, `character:set_folder`, `character:assign` (GM).
- **Counters:** `counter:create|adjust|set_reward|delete`, `counter_gate:save|delete` → `counter:*`, per-viewer `counter_gates:updated`.
- **Role-play:** `roleplay:*` → `roleplay:updated`. **Relationships:** `relationships:*` (per-viewer payloads).
- **Chat:** `chat:message`, `dice:roll_custom` → `roll:result`, `chat:clear`; fight cards → `chat:card`.
- **Scene tab:** `temp_npc*`, `temp_npc_folder:*`, `scene_picture:*`, `scene_folder:*`, `scene:create|update|set_folder|copy|delete|activate|set_mode|set_grid|set_combat_image`, `stage:summon|reposition_summon|resize_summon|toggle_hidden|timestamp_play`, `scene_draw:add|clear` → `scene_draw:added|cleared`, `scene_note:*`, `master_note:update`, `scene_timestamp:*`, `lane:move`, `table_settings:set`.
- **Audio:** `audio_playlist:*`, `audio_track:*`, `audio:play|pause|resume|stop|seek|next|previous|set_mode|ping|duration|track_ended|error|lookup_title` → `audio:state`.
- **Combat setup and fighters:** `combat_profile:update`, `build:save|clear` → `build:updated`; `combat_token:place (GM)|move|remove|clear`; `fighter:token|challenge|hp|set_hp|add_bar|remove_bar|clear_dizzy|set_stance|heal|damage`; `fight:preset_weight` and `fighter:infinite { ref, on }` (GM).
- **Fights:** `fight:start|next|previous|choose_stance|set_sides|reorder|end`; `fight:turn_ended`, `fight:ended`; `fight:resolving { sceneId, mode, busy, steps: [{ label, state }] }`; `fight:effects { beats }` (just before its `stage:updated`; see Board animations); `fight:active_range` (ack).
- **The dice board:** `board:current` (ack), `board:place` (a die, a Super Move pair or a token cost) `|unplace|stop|power|commit|retrieve|end_turn` → `dice:marks` (the public board), `dice:pay_failed` (a refusal).
- **Prompts and picks:** `trigger:prompt` / `trigger:answer` / `trigger:resolved`; `pick:view` / `pick:clear`.
- **Movement:** `move:reach` (the reachable squares and their cost), `move:free` (a Free Movement), `move:undo`, `move:swap`, `move:done` / `move:skip` (the movement phases), `move:view_end`, `move:hand_cost` / `move:hand_pay` (acks; Yes performs Free Movement) → `move:result`.
- **Interrupts:** `interrupt:offers` (ack), `react:open` (ack), `react:pass`, `interrupt:cancel` (GM), `interrupt:open`.
- **Map tiles:** `map_tile:place|remove|destroy|move|clear`.
- **Events tab:** `event_lane:*` (GM), `event_note:*` → `events:updated` (per viewer).
- **Homebrew:** `homebrew:save|publish|delete` (GM) → `homebrew:updated`; `homebrew:commit` (GM, ack).
- **GM tools:** `image:reencode`.

REST: `/api/health`, `/api/characters[/:id]`, `/api/characters/:id/relationships`, `/api/character-folders`, `/api/counter-gates`, `/api/chat`, `/api/search`, `/api/temp-npcs`, `/api/temp-npc-folders`, `/api/scene-pictures`, `/api/scenes`, `/api/scene-folders`, `/api/stage`, `/api/scene-notes`, `/api/scene-timestamps`, `/api/master-note`, `/api/audio-library`, `/api/img/:kind/:id/:hash`, `/api/image-inventory`, `/api/events`, `/api/homebrew`, `/api/dice-marks`, `/api/fighter-state/:combatantId`, `/api/combat-setup`, `/api/combat-profiles`, `/api/table-settings`, `/api/profile`, `/api/compendium-archive[/:id]`.

## Testing
- **`npm test`** (`node --test server/test/*.test.js`) — the unit and integration suite, including:
  - **The content runs:** `allRules.test.js` (every Ability rule, Action and Super Move run against a full fake world, nothing by hand; every Action does something at its highest Gate), `coverage.test.js` (the census at 100%), `branches.test.js` (every condition reachable, every event value a rule reads really sent), `qaPass.test.js`.
  - **Golden rule tests** (`golden.test.js`): the most-played Actions checked against their printed cards at each Gate — damage, pushes, tokens, Shields, Challenges — with the expected values worked out by hand from the text, never copied from the engine. Add a case whenever a card is found doing the wrong thing.
  - Damage Resolution (`damage.test.js`), the dice board (`diceBoard.test.js`), initiative, interrupts, board animations (`boardFx.test.js`), swaps, homebrew, the database schema and boot.
- **Socket playtests** (`scripts/playtest-*.mjs`) drive a running server like real clients: fights, damage, movement, obstacles, reactions, supers, Exploit Weakness, the Scene, chat, Events… Run them against a scratch server and database (`PORT=3001 TURSO_DATABASE_URL=file:<scratch>.db node server/index.js`).
- **Browser checks** with Playwright (the pre-installed Chromium) for anything visual, at desktop and phone sizes.

## Open items
- **Simple Combat lanes have no camera** (no pinch or pan); the map has one.
- **Taken Out fighters keep their square** — assumed, to confirm with the book.
- **The Untouchable's Dodge cost** (the content's one "requires a ruling") is read plainly as 1.
- **Stooges:** whether a unit should share one Health Bar (today each body has its own).
- **Not tracked:** the character-type Bleed Ability at turn start, and the book's Complications (Guest Heroes, Uneven Fights).
- **The Machine's "no Freestyles"** is only a warning.
- **The book's PDF is not in the repo**; rules not in the content export are read from the content's quotes.
- **Pre-pivot standalone Counters** are still in the database: delete them, or give them a home.
