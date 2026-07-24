# Custom TTRPG VTT — Project Plan

## Overview
A small, self-hosted virtual tabletop for one group (DM + players), accessed remotely over the internet from multiple devices simultaneously. No login system — one shared link, everyone sees everything within their role. Presentation-focused, fighting-game visual style. Core mechanic is a stepped dice-pool system tied to character HP/actions.

## Roles / access model
On every fresh page load, a modal asks: **Player** or **GM**. This is a client-side display filter, not authentication — there's still no login, no server-side enforcement, and no password. It exists purely so players aren't shown NPC stat blocks, consistent with the trust-based, single-shared-link approach already in place for everything else.
- **Player:** character list shows only characters with `character_type = 'pc'`. Can create new characters (always created as `pc`, no type selector shown) and can view/edit any PC sheet.
- **GM:** character list shows all characters (`pc` and `npc`). Character creation form includes a PC/NPC toggle. Can view/edit anything.
- The choice is not remembered — it asks again on every reload, and there's no in-app way to switch roles without reloading.
- This restriction is about **who can control which characters**, not about hiding activity: rolls, inventory/injury updates, stance changes, etc. are broadcast to and visible by everyone regardless of role — a Player sees an NPC's roll just like anyone else's. The only things actually restricted for Players are the character list (only PCs are listed/openable) and creating/editing NPCs — both GM-only. The Combat Arena is a deliberate exception to even that: NPCs placed there become visible to Players too (see below).

## Stack
- **Frontend:** React + Vite, Tailwind CSS, Framer Motion (transitions/layout), GSAP (impact/roll effects)
- **Backend:** Node.js + Express — also serves the built frontend (single deployable app)
- **Real-time:** Socket.io
- **Database:** Turso — free, hosted, SQLite-compatible (libSQL), no credit card required. Used instead of a local SQLite file because Render's free tier has no persistent disk; same SQL, same schema, just accessed over network instead of a local file.
- **Hosting:** Render — free web service tier, no credit card required. Supports WebSockets natively while active. Tradeoff: the free tier sleeps after inactivity, so the first connection after a quiet period takes ~30-60 seconds to wake up (a one-time delay at the start of a session, not an ongoing issue).
- **Access:** one shared URL, no auth, no per-player restrictions

## Game mechanic — Dice Pools (Core Stats tab)
Each character has 3 fixed dice pools, always the same slot names for every character:

| Pool | Slots |
|------|-------|
| Head | Skull, Brain |
| Core | Left Hand, Stamina, Body, Right Hand |
| Legs | Left Leg, Right Leg |

- Each die can be rolled individually (opens a dialog asking for an ad-hoc +/- modifier for that roll, clamped to ±20), or via **Pool Roll**: a single button on the sheet enters selection mode, where any set of that character's active dice — across Head/Core/Legs alike, not one body section at a time — is picked and rolled together with one shared +/- modifier.
- Each die has a green up-arrow and red down-arrow next to it to step its size: d4 → d6 → d8 → d10 → d12.
- Stepping up past d12: size stays at d12, and a permanent bonus stacks instead (d12 → d12+1 → d12+2 → ...). This bonus is added to every future roll of that die.
- Stepping down from d12+N: the bonus is reduced first (d12+2 → d12+1 → d12 → d10 → d8 ...); only once size is back to d4 with no bonus does the next down-click incapacitate the die.
- Incapacitated: die is greyed out and shown as scratched-out; can't be rolled or stepped further down. Clicking the up-arrow on an incapacitated die revives it to a normal d4 (size 4, bonus 0, active).

## Game mechanic — Stamina & Stat Lock (Core Stats tab)
Each die tracks two states: its **current** value (fluctuates during play) and its **locked** value (the "fully rested" baseline).
- **Lock in Stats** — snapshots every die's current size/bonus/status as the new locked baseline for that character. Persists indefinitely until pressed again (stored in the DB, not session-based).
- **Revert Stats to Base** — resets every die's current size/bonus/status back to its locked baseline.
- Locking/reverting only affects the 8 dice — Current Stamina is tracked independently and is untouched by either button.
- **Visual tint per die:** compare current vs. locked using a rank (d4=0, d6=1, d8=2, d10=3, d12=4, then +1 per bonus point beyond d12). Above locked → green tint; below locked → red tint; equal → no tint. Tint opacity scales with the size of the difference — bigger gap, stronger tint.
- **Maximum Stamina** = `stamina_multiplier × (locked Stamina die's size + locked Stamina die's bonus)`. The multiplier defaults to 4 but is stored per-character (not hardcoded), so future Perks can change it without code changes. Recalculated whenever stats are locked. Current Stamina is clamped down if a re-lock lowers Max Stamina below it.
- **Current Stamina** — tracked independently, starts at Max Stamina for a new character. In combat, regenerates each turn by rolling the Stamina die at its *current* size/bonus (reflecting real-time fatigue), added to Current Stamina up to the Max. How Current Stamina is spent/reduced during play isn't defined yet — depends on the Moves tab.

## Game mechanic — Stances (Stances tab)
Each character builds their own stances via an in-sheet **Stance Creator**; stances are not shared between characters.
- A stance is a name plus exactly 2 styles (attributes), chosen from the fixed pool of 7 — seeded once as core ruleset, not editable in-app. The **final list** (decided): Speed, Power, Improvisation, Technique, Keep-out, Defensive, Close-Quarters. Each style has an assigned open-source icon (lucide, stored as an icon name on the attribute row) shown throughout the UI.
- The 7 styles form the **2-Paradox tournament**: a complete tournament — every pair of styles has a winner, so each style defeats exactly 3 others and is defeated by the remaining 3 (21 seeded winner→loser pairs). The full defeats table:

  | Style | Defeats |
  |-------|---------|
  | Speed | Power, Improvisation, Keep-out |
  | Power | Defensive, Improvisation, Technique |
  | Improvisation | Technique, Keep-out, Close-Quarters |
  | Technique | Speed, Defensive, Keep-out |
  | Keep-out | Power, Defensive, Close-Quarters |
  | Defensive | Speed, Improvisation, Close-Quarters |
  | Close-Quarters | Speed, Power, Technique |

- Counter bonus (decided): **+2 for each enemy style you are strong against, −2 for each you are weak towards** (the same seeded edge read from the loser's side). Styles are also expected to carry their own mechanical benefits eventually — structure TBD, schema kept extensible for it.
- A character's Stances tab lists all stances they've created; left-clicking one makes it that character's **currently active stance** (exactly one at a time, mechanically relevant — not cosmetic). This is tracked per-character and broadcast live, so it's visible to everyone (including opponents), Pokemon-switch style. The active stance also shows as a badge on the sheet header, and (Phase 6) in each participant's Combat Arena summary.
- **No deactivation** (decided): the active stance can only be switched, never turned off. Every character should keep at least one stance with one active at all times — the first stance created auto-activates, the last remaining stance can't be deleted, and deleting the active stance auto-activates a surviving one. (A brand-new character has none until their first is created — the tab nudges for it.)
- The Stances tab shows the **counter chart** to everyone: a vector (SVG) graph of the 7-style tournament that blends with the UI, arrows pointing winner → disadvantaged. When a stance is active, its two styles are highlighted — green edges for matchups it counters, red for matchups that counter it — plus **Best/Worst Matchups** lists: enemy style-pairs ranked by net score (sum of ±2 across all cross pairs; a style shared with the enemy pair contributes 0), top and bottom few shown.
- How the active stance's attributes actually modify rolls/outcomes beyond this scoring depends on the Moves tab (next), so full resolution logic is an open item until that's defined — the data (stances, attributes, counter bonuses, active stance) is modeled now so it's ready to plug in.

## Game mechanic — Moves & Tells (Moves tab)
- **Default Moves** (Block, Jab, Dodge, etc. — list still incomplete) are automatically available to every character, PC or NPC, with no granting step.
- **Unique Moves** are not present at character creation; the GM grants them individually.
- Both are created through the same GM-only **Move Creator**, just flagged `is_default` vs not.
- **Move structure (decided).** A move card renders top-to-bottom as:
  1. **Tell header** — a special header strip showing only the move's Tell (art + name), nothing else.
  2. **Name** (top-left, with the move's small uploaded art beside it) and **Frame Data** (to its right): a single line of adjoining squares — **Startup (yellow), Active (red), Recovery (blue)** — one square per Tic. Each segment is assigned 0-10 squares at creation (at least 1 total); the card just renders however many exist (e.g. Startup 3 / Active 2 / Recovery 1 → 6 squares). Combat meaning: placed on Tic *N*, the move charges up through its Startup squares, actively hits through its Active squares, then its Recovery squares carry over — eating into the next round if they run past the round's end.
  3. **Style and Tags chips.**
  4. **Description** text.
  5. **Special interactions** — three categories: **On Hit / On Block / On Miss**. Each holds free text plus optional **automations**, limited to exactly four types for now: add/remove Recovery on yourself (±), add Recovery to the opponent, lose additional Stamina yourself, or the opponent loses Stamina. Anything else stays text-only, adjudicated at the table. Automations are stored/displayed now; they execute in the combat phases.
- **Images, not icons**: Moves and Tells each carry a small uploaded picture (commissioned simple art, uploaded by the GM through the Tell manager / Move Creator; resized client-side to ≤128px, PNG transparency preserved). Until uploaded, an initial-letter placeholder shows. Only the 7 styles keep open-source (lucide) icons.
- **Style (decided)**: every move is assigned one of the 7 styles (required in the Creator; rows created before this rule may be NULL = unrestricted). No mechanical modifier — it gates two things: **learnability** (a Unique move can only be granted to a character who has at least one stance containing that style — enforced server-side on grant and shown in the Grant checklist) and **usability** (a move is only usable while the character's *active* stance contains its style — unusable moves render dimmed on the Moves tab). Already-granted moves are kept if stances later change; they just show as unusable.
- **Tags (decided)**: each move carries 0-10 Tags, picked from the world-level GM-managed `tags` list (created/edited in the Compendium, like Tells — this pulls the base tag tables forward from Phase 4; per-character tag overrides via Perks remain Phase 4). Tags can also change dynamically later (Perks adding Tags to specific moves).
- **Compendium** — a persistent, GM-only library of every move ever created (default and unique). The GM drags a move from the compendium onto a character in the page's character rail to grant it (a per-move Grant checklist covers touch devices); the GM can revoke a Unique move from the character's Moves tab.
- **Compendium folders & filtering (decided)**: the GM can create folders and place moves in them (assigned in the Move Creator; deleting a folder returns its moves to the root). A **style filter** narrows the listing: used inside a folder it filters within that folder; used at the root it scans across all folders and shows every match labeled with its source folder.
- **Tells** — a separate, world-level list, editable by the GM at any time (unlike the fixed 7 stance attributes). A Tell is a **name + small uploaded image**. Two placeholders ("Tell 1", "Tell 2") are seeded so moves can be created immediately; the GM replaces them with real Tells. A Tell in use by a move can't be deleted. When creating a move, the GM picks one Tell from this list.
- **Declaring a move** — happens during combat, with real timing/reveal mechanics covered in detail in "Combat Timing" below. Short version: only the Tell is shown to everyone (including the GM) until the move's Startup timer completes.

## Game mechanic — Combat Arena
No map or tokens. Instead, a dedicated shared Combat Arena page:
- The GM drags characters (PC or NPC) onto a **left** or **right** side to start a fight. Only a simplified view is shown per participant: portrait, dice pools, and stamina — not the full sheet.
- **Exception to normal NPC hiding:** once an NPC is placed in the arena, its simplified stats become visible to Players too — the whole point is so players can see and strategize against their opponent. This is the one place NPC info is shown to Players.
- The GM can further arrange participants into **pairs** (a semi-translucent divider marks each pair), since the system centers on 1-on-1 duels even within a larger fight.
- **Uneven Combat** toggle (GM-only): when on, a pair can have multiple characters on one side against a single character on the other. This is a GM-side convenience flag — the app doesn't hard-block uneven pairs when it's off, that's on the GM to respect.
- Only the GM can drag characters into, out of, or around the arena.
- Arena state (who's in it, sides, pairing, the Uneven Combat toggle) is persisted like everything else, so it survives reloads mid-fight.

## Game mechanic — Combat Timing (Initiative, Tells, Tics)
One shared timer runs the whole round (not one per pair), and it's actually a single **global counter that never resets** — round boundaries are just markers on that timeline, which is what makes overflow between rounds work cleanly (see below). Each round has two phases:

**Declaration Phase**
- The GM presses **Next Round**: increments the round number, marks the current Tic as this round's start, rolls the Brain die for every participant (posted to chat as normal initiative rolls), opens declarations.
- **Initiative is per side, not per character** — this covers both even 1-on-1 pairs and Uneven Combat the same way: a side's Initiative is the *highest* Brain roll among all characters on that side of the pair. The losing side's characters all declare (queue) their moves first — only Tells show, to everyone including the GM. The winning side's characters then declare theirs, having already seen the losing side's Tells.
- A character can queue more than one move for the round during this phase, but once the Tic countdown starts, no new declarations can be made or changed.
- For a character's next queued move (their 1st this round or their 4th), its placement Tic is whichever is later: the round's start Tic, or that character's own last-queued move's reveal Tic — even if that move was queued in a *previous* round. That second case is exactly how overflow works (next point).

**Tic Countdown Phase**
- The GM presses a button to lock in declarations and start the countdown, then manually moves the (global) Tic counter forward and backward — a round is 5 Tics for now, though that length isn't hardcoded and can change later. The GM's display shows Tics relative to the current round (Tic 1-5), even though the counter underneath never actually resets.
- Every Move has a **Startup** (in Tics — the same unit also called "Pips"). A move placed at Tic *N* resolves/reveals at Tic *N + Startup*. Until then, everyone (GM included) sees only its Tell; the instant the counter reaches that Tic, the real move is revealed to everyone and posted to the Chat Log alongside a roll — no automatic stat changes, purely informational.
  - Example: a Hook with Startup 3, placed at the start of the round, shows its Tell through Tics 1-3; the moment the counter reaches Tic 4, it's revealed as a Hook.
- Since the Move structure was finalized (Phase 3), moves also carry **Active** and **Recovery** Tics beyond Startup: after revealing, a move actively hits through its Active squares, then its Recovery squares occupy the timeline — carrying into the next round if they run past the round's end, exactly like Startup overflow. How Active/Recovery integrate with placement of a character's *next* move (and when On Hit/Block/Miss automations fire) is Phase 7 design work — the timing engine must account for the full Startup+Active+Recovery footprint, not Startup alone.
- **Overflow:** if a move's reveal Tic falls past the round's 5-Tic window, it simply carries into the next round — e.g. overflowing by 2 means the first 2 Tics of the next round are already occupied finishing that move. Because the Tic counter never resets, this needs no special-casing: the move's reveal Tic was always an absolute point on the timeline, and (per the Declaration Phase rule above) that character's next new move can't be placed any earlier than that point anyway.
- Reveal state is computed live from the current Tic vs. each move's reveal point, so moving the counter backward re-hides a move that hasn't "really" happened yet in the GM's current read of the scene.
- Fast, low-Startup moves (e.g. a Jab with Startup 2) can potentially interrupt slower ones declared earlier but resolving later — the app tracks the Tic order but doesn't auto-adjudicate interrupts; that's a GM/table call.
- Pressing **Next Round** returns to the Declaration Phase.

## Game mechanic — Chat Log
A single shared feed for the whole game (what was "roll log" earlier — renamed since it now shows more than dice rolls):
- Every die/pool roll posts here, as already described.
- When a declared move resolves, its revealed move card posts alongside a roll — informational only, no automatic stat effects.
- Clears automatically on server restart — a natural fit, since Render's free tier already spins the server down between quiet periods, which doubles as clearing the log between sessions.
- Also has a manual **Clear Chat** button, anytime (assumed GM-only, matching other admin-style controls — flag if players should have it too).

## Game mechanic — Perks & Tags (Perks tab)
- Perks are created by the GM in their own **Perks Compendium**, separate from the Moves Compendium, and granted the same way — drag-and-drop onto a character.
- A Perk has: **Name**, **Description**, and one or more **Automation** entries. Two automation types for MVP:
  - **Resource Manipulation** — a permanent change to something on the character (e.g. step up a specific die, adjust the stamina multiplier, adjust max/current stamina). Exact set of manipulable resources and whether they touch locked vs. current values will get refined once real Perks are being written.
  - **Move Tag** — add or remove a Tag on a specific Move, **scoped only to the character holding the Perk** — it does not change the shared Move template for anyone else. Tags themselves are a GM-managed list, like Tells (picked from existing Tags when tagging a Move, not typed freeform).
- The Perks tab on a character sheet is read-only — just displays granted Perks in a grid (infinite rows, 2 columns; framed styling is a polish-pass detail).
- This is explicitly an MVP: more automation types are expected once real Perk content gets written.

## Game mechanic — Counters
Simple, persistent "clocks" — no automation, just a name, a target (2-20 pips), a current count, and +/- buttons.
- **Character-owned counters:** created by whoever controls that character (any player for a PC, GM for an NPC), shown on that character's own Counters tab — same open-access pattern as Inventory.
- **Standalone counters:** created directly in the Combat Arena, not tied to any character — GM-only, since arena control is already GM-only.
- **Show in Combat toggle:** a character-owned counter can be flagged to also appear in the Combat Arena, labeled `"{CharacterName} - {CounterName}"` (e.g. "Aaron - Rage"). It's the same underlying record wherever it's shown — adjusting it from the Arena or from the character sheet updates the other live.

## Data model
```sql
CREATE TABLE characters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  character_type TEXT NOT NULL DEFAULT 'pc' CHECK(character_type IN ('pc','npc')),
  image_data TEXT,          -- base64-encoded image, stored directly in Turso
  image_mime_type TEXT,     -- e.g. 'image/jpeg', needed to render image_data correctly
  active_stance_id INTEGER, -- FK to stances(id), set once stances exist
  stamina_multiplier INTEGER NOT NULL DEFAULT 4,  -- editable by future Perks, not hardcoded
  max_stamina INTEGER NOT NULL DEFAULT 0,          -- recalculated on Lock
  current_stamina INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Seeded once, fixed ruleset (not user-editable in-app)
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '' -- lucide icon name, rendered client-side
);

-- Seeded once: 21 rows — the complete 2-Paradox tournament (every pair of the
-- 7 styles has a winner; each style defeats exactly 3). bonus is +2 on every
-- edge; the loser's -2 is the same row read from the other side.
CREATE TABLE attribute_counters (
  id INTEGER PRIMARY KEY,
  attacker_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  defender_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  bonus INTEGER NOT NULL -- numeric bonus/penalty applied when attacker's stance meets defender's stance
);

CREATE TABLE stances (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  attribute_a_id INTEGER NOT NULL REFERENCES attributes(id),
  attribute_b_id INTEGER NOT NULL REFERENCES attributes(id) CHECK(attribute_b_id != attribute_a_id)
);

CREATE TABLE dice (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  pool TEXT NOT NULL CHECK(pool IN ('head','core','legs')),
  slot_name TEXT NOT NULL,
  current_size INTEGER NOT NULL DEFAULT 8 CHECK(current_size IN (4,6,8,10,12)),
  bonus INTEGER NOT NULL DEFAULT 0,   -- permanent +1s stacked once size is capped at 12
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','incapacitated')),
  locked_size INTEGER NOT NULL DEFAULT 8 CHECK(locked_size IN (4,6,8,10,12)),
  locked_bonus INTEGER NOT NULL DEFAULT 0,
  locked_status TEXT NOT NULL DEFAULT 'active' CHECK(locked_status IN ('active','incapacitated'))
);

CREATE TABLE inventory_items (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' -- optional; empty renders nothing
);

CREATE TABLE injuries (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  effect TEXT NOT NULL
);

CREATE TABLE chat_log (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
  modifier INTEGER NOT NULL DEFAULT 0,
  move_id INTEGER REFERENCES moves(id), -- set when this roll is tied to a resolved move's reveal; null for a plain roll
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- World-level, GM-editable at any time
CREATE TABLE tells (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  image_data TEXT,      -- base64 small uploaded image (commissioned art)
  image_mime_type TEXT
);

-- Perks compendium (separate from Moves)
CREATE TABLE perks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE character_perks (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
  UNIQUE(character_id, perk_id)
);

-- Flexible automation entries per Perk; payload shape depends on type, expected to evolve
CREATE TABLE perk_automations (
  id INTEGER PRIMARY KEY,
  perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
  automation_type TEXT NOT NULL CHECK(automation_type IN ('resource_manipulation','move_tag')),
  payload TEXT NOT NULL -- JSON, e.g. {"resource":"die","slotName":"Stamina","amount":1} or {"moveId":42,"tagId":7,"action":"add"}
);

-- World-level, GM-managed, like Tells (landed in Phase 3 for Move tagging)
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- Base tags on a Move template — global, visible to everyone with that Move
-- (0-10 per move, landed in Phase 3)
CREATE TABLE move_tags (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(move_id, tag_id)
);

-- Character-scoped tag overrides granted by a Perk's Move Tag automation (personal, not global)
CREATE TABLE character_move_tags (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('add','remove')), -- 'remove' suppresses a base tag just for this character
  source_perk_id INTEGER REFERENCES perks(id), -- lets revoking the Perk clean up what it granted
  UNIQUE(character_id, move_id, tag_id)
);
-- A character's effective tags on a move = move_tags, plus 'add' overrides, minus 'remove' overrides from character_move_tags

CREATE TABLE counters (
  id INTEGER PRIMARY KEY,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE, -- NULL = standalone arena counter
  name TEXT NOT NULL,
  target_pips INTEGER NOT NULL CHECK(target_pips BETWEEN 2 AND 20),
  current_pips INTEGER NOT NULL DEFAULT 0,
  show_in_combat INTEGER NOT NULL DEFAULT 0 -- only meaningful when character_id is set
);

-- GM-created folders for organizing the Moves compendium
CREATE TABLE move_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- The compendium: master list of move templates (structure finalized)
CREATE TABLE moves (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, -- 1 = auto-granted to every character
  tell_id INTEGER NOT NULL REFERENCES tells(id),
  startup_tics INTEGER NOT NULL DEFAULT 1,   -- frame data: 0-10 each,
  active_tics INTEGER NOT NULL DEFAULT 1,    -- at least 1 square total
  recovery_tics INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  style_attribute_id INTEGER REFERENCES attributes(id), -- learn/use gate; NULL only on legacy rows
  folder_id INTEGER,    -- compendium folder; NULL = root
  image_data TEXT,      -- base64 small uploaded image
  image_mime_type TEXT
);

-- On Hit / On Block / On Miss entries: text plus optional automations
-- (only rows with content are stored)
CREATE TABLE move_interactions (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss')),
  text TEXT NOT NULL DEFAULT '',
  automations TEXT NOT NULL DEFAULT '[]'
  -- JSON [{type, amount}]; type in: self_recovery (amount may be negative),
  -- opponent_recovery, self_stamina, opponent_stamina (positive = amount lost)
);

-- Role-play tab (Tab 6): per-character Q&A. The 6 canonical questions live in
-- client code; answers upsert here keyed by question text (is_custom = 0).
-- Custom questions (up to 20 per character) are rows with is_custom = 1.
CREATE TABLE roleplay_entries (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  is_custom INTEGER NOT NULL DEFAULT 0
);

-- Grants a Unique move to a specific character (Default moves need no row here)
CREATE TABLE character_moves (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  UNIQUE(character_id, move_id)
);

-- Singleton row holding the current arena's global toggle and round/Tic state.
-- current_tic is a single counter that never resets across rounds — round_start_tic
-- just marks where the current round began on that timeline, so overflow from a
-- previous round's carried-over move works without any special-casing.
CREATE TABLE combat_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uneven_combat_enabled INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'declaration' CHECK(phase IN ('declaration','tic_countdown')),
  round_number INTEGER NOT NULL DEFAULT 1,
  current_tic INTEGER NOT NULL DEFAULT 0,
  round_start_tic INTEGER NOT NULL DEFAULT 0,
  round_length INTEGER NOT NULL DEFAULT 5 -- not hardcoded in app logic, so it can change later
);

CREATE TABLE combat_participants (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('left','right')),
  pair_index INTEGER NOT NULL,
  UNIQUE(character_id)
);

-- Per-round queued moves. Persisted so they survive reloads mid-round, but the server
-- withholds move_id from broadcasts to everyone except the declaring character's own client,
-- until the reveal Tic is reached (see open items re: no-auth limitation on this).
CREATE TABLE declared_moves (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id),
  round_number INTEGER NOT NULL,
  queue_order INTEGER NOT NULL, -- this character's Nth move declared this round
  placement_tic INTEGER NOT NULL,
  reveal_tic INTEGER NOT NULL -- placement_tic + the move's startup_tics
);
```
When a character is created, auto-generate its 8 `dice` rows (2 head + 4 core + 2 legs) at a default size of d8, editable afterward via step up/down.

**Image storage note:** portraits are stored directly in Turso as base64 (`image_data`) rather than a separate image hosting service — simplest option, no extra account needed, and well within Turso's free storage limits for a handful of character portraits. To keep rows small, the frontend should resize/compress images client-side before upload (e.g. cap at ~800px wide) rather than uploading a raw phone photo.

**Move list note:** a character's full Tab 3 list = all `moves` where `is_default = 1`, plus all moves joined through `character_moves` for that character. Declared moves during combat ARE persisted (`declared_moves`), unlike the earlier draft of this plan — the Tic-based reveal timer needs them to survive a mid-round reload. The server still withholds the real `move_id` from broadcasts to non-owners until the reveal Tic, sending only the Tell.

## Real-time events (Socket.io)
- `character:created` / `character:updated` / `character:deleted` — server → all clients, includes `character_type`. `character:updated` covers name edits and portrait uploads alike, so every device refreshes both live.
- `die:roll` (client → server): `{ characterId, dieId, modifier }` — modifier is the ad-hoc +/- entered in the roll dialog. Result = roll(current_size) + bonus + modifier. Server logs to `chat_log`, broadcasts `roll:result`.
- `pool:roll` (client → server): `{ characterId, dieIds, modifier }` — rolls the selected set of that character's dice (any mix across Head/Core/Legs; incapacitated dice are silently dropped), each at its own size + bonus, plus the one shared modifier applied to all of them. Broadcasts `roll:result`.
- `die:step` (client → server): `{ dieId, direction: 'up' | 'down' }` — server logic:
  - **up:** if `status == 'incapacitated'`, revive to `current_size = 4`, `bonus = 0`, `status = 'active'`; else if `current_size < 12`, advance to next size; else (`current_size == 12`) increment `bonus` instead.
  - **down:** if `bonus > 0`, decrement `bonus`; else if `current_size > 4`, drop to previous size; else set `status = 'incapacitated'`.
  - Broadcasts `die:updated`.
- `roll:result` (server → all clients): `{ characterId, characterName, modifier, dice: [{slot_name, size, bonus, result}], total, timestamp }`
- `die:updated` (server → all clients): `{ dieId, characterId, current_size, bonus, status }`
- `inventory:add` / `inventory:update` / `inventory:remove` (client → server): `{ characterId, itemName, description }` / `{ itemId, itemName, description }` / `{ itemId }` — updates `inventory_items`, broadcasts `inventory:updated` `{ characterId, items }` to all clients
- `injury:add` / `injury:remove` / `injury:update` (client → server): `{ characterId, name, effect }` / `{ injuryId }` / `{ injuryId, name, effect }` — updates `injuries`, broadcasts `injuries:updated` `{ characterId, injuries }` to all clients
- `stance:create` / `stance:update` / `stance:delete` (client → server): `{ characterId, name, attributeAId, attributeBId }` / `{ stanceId, name, attributeAId, attributeBId }` / `{ stanceId }` — updates `stances`, broadcasts `stance:created` / `stance:updated` / `stance:deleted` to all clients. Server-enforced rules: a character's first stance auto-activates (also broadcasts `stance:activated`); the last remaining stance can't be deleted; deleting the active stance auto-activates a surviving one.
- `stance:activate` (client → server): `{ characterId, stanceId }` — sets `characters.active_stance_id`, broadcasts `stance:activated` `{ characterId, stanceId }` to all clients
- `character:lock_stats` (client → server): `{ characterId }` — copies every die's `current_size/bonus/status` into `locked_size/locked_bonus/locked_status`; recalculates `max_stamina` from the locked Stamina die; clamps `current_stamina` down if it now exceeds the new max. Broadcasts `character:updated` + `die:updated` for each die.
- `character:revert_stats` (client → server): `{ characterId }` — copies every die's `locked_size/locked_bonus/locked_status` back into `current_size/bonus/status` (Current Stamina untouched). Broadcasts `die:updated` for each die.
- `stamina:regen` (client → server): `{ characterId }` — rolls the Stamina die at its current size + bonus, adds the result to `current_stamina` (clamped to `max_stamina`), logs to `chat_log`. Broadcasts `character:updated` and `roll:result`.
- `stamina:adjust` (client → server): `{ characterId, delta }` — manual +/- to `current_stamina`, clamped to `[0, max_stamina]`. Interim building block until the Moves tab defines how Stamina is actually spent. Broadcasts `character:updated`.
- `tell:create` / `tell:update` / `tell:delete` (client [GM] → server): `{ name, imageData?, imageMimeType? }` / `{ tellId, name, imageData?, imageMimeType? }` (image only replaced when provided) / `{ tellId }` — manages the world-level `tells` list (delete refused while any move uses the Tell), broadcasts `tell:created` / `tell:updated` / `tell:deleted` to all clients
- `move:create` / `move:update` / `move:delete` (client [GM] → server): `{ name, isDefault, tellId, styleAttributeId, folderId, tagIds, imageData?, imageMimeType?, startupTics, activeTics, recoveryTics, description, interactions: {hit|block|miss: {text, automations}} }` / `{ moveId, ...same fields }` (interactions + tags replaced wholesale on update; image only when provided) / `{ moveId }` — manages `moves` + `move_interactions` + `move_tags` (delete cascades to `character_moves`), broadcasts `move:created` / `move:updated` / `move:deleted` (full move incl. interactions + tag_ids) to all clients
- `folder:create` / `folder:rename` / `folder:delete` (client [GM] → server): `{ name }` / `{ folderId, name }` / `{ folderId }` — manages compendium `move_folders` (delete moves its contents back to root), broadcasts `folder:created` / `folder:updated` / `folder:deleted`
- `move:grant` / `move:revoke` (client [GM] → server): `{ characterId, moveId }` — inserts/deletes a `character_moves` row (the drag-and-drop from the compendium). Grant is refused server-side when the move has a style and the character has no stance containing it (learnability rule). Broadcasts `move:granted` / `move:revoked`
- `roleplay:save_answer` / `roleplay:add_question` / `roleplay:update_entry` / `roleplay:delete_question` (client → server): `{ characterId, question, answer }` (upserts a canonical-question answer) / `{ characterId, question }` (custom, capped at 20 per character) / `{ entryId, question, answer }` (question editable only on custom rows) / `{ entryId }` (custom rows only) — all broadcast `roleplay:updated` `{ characterId, entries }`
- `combat:next_round` (client [GM only] → server) — increments `round_number`, sets `round_start_tic = current_tic` (the counter itself is untouched — it never resets), sets `phase = 'declaration'`, rolls the Brain die for every current participant (each posted to `chat_log` as a normal roll). Broadcasts `combat:updated` + `roll:result` for each initiative roll.
- `move:declare` (client → server): `{ characterId, moveId }` — only valid while `phase == 'declaration'`. Computes `queue_order` (this character's Nth declared move this round), `placement_tic = MAX(round_start_tic, this character's own last reveal_tic across any declared_moves row, or round_start_tic if they have none)`, and `reveal_tic = placement_tic + startup_tics`. Inserts into `declared_moves`. Broadcasts `move:declared` to every other client — Tell only (`{ characterId, tellName, queueOrder }`, `moveId` withheld) — including GM-mode clients; the declaring client already has the full info since it just chose it.
- `combat:start_tic_countdown` (client [GM only] → server) — sets `phase = 'tic_countdown'`, locking further declarations for the round. Broadcasts `combat:updated`.
- `combat:tic_forward` / `combat:tic_backward` (client [GM only] → server) — adjusts `current_tic` by ±1. Server recomputes, for every `declared_moves` row, whether `current_tic >= reveal_tic`; anything newly past that threshold gets its real move posted to `chat_log` (with a roll) and revealed to everyone, anything newly before it (moving backward) reverts to Tell-only. Broadcasts `combat:updated` with the current Tic and reveal status.
- `chat:clear` (client [GM] → server) — truncates `chat_log`, broadcasts `chat:cleared` to all clients. Also runs automatically once at server startup.
- `combat:add_participant` / `combat:move_participant` / `combat:remove_participant` (client [GM only] → server): `{ characterId, side, pairIndex }` — updates `combat_participants`, broadcasts `combat:updated` with the full current arena state to all clients
- `combat:toggle_uneven` (client [GM only] → server) — flips `combat_state.uneven_combat_enabled`, broadcasts `combat:updated`
- `combat:clear` (client [GM only] → server) — clears all `combat_participants`, broadcasts `combat:updated`
- `perk:create` / `perk:update` / `perk:delete` (client [GM] → server) — manages `perks` + their `perk_automations`, broadcasts `perk:created` / `perk:updated` / `perk:deleted`
- `perk:grant` (client [GM] → server): `{ characterId, perkId }` — inserts into `character_perks`; applies each automation (resource manipulation adjusts the relevant character/die field directly, move_tag inserts a `character_move_tags` row with `action` + `source_perk_id`). Broadcasts `perk:granted` plus whatever `character:updated` / `die:updated` / tag-update events the automations trigger.
- `perk:revoke` (client [GM] → server): `{ characterId, perkId }` — removes the `character_perks` row and reverses its automations (undoes the resource change, deletes `character_move_tags` rows where `source_perk_id` matches). Broadcasts `perk:revoked` plus the resulting updates.
- `tag:create` / `tag:update` / `tag:delete` (client [GM] → server) — manages the world-level `tags` list, broadcasts `tag:created` / `tag:updated` / `tag:deleted`
- `counter:create` (client → server): `{ characterId (nullable — null only valid from a GM client), name, targetPips }` — inserts into `counters`, broadcasts `counter:created`
- `counter:adjust` (client → server): `{ counterId, delta }` — +/- to `current_pips`, clamped to `[0, target_pips]`, broadcasts `counter:updated`
- `counter:toggle_show_in_combat` (client → server): `{ counterId }` — flips `show_in_combat`, broadcasts `counter:updated`
- `counter:delete` (client → server): `{ counterId }` — broadcasts `counter:deleted`

## Pages / views
1. **Role-select modal** — shown on every fresh load, before anything else: "Player" or "GM". Not persisted.
2. **Character list** (home) — cards for each character, filtered by role (`pc` only for Player, all for GM); "+ Add Character" button (name only, plus a PC/NPC toggle for GM; dice auto-seeded either way); each card has a **Delete** option that asks for confirmation first (it cascades — dice, stances, moves, inventory, injuries all go with it)
3. **Character sheet**, split into 3 tabs:
   - **Tab 1 — Core Stats:**
     - **Name** — simple editable text field, saved live
     - **Portrait** — image area; clicking it opens a file picker to upload/replace the character's picture (same click-to-change flow whether setting it the first time or changing it later)
     - **Lock in Stats** / **Revert Stats to Base** buttons — snapshot or restore all 8 dice against the character's locked baseline (see mechanic above)
     - **Dice pools** (Head/Core/Legs) — each die shown sized/styled by its die type (or greyed-out/scratched-out if incapacitated), tinted green/red (opacity scaling with the gap) when current differs from locked, with a green up-arrow and red down-arrow beside it to step size; clicking the die itself opens a roll dialog asking for an ad-hoc modifier. One **Pool Roll** button for the whole sheet enters selection mode — tap any set of dice (across sections), then roll them together with one shared modifier
     - **Maximum Stamina** / **Current Stamina** — Max is computed from the locked Stamina die and the character's stamina multiplier; Current is tracked live and regenerates via a per-turn roll
     - **Inventory** — list of items, each with a name and an optional description (add/edit/remove; editing via a per-row pencil toggle)
     - **Injuries** — same widget/behavior as Inventory: name + optional effect (add/edit/remove)
     - Both lists render stacked: bold name on top, description/effect under it in smaller grey text — and no second line at all when it's empty, so description-less entries stay compact
   - **Tab 2 — Stances:** list of the character's own stances (left-click to set active, highlighted when active; edit/delete per stance, minus the last-stance/active-stance rules above); **Stance Creator** to build a new one (name + pick exactly 2 of the 7 styles, icon-buttons); the counter chart (SVG tournament graph, highlighted for the active stance) with Best/Worst Matchups lists; active stance badge on the sheet header
   - **Tab 3 — Moves:** read-only list of the character's available moves (all Default moves + any Unique moves granted by the GM), rendered as full move cards per the decided structure (Tell header, move art + name + frame-data squares, style/tag chips, description, interactions with automation chips); Default/Unique badges; moves whose style isn't in the active stance render dimmed (unusable); GM can revoke a Unique move from here
   - **Tab 4 — Perks:** read-only grid (infinite rows, 2 columns) of granted Perks, name + description shown per card
   - **Tab 5 — Counters:** the character's own counters (name, target/current pips, +/- buttons), each with a "Show in Combat" toggle; anyone controlling the character can create a new one here (name + target pips 2-20)
   - **Tab 6 — Role-play:** persistent free-text fields, each under a question the player asks themselves about the character. Six canonical questions (what they love and can't pass by on the street; biggest traumatic event/memory; irrational fear; favorite food; what another person can do to infuriate them; biggest vice) with ~2-3-line answer boxes, kept compact so it all fits with little scrolling, plus the ability to add custom questions with answers — up to 20 additional per character (question editable, deletable). Same open-access editing as the rest of the sheet.
4. **Compendium** (GM-only) — persistent library of every move; the Tell manager (name + uploaded image, placeholders replaceable, in-use Tells undeletable); the Tag manager (world-level list); folders (create/rename/delete, delete returns moves to root) with the style filter (in-folder filters the folder, at root it scans all folders and labels each hit's origin); Move Creator form (art upload, name, Default toggle, Tell picker, required Style picker, Tag picker 0-10, folder assignment, frame-data inputs with live colored preview, description, On Hit/Block/Miss text + automation builders); drag a move onto a character in the page's character rail to grant it (per-move Grant checklist as touch fallback, with unlearnable characters disabled)
5. **Perks Compendium** (GM-only, separate from the Moves Compendium) — persistent library of every Perk; Perk Creator (name, description, one or more automation entries: Resource Manipulation or Move Tag); drag a Perk onto a character card to grant it
6. **Combat Arena** — shared page, no map/tokens. GM drags characters onto a left/right side and arranges them into pairs (semi-translucent divider between pairs); shows only portrait/dice pools/stamina per participant; NPCs here are visible to Players as an explicit exception. "Uneven Combat" toggle (GM-only) allows uneven pair sizes. Also shows any counters flagged "Show in Combat" (labeled `"{CharacterName} - {CounterName}"`) plus any standalone counters the GM created directly here. Includes the round's Declaration/Tic-Countdown phase indicator, a **Next Round** button, initiative results per pair, each character's declared-move slots (Tell-only until revealed), and the GM's Tic forward/back controls.
7. **Chat Log** — shared, live feed of all rolls and revealed-move cards, updates instantly on every connected device; a **Clear Chat** button empties it for everyone (also clears automatically on server restart)

## Implementation Phases (iterative — each ends with a deploy + playtest checkpoint)
Deploying only gets easier the earlier and more often it happens. Rather than one big build followed by one deploy at the end, each phase below should end with an actual deploy to Render/Turso and a quick real-device check, before starting the next phase.

**Phase 0 — Walking Skeleton**
- Vite+React frontend, Express backend, Turso connected, Socket.io wired end-to-end
- A trivial round-trip (e.g. one button that writes to Turso and broadcasts to all connected clients) deployed to Render
- Checkpoint: confirms hosting + DB + websockets all work together in production *before* any real feature gets built on top

**Phase 1 — Characters & Core Stats (Tab 1)**
- `characters` + `dice` tables, CRUD API, auto-seeded dice template
- Role-select modal, character list (role-filtered), creation form, delete-with-confirmation
- Tab 1 in full: name, portrait, dice pools (roll + step + tint), Lock/Revert, Max/Current Stamina, Inventory, Injuries
- Basic Chat Log (plain rolls only)
- Checkpoint: create a character, roll dice, take a hit, Lock/Revert, from two devices at once

**Phase 2 — Stances (Tab 2)**
- `attributes` + `attribute_counters` (seeded once the 7 are finalized) + `stances`
- Stance Creator, stance list, activate-on-click
- Checkpoint: build and switch stances live across devices

**Phase 3 — Moves, Tells & Compendium (Tab 3)**
- `tells` + `moves` + `character_moves`
- GM Compendium, Move Creator, drag-to-grant, Tab 3 read-only list
- Populate a handful of *real* Moves here rather than placeholders, per the risk notes above
- Checkpoint: grant a Unique move, confirm it shows up correctly

**Phase 4 — Perks & Tags (Tab 4)**
- `tags` + `move_tags` + `perks` + `perk_automations` + `character_perks` + `character_move_tags`
- GM Perks Compendium, Perk Creator, grant/revoke with automation apply logic
- Tab 4 read-only grid; populate a few real Perks
- Checkpoint: grant a Perk with each automation type, confirm the effect and the revoke-undo both work

**Phase 5 — Counters (Tab 5)**
- `counters` table, character-owned CRUD + Show in Combat toggle (the arena-side display comes in Phase 6)
- Checkpoint: create/adjust a counter live across devices

**Phase 6 — Combat Arena (structure only, no timing yet)**
- `combat_state` (Uneven Combat toggle only for now) + `combat_participants`
- Drag-in/out, pairing UI with divider, Uneven Combat toggle
- Standalone counters + Show-in-Combat counters displayed here
- Checkpoint: GM sets up a fight, Players see simplified NPC stats live

**Phase 7 — Combat Timing (the hard part — isolate before integrating)**
- Build and unit-test the placement/reveal/overflow math on its own first (see risk notes above) — a bare test harness, no UI polish, before wiring it in
- Then: `declared_moves`, per-side Brain initiative, Declaration Phase sequencing, Tic Countdown with GM forward/back, live reveal-vs-Tell filtering, Next Round flow, wired into the Arena
- Extend Chat Log with move-reveal-plus-roll cards
- Checkpoint: run one full mock round end-to-end, including an overflow case

**Phase 8 — Polish**
- Tailwind styling, Framer Motion transitions, GSAP effects, fighting-game theme across every tab/page
- Clear Chat button + auto-clear on server boot
- Final full-system playtest across multiple devices

## Implementation Risks & Recommendations
A scope check for whoever picks this up: this grew well past "semi-simple website" over the course of design. Most of it (dice, inventory, injuries, stances, perks, counters) is standard CRUD-plus-broadcast work. Combat Timing (Tics/Startup/reveal/overflow) is the one genuinely hard piece — real software complexity, not just more forms — and it's also the most original part of the system, which is exactly why it deserves the most care rather than being rushed alongside everything else.

**Recommended approach:**
- Build and playtest Combat Timing in isolation first, with a bare-bones/unstyled harness, before wiring it into the full Arena UI. It's the highest-risk piece and the most likely to need a tweak once it's actually moving (Is 5 Tics enough granularity? Does per-side initiative feel right with 3 vs 1?).
- **Write automated tests for the placement/reveal/overflow math specifically** — `placement_tic`, `reveal_tic`, the carryover rule, and Tell-vs-revealed visibility per client. This logic is pure and easy to test in isolation, and a bug here is the kind that's maximally disruptive mid-session and hard to spot just by looking at the UI.
- Populate real content early — actual Moves, Perks, and the final 7 Stance attributes — before polishing the Compendium UIs around them. Placeholder/TBD fields hide schema gaps that only surface once real content exists.
- Push the visual/GSAP polish pass to last. It's the most fun to build but also the most likely to get reworked if a mechanic changes shape during playtesting.

**Known risks to watch:**
- **No-login Tell secrecy gap** (see Open Items below) — a real, accepted trade-off, not a bug, but worth testing deliberately (refresh mid-round and confirm the behavior matches expectations) rather than discovering it live.
- **Render cold starts** could hit right as a session is starting. Worth explicitly testing Socket.io reconnection behavior after an idle spin-down, not just assuming it reconnects cleanly.
- **Perk automation payload** is deliberately loose JSON for MVP — the right call now, but keep an eye on it as real Perks get written, since flexible JSON payloads have a way of quietly turning into an ad hoc scripting language if the automation types multiply.
- **Interconnected live-sync systems** (a Perk revoke touching a die, which touches tinting, which touches Lock/Revert, etc.) tend to fail as "this number doesn't match what I expected" rather than a clean crash — harder to track down without a testing habit already in place, which is the main reason testing is called out here rather than left implicit.

## Open items to decide later (not blocking MVP)
- Exact combat/roll resolution rules (what a roll "means" mechanically) — not needed for the roll/step mechanism itself
- Visual theme specifics (colors, fonts, character art) — covered in the polish milestone
- How an active stance's attributes actually modify outcomes — the ±2 counter scoring is decided and displayed; full resolution depends on Moves/Combat Timing, still not fully described
- Per-style mechanical benefits (styles granting bonuses beyond counter matchups) — planned for later, structure TBD; attribute rows kept extensible for it
- How Current Stamina is spent/reduced during play — confirmed no automation for now; `stamina:adjust` remains the manual control, actual spending happens narratively at the table
- Full list of Default Moves (Block, Jab, Dodge, + others not yet named) — the Creator is live, content still needs to be written (in-app or provided)
- Real Tells (names + commissioned images) to replace the two seeded placeholders — GM task, tooling is live
- When/how On Hit / On Block / On Miss automations actually fire during combat (GM adjudicates hit/block/miss; presumably a GM control per resolved move) — Phase 7 design
- Exact set of Resource Manipulation types for Perks (which resources, whether they touch locked vs. current values) — to be refined once real Perks are written
- Perks are explicitly MVP-scope; more automation types are expected later
- Who besides the GM, if anyone, can press Clear Chat — currently assumed GM-only
- Interrupt resolution (e.g. a fast Jab potentially interrupting a slower move) is tracked via Tic order but not auto-adjudicated — a GM/table call for now
- **Known no-login limitation:** since there's no session-to-character binding, if the client controlling a character reloads mid-round before their declared move's reveal Tic, the server has no way to know it's "their" client and re-show them their own hidden move (everyone, including them, would only see the Tell until it naturally reveals). This is an accepted trade-off of the shared-link, no-auth design rather than something to solve with real accounts.
