# Custom TTRPG VTT — Project Plan

## Overview
A small, self-hosted virtual tabletop for one group (DM + players), accessed remotely over the internet from multiple devices simultaneously. No login system — one shared link, everyone sees everything within their role. Presentation-focused, fighting-game visual style. Core mechanic is a stepped dice-pool system tied to character HP/actions.

## Roles / access model
On every fresh page load, a modal asks: **Player** or **GM**. This is a client-side display filter, not authentication — there's still no login, no server-side enforcement, and no password. It exists purely so players aren't shown NPC stat blocks, consistent with the trust-based, single-shared-link approach already in place for everything else.
- **Player:** character list shows only characters with `character_type = 'pc'`. Can create new characters (always created as `pc`, no type selector shown) and can view/edit any PC sheet.
- **GM:** character list shows all characters (`pc` and `npc`). Character creation form includes a PC/NPC toggle. Can view/edit anything.
- The choice is not remembered — it asks again on every reload, and there's no in-app way to switch roles without reloading.
- This restriction is about **who can control which characters**, not about hiding activity: rolls, inventory/injury updates, stance changes, etc. are broadcast to and visible by everyone regardless of role — a Player sees an NPC's roll just like anyone else's. The only things actually restricted for Players are the character list (only PCs are listed/openable) and creating/editing NPCs — both GM-only. The Combat Arena is a deliberate exception to even that: NPCs placed there become visible to Players too (see below).
- **Character-list folders are GM-managed** (decided): only the GM creates/renames/deletes folders and drags characters into them; Players just browse whatever folders the GM has set up (same nested folder nav, same drag target for the GM, but no create/rename/delete controls or drag handles rendered for Players). This is the one organizational feature that's GM-only in the same way NPC creation is, even though folder contents themselves aren't secret. **Character folders nest (decided)**, mirroring Move Disciplines: `character_folders.parent_id` self-references to any depth; creating one while another is selected nests it inside; deleting one promotes its direct characters and direct child folders one level up to its own parent (root if it was already at root), not unconditionally to root, and the client follows the currently-viewed folder up to that same parent if it's the one being deleted.

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
  5. **Special interactions** — three categories always available: **On Hit / On Block / On Miss**. Each holds free text plus optional **automations**, limited to exactly four types for now: add/remove Recovery on yourself (±), add Recovery to the opponent, lose additional Stamina yourself, or the opponent loses Stamina. Anything else stays text-only, adjudicated at the table. Automations are stored/displayed now; they execute in the combat phases. A move flagged **Defensive** (`is_defensive`, decided) gets two more categories at the bottom of the same list — **On Successful Defense / On Failed Defense** — with the identical text + automation editor; a move that isn't Defensive never has these two, and switching Defensive off and re-saving drops any previously-stored rows for them (they're simply no longer accepted by the normalizer, so a wholesale `move:update` — which always replaces every interaction row — just doesn't recreate them). A category (any of the five) is only ever stored, and only ever rendered on a move card, when it actually has non-whitespace text or at least one automation — a category with neither simply doesn't exist for that move. Defensive moves show a small "Defensive" badge next to their name.
- **Images, not icons**: Moves and Tells each carry a small uploaded picture (commissioned simple art, uploaded by the GM through the Tell manager / Move Creator; resized client-side to ≤128px, PNG transparency preserved). Until uploaded, an initial-letter placeholder shows. Only the 7 styles keep open-source (lucide) icons.
- **Style (decided)**: every move is assigned one of the 7 styles (required in the Creator; rows created before this rule may be NULL = unrestricted). No mechanical modifier — it gates two things: **learnability** (a Unique move can only be granted to a character who has at least one stance containing that style — enforced server-side on grant and shown in the Grant checklist) and **usability** (a move is only usable while the character's *active* stance contains its style — unusable moves render dimmed on the Moves tab). Already-granted moves are kept if stances later change; they just show as unusable.
- **Roll (decided, optional)**, configured directly below Style in the Move Creator: a move can specify which dice it rolls plus one flat bonus (±20) shared across the whole collection — mechanically identical to Pool Roll (one shared modifier across an arbitrary dice selection), just pre-configured per move. Most moves are expected to have one, but it's optional for scalability (e.g. purely narrative moves). On a character's Moves tab, a move with a Roll shows the character's *actual current* die for each configured slot as a clickable button (e.g. `Body (d8+3)`, the same combined-formula convention as the Chat Log), pre-filled with the move's bonus — its own flat bonus plus any Perk-granted `move_roll_bonus` for that move (see Perks & Tags: this is now the live use case for that automation) — but freely editable before rolling, in the same roll dialog used everywhere else. An incapacitated die among the configured slots is silently dropped rather than blocking the roll, exactly like Pool Roll. In the Compendium (no character context to resolve real dice against), the Roll shows only the static slot names and bonus.
  - **Roll slot vocabulary (decided)**: 6 choices, not the 8 concrete dice — Skull, Brain, Stamina, Body, plus two **ambiguous appendage choices**: **Left/Right Hand** and **Left/Right Leg**. The GM doesn't commit to a side at creation time; the *player* picks Left or Right at the moment the move is actually rolled, on the character's Moves tab. If a Roll includes either ambiguous choice, ONE Left/Right pick governs the whole Roll — a move using both Left/Right Hand and Left/Right Leg resolves both together from that single choice (e.g. "Left" rolls the Left Hand die AND the Left Leg die), not independently per slot. The Moves tab renders one Roll button per available side (e.g. `Right: Body (d8+3) + Right Hand (d10+3)` / `Left: Body (d8+3) + Left Hand (d8+3)`) so the player can see each side's actual current dice before committing; clicking either opens the roll dialog pre-filled exactly like a normal Roll.
  - **Ambiguous Roll needs two Tells (decided)**: a move using Left/Right Hand or Left/Right Leg needs a **Right Tell** and a **Left Tell** instead of the usual single Tell — the Move Creator swaps in two Tell dropdowns in that case. Since nothing commits to a side until the move is actually rolled, the move's Tell header always shows **both Tells side by side** (in the Compendium and on every character sheet) rather than picking one arbitrarily.
- **Tags (decided)**: each move carries 0-10 Tags, picked from the world-level GM-managed `tags` list (created/edited in the Compendium, like Tells — this pulls the base tag tables forward from Phase 4; per-character tag overrides via Perks remain Phase 4). Tags can also change dynamically later (Perks adding Tags to specific moves). A Tag has a **name and an optional description**; hovering a Tag anywhere it's shown (the Tag manager, a Move Creator's picker, a Move card) pops a tooltip with that description.
- **Compendium** — a persistent, GM-only library of every move ever created (default and unique). The GM drags a move from the compendium onto a character in the page's character rail to grant it (a per-move Grant checklist covers touch devices); the GM can revoke a Unique move from the character's Moves tab.
- **Compendium folders, shown in the UI as "Discipline" (decided)**: folders exist to organize moves by which **martial art/discipline** they come from (Karate, Muay Thai, etc.) — "Discipline" is purely a display label for the same underlying folder mechanism (`move_folders`, `folder:*` events), chosen because "Style" already means something else (the 7 tournament attributes). **Disciplines nest (decided)** — `move_folders.parent_id` self-references, so a discipline can itself contain sub-disciplines to any depth (e.g. "Striking / Boxing / Southpaw"). The GM creates disciplines and places moves in them — either assigned in the Move Creator (a select showing the full indented hierarchy, e.g. "Striking / Boxing"), or by **dragging a move card onto a discipline row** in the nested nav (dragging onto "All Moves"/root clears the move's discipline); creating a discipline while another is selected nests it inside that one. Deleting a discipline promotes its directly-contained moves and direct child disciplines **one level up, to the deleted discipline's own parent** (root if it was already at root) — not unconditionally to root, so removing a nested discipline only collapses that one level rather than flattening its whole subtree; if the client is currently viewing the deleted discipline, it follows automatically to that parent (or root). **"All Moves" shows every move regardless of discipline** — a specific discipline shows only its own moves. A **style filter** further narrows whichever of those two is currently showing. Every move card, everywhere (Compendium and every character sheet, not just under a style filter), always shows its **full discipline path** — "📁 Striking / Boxing" if filed under a nested one, or **"Without Discipline"** if not.
- **Tells** — a separate, world-level list, editable by the GM at any time (unlike the fixed 7 stance attributes). A Tell is a **name + small uploaded image**. Two placeholders ("Tell 1", "Tell 2") are seeded so moves can be created immediately; the GM replaces them with real Tells. A Tell in use by a move can't be deleted. When creating a move, the GM picks one Tell from this list.
- **Declaring a move** — happens during combat, with real timing/reveal mechanics covered in detail in "Combat Timing" below. Short version: only the Tell is shown to everyone (including the GM) until the move's Startup timer completes.

## Game mechanic — Combat Arena
No map or tokens. Instead, a dedicated shared Combat Arena page (built in Phase 6 as **structure only** — seating, pairing, and everything below; the round/Tic timing described in Combat Timing below is Phase 7):
- The GM drags characters (PC or NPC) from a roster rail onto a **left** or **right** side to start a fight — the rail lists only not-yet-seated characters (role-filtered the same as the character list: PCs only for a Player, though only the GM ever sees the rail or drag handles at all). **The roster is grouped by character folder, recursively (decided)**: folders render first, nested with visible indentation, sorted alphabetically at every level; each folder header is clickable to collapse/expand its whole subtree (local UI state, a `Set` of collapsed folder ids) and shows a running count of every available character inside it including descendants; a folder whose entire subtree has nobody available hides itself rather than showing an always-empty row; inside an expanded folder, its own direct characters render before its child folders. Folderless characters render **last**, under their own "Folderless" heading, below every folder. Each seated/available card shows a simplified view: portrait, active stance (if any — the same live-broadcast stance the Stances tab shows, since it's meant to be visible strategic info), dice pools, and stamina — not the full sheet. **This view is read-only** (decided): no roll/step controls on the card itself, since Phase 6 has no combat-triggered rolling to do yet — click a card to jump to that character's own sheet to actually roll/step, and the Arena's copy stays live via the same broadcasts the sheet uses. **Seated participant cards render horizontally (decided)**: a full-height portrait column (`object-cover`, no padding/gaps, ~7rem wide growing to ~8rem on larger screens) fills the entire left side of the card, with name/NPC badge/active stance/stamina/dice pools stacked on the right; the card itself keeps a `min-h-40 min-w-64` floor plus the existing fill/scale-with-Uneven-Combat behavior from before.
- **Exception to normal NPC hiding:** once an NPC is placed in the arena, its simplified stats become visible to Players too — the whole point is so players can see and strategize against their opponent. This is the one place NPC info is shown to Players.
- **Pairing (decided):** the GM arranges participants into **pairs** by dragging a character card onto a specific pair row's left or right zone (a semi-translucent divider marks each pair); an empty row is always available at the end to start a new pair. Dropping onto an already-occupied zone *adds* to that side of the pair rather than replacing — that's what makes an Uneven Combat grouping (2v1, etc.) possible. Since the system centers on 1-on-1 duels even within a larger fight, this pairing is a real grouping (`pair_index`), not just visual ordering.
- **Uneven Combat** toggle (GM-only): when on, a pair can have multiple characters on one side against a single character on the other. This is a GM-side convenience flag — the app doesn't hard-block uneven pairs when it's off, that's on the GM to respect.
- Only the GM can drag characters into, out of, or around the arena; a small ✕ on each seated card (GM-only) removes just that character, and a page-level **Clear Arena** button (GM-only) empties it entirely.
- Arena state (who's in it, sides, pairing, the Uneven Combat toggle) is persisted like everything else, so it survives reloads mid-fight. Deleting a seated character removes them from the arena too (explicit cascade, same pattern as the rest of a character's owned records).
- **Counters in the Arena (decided, pulled forward from the Counters mechanic):** the page also lists every counter relevant to the fight — any character's counter flagged Show in Combat (only while that character is actually seated), plus standalone counters. Standalone counters are **created** GM-only (a small form on the page), but **adjusting** pips or deleting any counter shown here follows the same open-access rule as the character sheet's own Counters tab (no per-counter ownership check anywhere in this app) — only creation of a new standalone one is gated.

## Game mechanic — Combat Timing (Initiative, Tells, Tics)
One shared timer runs the whole round (not one per pair), and it's actually a single **global counter that never resets** — round boundaries are just markers on that timeline, which is what makes overflow between rounds work cleanly (see below). Each round has two phases:

**Start Combat / End Combat (decided):** a Combat Arena toggle, separate from the round loop below — while `phase` is non-null (i.e. a fight is actually on), a global **Tic Counter header** appears at the top of *every* page in the app (not just the Arena), so the round/phase, the Tic strip, and the round controls are reachable no matter what page anyone's looking at. **Start Combat** (Arena-only, since the header itself is hidden until a fight is on) is just the first **Next Round** press under a friendlier label; **End Combat** (in both the header and the Arena) resets `phase`/`round_number`/`current_tic`/`declared_moves` the same way **Clear Arena** does, but — unlike Clear Arena — leaves everyone seated, so a new fight can start right away without re-seating. The header also hosts **Done Declaring**, **Next Round**, and the Tic ◀/▶ step controls, all moved out of the Arena page itself (see Combat Arena above); the Arena keeps the roster, the declare-a-move picker, and the declared-moves list.

**Declaration Phase**
- The GM presses **Next Round** (or, for the very first round, **Start Combat** — the same event): increments the round number, marks the current Tic as this round's start, rolls the Brain die for every participant (posted to chat as normal initiative rolls), opens declarations.
- **Initiative is per side, not per character** — this covers both even 1-on-1 pairs and Uneven Combat the same way: a side's Initiative is the *highest* Brain roll among all characters on that side of the pair. The losing side's characters all declare (queue) their moves first — only Tells show, to everyone including the GM. The winning side's characters then declare theirs, having already seen the losing side's Tells. **Decided:** this ordering is server-enforced, not just a UI suggestion — a side must be explicitly marked done (`combat:side_done_declaring`, open-access, same trust model as declaring itself) before the other side's `move:declare` calls are accepted; a side with nobody seated on it is skipped automatically rather than needing to be marked done.
- A character can queue more than one move for the round during this phase, but once the Tic countdown starts, no new declarations can be made or changed.
- **Declaring is drag-and-drop (decided):** the declare picker lists each eligible character's moves under **Default**/**Unique** tabs (a card per move, its Stamina Cost shown); dragging a card onto the global header's Tic Counter strip declares it. While dragging, the header live-previews the move's footprint — its Startup/Active/Recovery squares — anchored to whichever Tic is currently under the pointer, so the *declaring player* can see exactly how much of the timeline it'll occupy before dropping it; this preview is purely local to that client's own drag interaction (never broadcast), so it can't leak a move's position to an opponent. The Tic actually dropped on is honored as the move's `placement_tic`, as long as it's at or after the character's own next-eligible Tic (below); dropping earlier than that silently **snaps forward** to the earliest legal Tic rather than rejecting the drop, so a player never has to fuss with finding the exact minimum by hand. This is also how a character queues several moves ahead of time in one go — drop each one at whatever future Tic makes sense, rather than being limited to the single next available slot.
- For a character's next queued move (their 1st this round or their 4th), its placement Tic can be no earlier than whichever is later: the round's start Tic, or that character's own last-queued move's reveal Tic — even if that move was queued in a *previous* round. That second case is exactly how overflow works (next point).

**Tic Countdown Phase**
- The GM presses a button to lock in declarations and start the countdown, then manually moves the (global) Tic counter forward and backward — a round is 7 Tics (bumped up from an initial 5 after playtesting; the length isn't hardcoded and can change again later). The GM's display shows Tics relative to the current round (Tic 1-7), even though the counter underneath never actually resets.
- Every Move has a **Startup** (in Tics — the same unit also called "Pips"). A move placed at Tic *N* resolves/reveals at Tic *N + Startup*. Until then, everyone (GM included) sees only its Tell; the instant the counter reaches that Tic, the real move is revealed to everyone — no automatic stat changes, purely informational. **Decided:** the roll isn't automatic — a revealed move's Roll (if it has one) is triggered manually, the same Roll button/dialog used everywhere else in the app (handles an ambiguous Left/Right Roll identically too); posting the reveal itself to the Chat Log as a proper card is deferred to its own later step (see Phase 7's checklist below), not bundled into this one.
  - Example: a Hook with Startup 3, placed at the start of the round, shows its Tell through Tics 1-3; the moment the counter reaches Tic 4, it's revealed as a Hook.
- Since the Move structure was finalized (Phase 3), moves also carry **Active** and **Recovery** Tics beyond Startup: after revealing, a move actively hits through its Active squares, then its Recovery squares occupy the timeline — carrying into the next round if they run past the round's end, exactly like Startup overflow. **Decided:** Active/Recovery do **not** extend the Declaration Phase's placement-blocking rule above — a character's next move is still only blocked until their previous move's *reveal* Tic (Startup only), matching the rule as originally written; Active/Recovery are tracked purely as the move's own footprint (when it hits, when its Recovery ends) for display and, later, for when On Hit/Block/Miss automations fire — a still-open Phase 7 question, see Open Items.
- **Overflow:** if a move's reveal Tic falls past the round's 5-Tic window, it simply carries into the next round — e.g. overflowing by 2 means the first 2 Tics of the next round are already occupied finishing that move. Because the Tic counter never resets, this needs no special-casing: the move's reveal Tic was always an absolute point on the timeline, and (per the Declaration Phase rule above) that character's next new move can't be placed any earlier than that point anyway.
- Reveal state is computed live from the current Tic vs. each move's reveal point, so moving the counter backward re-hides a move that hasn't "really" happened yet in the GM's current read of the scene.
- Fast, low-Startup moves (e.g. a Jab with Startup 2) can potentially interrupt slower ones declared earlier but resolving later — the app tracks the Tic order but doesn't auto-adjudicate interrupts; that's a GM/table call.
- Pressing **Next Round** returns to the Declaration Phase.

**Stamina Cost (decided):** every move carries a required **Stamina Cost** (0 is a valid free cost; negative restores Stamina instead of spending it). Declaring a move never spends it immediately — `move:declare` only checks *affordability* up front, against the declaring character's Current Stamina minus every other move they already have queued-but-not-yet-committed this Declaration Phase (so a character can never queue more than they could actually pay for once committed; an unaffordable declare is a silent no-op, same pattern as every other rejected declare). The actual spend/restore happens in one batch, for every character on that side, the moment the side presses **Done Declaring** (`combat:side_done_declaring`) — clamped to `[0, max_stamina]` as a defensive backstop (the up-front check already keeps this from going negative in the normal flow). Because the move can be declared to land at any open Tic, and its Stamina Cost is committed well before its Startup even finishes, the Arena deliberately shows **no timing/length information** for a still-secret declared move (see Combat Arena below) — only a live Stamina *preview*, computed client-side and visible only to the declaring client itself (the server never puts a pending, uncommitted cost on the public broadcast — same secrecy boundary as the move's identity).

**Implementation note:** the placement/reveal/overflow math above started as a bare pure-function module — `server/combatTiming.js` (`resolveSideInitiative`, `computePlacementTic`, `computeMoveFootprint`, `isMoveRevealedTo`, `relativeTic`) — unit-tested in isolation before any socket/DB/Arena wiring, per the Implementation Risks section's recommended approach; it's now wired into `declared_moves` + the `combat:*`/`move:declare` events below and a real Arena UI (status bar, per-side Done Declaring, a declare-a-move picker, Tic forward/back, Tell-vs-revealed badges on each seated card). `resolveSideInitiative`'s tied-initiative case isn't specified above; it's broken by having the `left` side declare first (`right` wins ties) — an arbitrary but deterministic default. The no-auth model means the server can't tell which client "owns" a declared move (see the Known no-login limitation in Open Items) — it withholds the real move from every broadcast/response equally and relies on the declaring client to remember its own move locally (a direct `declared_move:own` emit, session-only — lost on reload, the accepted trade-off). That same direct emit also carries the move's `staminaCost` (never the public broadcast), which is how the declaring client's live Stamina preview stays exactly as secret as the move's identity.

## Game mechanic — Chat Log
A single shared feed for the whole game (what was "roll log" earlier — renamed since it now shows more than dice rolls):
- Every die/pool roll posts here, as already described. Each entry shows the roller's small avatar (their portrait, or an initial-letter placeholder) to the left of their name; the roll modifier is **not** shown as a separate tag near the name — it's folded into each die's own formula instead (a die's permanent bonus + the roll's ad-hoc modifier combined into one signed value, e.g. `Body (d8+3): 11`), so the parenthetical always matches the printed result.
- When a declared move resolves, its revealed move card posts alongside a roll — informational only, no automatic stat effects.
- **Free-text messages (decided):** anyone can also post a plain chat message via a compose box at the bottom of the panel — a character picker ("Post as…", defaulting to whichever was last used this session, PC-only for Players/all characters for GM, same visibility rule as everywhere else), and a text field. A message needs text or an image (or both) — an empty send is a no-op; text is capped at 2000 characters server-side. Rendered with the same avatar+name+timestamp header as a roll, just showing the text/image instead of dice.
- **Images/GIFs (decided):** attached by **pasting** an image directly into the compose box's text field (no file-picker button) — capped at 480px wide for static images (PNG re-encoded losslessly, everything else as JPEG ~85%) — except GIFs, which are sent as their raw uploaded bytes with no canvas re-encoding (capped at 4MB client-side) specifically so the animation survives; canvas re-export only ever keeps one frame. Socket.io's `maxHttpBufferSize` is raised to 8MB server-side to fit a base64-encoded GIF at that cap.
- **Move-reveal cards expand on click (decided):** the compact card a move's reveal posts (portrait, name, `FrameBar`) toggles open on click to show its full description and Stamina Cost — no extra request, since both fields already ride the `chat:move_reveal`/`GET /api/chat` payload.
- Nothing chat-related is kept for long: clears automatically on server restart (an actual `DELETE FROM chat_log` at boot, not just an incidental side effect of Render's free tier spinning the server down between quiet periods) and via a manual **Clear Chat** button, GM-only (decided — matches every other admin-style control in the app; the server itself doesn't enforce this, same as everywhere else in this no-auth app).

## Game mechanic — Perks & Tags (Perks tab)
- Perks are created by the GM in their own **Perks Compendium**, separate from the Moves Compendium, and granted the same way — drag-and-drop onto a character in the page's character rail (a per-Perk Grant checklist covers touch devices, same pattern as Moves).
- A Perk is just three things (decided): **picture** (small uploaded image, optional — same upload pattern as Moves/Tells, placeholder letter until set), **name**, and **description**. Granting/revoking a Perk is pure membership (`character_perks`) — no automatic mechanical effect.
- **Mechanical effects are manual, case-by-case code, not a generic automation system** (decided — replaced the original Phase 4 registry of 5 automation types, which was removed entirely along with its `perk_automations`/`character_perk_automations` tables). A Perk that needs a real effect (stepping a die, adjusting the stamina multiplier, tagging/overriding a specific Move for one character, biasing a Move's Roll) gets a bespoke `onGrant`/`onRevoke` entry in `server/perkAutomations.js`'s `PERK_HOOKS` map, keyed by the Perk's exact name, written by hand when that Perk's content is actually decided. The `character_move_tags`/`character_move_overrides`/`character_move_roll_bonuses` tables (see Moves & Tells above) still exist and are still what the Moves tab reads for a character's effective tags/frame data/roll bonus — a hook just has to write to them itself (tagging its rows with `source_character_perk_id` as before) instead of a generic apply step doing it. `perk:revoke` still bulk-deletes any such rows for that grant automatically, whether a hook wrote them or (historically) the old registry did.
- A Perk in use (granted to anyone) can't be deleted — matches the same "in use" pattern already used for Tells.
- The Perks tab on a character sheet is read-only — displays granted Perks in a grid (infinite rows, 2 columns), each card showing picture/name/description (for the same transparency reason granted Moves show their full effect; there's no automation data left to display).

## Game mechanic — Counters
Simple, persistent "clocks" — no automation, just a name, a target (2-20 pips), a current count, and +/- buttons.
- **Character-owned counters:** created by whoever controls that character (any player for a PC, GM for an NPC), shown on that character's own Counters tab — same open-access pattern as Inventory.
- **Standalone counters:** created directly in the Combat Arena, not tied to any character — GM-only, since arena control is already GM-only.
- **Show in Combat toggle:** a character-owned counter can be flagged to also appear in the Combat Arena, labeled `"{CharacterName} - {CounterName}"` (e.g. "Aaron - Rage"). It's the same underlying record wherever it's shown — adjusting it from the Arena or from the character sheet updates the other live.
- **Reward tag (decided)**: a character-owned counter can optionally carry one **Reward** — purely a tracking label, no mechanical effect — set at creation or changed any time after via a small colored select that doubles as the tag itself, next to the counter's name. Five types, each with its own color: **Story** (amber), **Statistic** (blue), **Perk** (violet), **Move** (orange), **Combat Prowess** (red). **Standalone counters can never have one** (the create form has no reward option, and the server ignores/rejects `rewardType` for a `character_id`-null counter, both at creation and via `counter:set_reward`). If a character-owned counter with a reward is flagged Show in Combat, its reward tag still shows in the Arena's Counters section — read-only there; editing only happens from the character's own Counters tab.

## Global UI — Search
Every page's header carries a **Search bar**, available to all roles (not GM-only, unlike the Compendium itself). Typing debounces (250ms) a query against `GET /api/search?q=...`, which matches **named library entities only** — Characters, Moves, Perks, Tells, Tags — by substring on name or description, case-insensitive; character sub-records (Inventory, Injuries, Stances, Counters) are deliberately not indexed. Results render in a dropdown grouped by type. The same role-based visibility rule used everywhere else applies **client-side**, same as the rest of this no-auth app: NPCs are filtered out of Character results for Players. Clicking a Character result navigates straight to its sheet; clicking a Move/Perk/Tell/Tag result opens the GM-only Compendium to the relevant internal tab (Perks vs. Moves/Tells/Tags) — for Players those rows still show (the underlying entities aren't secret) but aren't clickable, since there's no page for a Player to open them into.

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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  folder_id INTEGER -- character list folder; NULL = root
);

-- GM-managed folders for organizing the character list — same structural
-- pattern as move_folders (create/rename/delete). Nested: parent_id
-- self-references (NULL = root); ON DELETE SET NULL is metadata only — the
-- real reparent-on-delete logic (promote to the deleted folder's own
-- parent, not unconditionally to root) is explicit in character_folder:delete.
CREATE TABLE character_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES character_folders(id) ON DELETE SET NULL
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

-- No FK on character_id or move_id: entries must survive character/move
-- deletion (shown as "(deleted)" / "(move deleted)"). kind='message' rows
-- are free-text posts (optionally with an image/GIF); kind='move_reveal'
-- rows are posted automatically by combat:tic_forward (move_id set, no
-- roll attached — a Roll is a completely separate ordinary kind='roll'
-- entry). dice_rolled stays '[]' rather than NULL for both kinds. The text
-- column is named `content`, not `message` — a column literally named
-- "message" would collide with the migration helper's word-boundary column
-- check, which would then false-positive-match the CHECK constraint's own
-- 'message' enum literal and silently skip adding the column. kind's CHECK
-- constraint needed the same table-rebuild migration as move_interactions.trigger
-- below when 'move_reveal' was added (see migrateChatLogKind in server/db.js) —
-- SQLite can't ALTER a CHECK constraint in place.
CREATE TABLE chat_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal')),
  character_id INTEGER NOT NULL,
  dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
  modifier INTEGER NOT NULL DEFAULT 0,
  move_id INTEGER, -- set for kind='move_reveal'; null for a plain roll/message
  content TEXT, -- free-text message content; kind='message' only
  image_data TEXT, -- base64; kind='message' only. GIFs stored raw/unresized to keep animation
  image_mime_type TEXT,
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
-- Just picture, name, description (decided) — mechanical effects, if any,
-- are manual per-Perk code in server/perkAutomations.js's PERK_HOOKS map,
-- not stored data. The original perk_automations/character_perk_automations
-- tables (a generic 5-type automation registry, applied/reversed
-- automatically on every grant/revoke) were removed for this reason.
CREATE TABLE perks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_data TEXT,      -- base64 small uploaded image, optional
  image_mime_type TEXT
);

-- Pure membership — granting/revoking a Perk has no automatic effect beyond
-- this row unless PERK_HOOKS has an entry for that Perk's name.
CREATE TABLE character_perks (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
  UNIQUE(character_id, perk_id)
);

-- World-level, GM-managed, like Tells (landed in Phase 3 for Move tagging)
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' -- shown as a tooltip wherever the tag appears
);

-- Base tags on a Move template — global, visible to everyone with that Move
-- (0-10 per move, landed in Phase 3)
CREATE TABLE move_tags (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(move_id, tag_id)
);

-- Character-scoped tag overrides, written by a Perk's manual PERK_HOOKS entry (personal, not global)
CREATE TABLE character_move_tags (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('add','remove')), -- 'remove' suppresses a base tag just for this character
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
  -- points at the grant instance (not the perk template), so revoking-then-
  -- regranting the same Perk can't be confused with the earlier grant
);
-- A character's effective tags on a move = move_tags, plus 'add' overrides, minus 'remove' overrides from character_move_tags

-- Per-character frame-data deltas on a specific move, written by a Perk's
-- manual PERK_HOOKS entry — "the move copy on the character," not the
-- shared template. Multiple Perks touching the same move on the same
-- character sum.
CREATE TABLE character_move_overrides (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  startup_delta INTEGER NOT NULL DEFAULT 0,
  active_delta INTEGER NOT NULL DEFAULT 0,
  recovery_delta INTEGER NOT NULL DEFAULT 0,
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
);

-- Per-character bonus scoped to a specific move (written by a Perk's manual
-- PERK_HOOKS entry), applying only to rolls made using that move. Live once
-- the move has a Roll configured (move_roll_slots) — folded into the
-- pre-filled modifier on click. For a move with no Roll, still
-- stored/displayed but with nothing to attach to until Phase 7 gives
-- declared moves their own reveal-and-roll.
CREATE TABLE character_move_roll_bonuses (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
);

CREATE TABLE counters (
  id INTEGER PRIMARY KEY,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE, -- NULL = standalone arena counter
  name TEXT NOT NULL,
  target_pips INTEGER NOT NULL CHECK(target_pips BETWEEN 2 AND 20),
  current_pips INTEGER NOT NULL DEFAULT 0,
  show_in_combat INTEGER NOT NULL DEFAULT 0, -- only meaningful when character_id is set
  -- Purely cosmetic tracking tag, no mechanical effect — character-owned
  -- counters only (server rejects it for a standalone character_id=NULL
  -- counter, both on create and via counter:set_reward)
  reward_type TEXT CHECK(reward_type IN ('story','statistic','perk','move','combat_prowess'))
);

-- GM-created folders for organizing the Moves compendium. Nested, same
-- parent_id self-reference pattern as character_folders above.
CREATE TABLE move_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES move_folders(id) ON DELETE SET NULL
);

-- The compendium: master list of move templates (structure finalized).
-- folder_id doubles as "discipline" in the UI — see Moves & Tells above.
CREATE TABLE moves (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, -- 1 = auto-granted to every character
  tell_id INTEGER NOT NULL REFERENCES tells(id),
  startup_tics INTEGER NOT NULL DEFAULT 1,   -- frame data: 0-10 each,
  active_tics INTEGER NOT NULL DEFAULT 1,    -- at least 1 square total
  recovery_tics INTEGER NOT NULL DEFAULT 0,
  -- Required at creation (0 is a valid free cost; negative restores Stamina
  -- instead of spending it) — subtracted from Current Stamina in one batch
  -- when the declaring side finishes declaring (combat:side_done_declaring),
  -- not at move:declare time. See Combat Timing mechanic below.
  stamina_cost INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  style_attribute_id INTEGER REFERENCES attributes(id), -- learn/use gate; NULL only on legacy rows
  folder_id INTEGER,    -- compendium folder ("discipline" in the UI); NULL = root / Without Discipline
  image_data TEXT,      -- base64 small uploaded image
  image_mime_type TEXT,
  roll_modifier INTEGER NOT NULL DEFAULT 0, -- flat bonus on this move's own Roll (see move_roll_slots);
                                             -- distinct from the per-character roll_bonus a Perk can grant
  -- Only set when the Roll includes an ambiguous Left/Right Hand or Leg
  -- slot: the two Tells the header shows side by side, one per appendage
  -- choice. tell_id above is left pointing at one of them in that case,
  -- purely to satisfy its NOT NULL constraint — ignored once both are set.
  right_tell_id INTEGER REFERENCES tells(id),
  left_tell_id INTEGER REFERENCES tells(id),
  -- 1 = this move has On Successful Defense / On Failed Defense
  -- interactions available (see move_interactions below)
  is_defensive INTEGER NOT NULL DEFAULT 0
);

-- Which of a move's optional Roll dice it's made of (see Moves & Tells
-- above) — a move with no rows here simply has no Roll. slot_name is either
-- a concrete DICE_TEMPLATE slot (Skull/Brain/Stamina/Body) or one of the
-- two ambiguous appendage choices, 'Hand' or 'Leg' — resolved to the
-- character's actual Left or Right die only at roll time, per the player's
-- choice, not a slot the GM commits to at creation time.
CREATE TABLE move_roll_slots (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  slot_name TEXT NOT NULL,
  UNIQUE(move_id, slot_name)
);

-- On Hit / On Block / On Miss (every move) plus On Successful Defense /
-- On Failed Defense (Defensive moves only, gated by moves.is_defensive both
-- client and server side): text plus optional automations (only rows with
-- non-whitespace text or at least one automation are stored — a category
-- with neither simply has no row and is never rendered).
--
-- The trigger CHECK was originally 3-value ('hit','block','miss'); adding
-- defense_success/defense_failure required a migration since SQLite can't
-- ALTER a CHECK constraint in place — an existing table gets rebuilt (a v2
-- table with the expanded CHECK, every row copied across, old table
-- dropped, v2 renamed into place) the first time initDb runs against it;
-- see migrateMoveInteractionsTrigger() in server/db.js.
CREATE TABLE move_interactions (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure')),
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

-- Singleton row holding the arena's global state. Phase 6 (done) only
-- creates uneven_combat_enabled; phase/round_number/current_tic/
-- current_tic is a single counter that never resets across rounds;
-- round_start_tic just marks where the current round began on that
-- timeline, so overflow from a previous round's carried-over move works
-- without any special-casing. phase is null until the first Next Round
-- press. declaring_side is whichever side may currently call move:declare
-- (null once both sides are done, or trivially done via an empty side);
-- pending_declare_side is the side still queued behind it.
CREATE TABLE combat_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uneven_combat_enabled INTEGER NOT NULL DEFAULT 0,
  phase TEXT CHECK(phase IN ('declaration','tic_countdown')),
  round_number INTEGER NOT NULL DEFAULT 0,
  current_tic INTEGER NOT NULL DEFAULT 0,
  round_start_tic INTEGER NOT NULL DEFAULT 0,
  round_length INTEGER NOT NULL DEFAULT 7,
  declaring_side TEXT CHECK(declaring_side IN ('left','right')),
  pending_declare_side TEXT CHECK(pending_declare_side IN ('left','right'))
);

-- Who's currently seated. side + pair_index group participants into facing
-- pairs; more than one character can share a side/pair_index (Uneven
-- Combat groupings like 2v1) — the app doesn't enforce the toggle, that's
-- a GM-facing flag only. A character can only be seated once.
CREATE TABLE combat_participants (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('left','right')),
  pair_index INTEGER NOT NULL,
  UNIQUE(character_id)
);

-- Per-round queued moves. Persisted so they survive reloads mid-round, but every
-- broadcast/response withholds move_id until the reveal Tic (the server can't tell
-- whose client is asking — see the no-auth limitation in Open Items); the declaring
-- client gets the real move once, directly, via a declared_move:own emit at declare
-- time, and remembers it locally rather than the server tracking ownership.
CREATE TABLE declared_moves (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id),
  round_number INTEGER NOT NULL,
  queue_order INTEGER NOT NULL, -- this character's Nth move declared this round
  placement_tic INTEGER NOT NULL,
  reveal_tic INTEGER NOT NULL, -- placement_tic + the move's startup_tics
  reveal_posted INTEGER NOT NULL DEFAULT 0, -- has the move_reveal chat card already gone out? (idempotency, not visibility — see chat_log above)
  stamina_committed INTEGER NOT NULL DEFAULT 0 -- has this move's Stamina Cost actually left/returned to current_stamina yet? (see Combat Timing mechanic below)
);
```
When a character is created, auto-generate its 8 `dice` rows (2 head + 4 core + 2 legs) at a default size of d8, editable afterward via step up/down.

**Image storage note:** portraits are stored directly in Turso as base64 (`image_data`) rather than a separate image hosting service — simplest option, no extra account needed, and well within Turso's free storage limits for a handful of character portraits. To keep rows small, the frontend should resize/compress images client-side before upload (e.g. cap at ~800px wide) rather than uploading a raw phone photo.

**Move list note:** a character's full Tab 3 list = all `moves` where `is_default = 1`, plus all moves joined through `character_moves` for that character. Declared moves during combat ARE persisted (`declared_moves`), unlike the earlier draft of this plan — the Tic-based reveal timer needs them to survive a mid-round reload. The server still withholds the real `move_id` from broadcasts to non-owners until the reveal Tic, sending only the Tell.

## Real-time events (Socket.io)
- `character:created` / `character:updated` / `character:deleted` — server → all clients, includes `character_type`. `character:updated` covers name edits, portrait uploads, and folder reassignment alike, so every device refreshes all three live.
- `character_folder:create` / `character_folder:rename` / `character_folder:delete` (client [GM] → server): `{ name, parentFolderId? }` / `{ folderId, name }` / `{ folderId }` — manages `character_folders`. `parentFolderId` nests the new folder inside an existing one (validated server-side; an unknown id falls back to root). Delete promotes the folder's direct characters and direct child folders **one level up, to the deleted folder's own `parent_id`** (root if it was already at root) rather than unconditionally to root, then removes the folder; broadcasts `character_folder:created` / `character_folder:updated` / `character_folder:deleted` (the delete payload includes `{ folderId, parentFolderId }` so a client viewing the deleted folder can follow it up to the same parent). `GET /api/character-folders` lists them, including `parent_id` (kept separate from `GET /api/characters`, whose flat-array shape existing callers depend on).
- `character:set_folder` (client [GM] → server): `{ characterId, folderId }` (`folderId` null = root; an unknown id also falls back to root) — the drag-and-drop reassignment path, mirrors `move:set_folder`: touches only `characters.folder_id`. Broadcasts `character:updated`. `POST /api/characters` also accepts an optional `folderId` so a new character can be filed in directly from the Add Character form (GM only — Players' new PCs always land at root).
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
- `tell:create` / `tell:update` / `tell:delete` (client [GM] → server): `{ name, imageData?, imageMimeType? }` / `{ tellId, name, imageData?, imageMimeType? }` (image only replaced when provided) / `{ tellId }` — manages the world-level `tells` list (delete refused while any move uses the Tell as its `tell_id`, `right_tell_id`, or `left_tell_id`), broadcasts `tell:created` / `tell:updated` / `tell:deleted` to all clients
- `move:create` / `move:update` / `move:delete` (client [GM] → server): `{ name, isDefault, isDefensive, tellId?, rightTellId?, leftTellId?, styleAttributeId, folderId, tagIds, rollSlots?, rollModifier?, imageData?, imageMimeType?, startupTics, activeTics, recoveryTics, description, interactions: {hit|block|miss|defense_success|defense_failure: {text, automations}} }` / `{ moveId, ...same fields }` (interactions + tags + roll slots replaced wholesale on update; image only when provided) / `{ moveId }` — manages `moves` + `move_interactions` + `move_tags` + `move_roll_slots` (delete cascades to `character_moves`), broadcasts `move:created` / `move:updated` / `move:deleted` (full move incl. interactions, tag_ids, roll_slots, roll_modifier, right_tell_id, left_tell_id, is_defensive) to all clients. `rollSlots` dedupes and drops unknown slot names (6 valid values — see Roll slot vocabulary above); an empty/omitted list means the move has no Roll. `tellId` is required unless `rollSlots` includes an ambiguous Left/Right slot, in which case `rightTellId` and `leftTellId` are required instead (both validated to exist) — a request satisfying neither is rejected. `interactions`' two defense keys are only ever normalized into stored rows when `isDefensive` is truthy — sending them for a non-Defensive move is silently ignored, and unchecking Defensive then saving drops any that were previously stored (see `normalizeInteractions(interactions, isDefensive)` in `server/moveLogic.js`).
- **Move Roll has no dedicated roll-execution event** — it reuses `pool:roll` unchanged. Server-side, `getMovesFor(characterId)` (used by `GET /api/characters/:id` and everywhere a character's move list is sent) resolves each move's `roll_slots` against that character's live `dice` rows: concrete slots (Skull/Brain/Stamina/Body) resolve into `roll_dice: [{dieId, slot_name, current_size, bonus, status}]` same as before; an ambiguous Hand/Leg slot instead contributes to `roll_choice: { right: [...], left: [...] }` — both sides' dice, since nothing commits to Left or Right until the player picks at roll time (a move with no ambiguous slot gets `roll_choice: null`). `effective_roll_modifier = roll_modifier + roll_bonus` (the move's own bonus plus any Perk-granted `move_roll_bonus` for that move) either way. Clicking a move's Roll on the client opens the same roll dialog as any other roll, pre-filled with `effective_roll_modifier`; for an ambiguous Roll the client shows one button per side and, once picked, submits `pool:roll` with `dieIds` set to `roll_dice` plus that side's `roll_choice` entries — `pool:roll`'s existing `status = 'active'` filter is what silently drops any incapacitated die from either collection, no separate logic needed.
- `folder:create` / `folder:rename` / `folder:delete` (client [GM] → server): `{ name, parentFolderId? }` / `{ folderId, name }` / `{ folderId }` — manages compendium `move_folders`, labeled "Discipline" client-side and nested the same way as `character_folders` above: `parentFolderId` nests the new discipline (an unknown id falls back to root), and delete promotes direct moves and direct child disciplines one level up to the deleted discipline's own `parent_id` (root if it was already at root), broadcasting `{ folderId, parentFolderId }` for client navigation. Broadcasts `folder:created` / `folder:updated` / `folder:deleted`.
- `move:set_folder` (client [GM] → server): `{ moveId, folderId }` (`folderId` null = root; an unknown id also falls back to root) — the drag-and-drop reassignment path: touches only `moves.folder_id`, leaving name/tell/style/frames/description/interactions/tags untouched (unlike `move:update`, which replaces the whole move). Broadcasts `move:updated`.
- `move:grant` / `move:revoke` (client [GM] → server): `{ characterId, moveId }` — inserts/deletes a `character_moves` row (the drag-and-drop from the compendium). Grant is refused server-side when the move has a style and the character has no stance containing it (learnability rule). Broadcasts `move:granted` / `move:revoked`
- `roleplay:save_answer` / `roleplay:add_question` / `roleplay:update_entry` / `roleplay:delete_question` (client → server): `{ characterId, question, answer }` (upserts a canonical-question answer) / `{ characterId, question }` (custom, capped at 20 per character) / `{ entryId, question, answer }` (question editable only on custom rows) / `{ entryId }` (custom rows only) — all broadcast `roleplay:updated` `{ characterId, entries }`
- `combat:next_round` (client [GM] → server) — a no-op unless already in `tic_countdown` phase or the fight hasn't started yet (`phase` null), and at least one character is seated. Increments `round_number`, sets `round_start_tic = current_tic`, rolls the Brain die for every seated participant with an active Brain die (logged to `chat_log` as normal initiative rolls, same `logRoll` path as any other roll — an incapacitated/missing Brain die is silently dropped from its side's initiative, same as `pool:roll` drops incapacitated dice elsewhere), resolves per-side initiative (`resolveSideInitiative`, see `server/combatTiming.js`), sets `phase = 'declaration'` and `declaring_side`/`pending_declare_side` (the losing side opens first; a side with nobody seated is skipped, becoming `declaring_side` directly with no `pending_declare_side`). Broadcasts `combat:updated`.
- `move:declare` (client → server): `{ characterId, moveId, placementTic? }` — open access, same trust model as any other roll/declare in this app. A no-op unless: `phase` is `'declaration'`; the character is seated on the side currently named by `declaring_side`; the move is actually available to them (Default, or granted); if the move has a style, the character's **active** stance carries it (same learnability rule Tab 3 already dims by — checked against the active stance specifically, not "any stance" like `move:grant`'s rule); and it's affordable — `current_stamina` minus every other move this character already has pending (not yet committed) this Declaration Phase, minus this move's own `stamina_cost`, must not go below 0 (see Stamina Cost above). Computes the legal minimum Tic (`computePlacementTic` — the round's start Tic, or this character's own last-declared move's `reveal_tic` if later, even from a previous round); `placementTic`, if supplied (the drag-and-drop declare picker's drop Tic — see Combat Timing above), is used as-is when it's at or after that minimum, otherwise it's clamped up to the minimum instead of being rejected — omitting it entirely also just uses the minimum, so older/simpler callers keep working. `reveal_tic` (`computeMoveFootprint`, Startup-only) is computed from the resulting `placement_tic`, and a `declared_moves` row is inserted. Broadcasts the full state via `combat:updated` (Tell-only, like everyone else's view) to all clients, **plus** a direct `declared_move:own` emit (full `moveId`/`moveName`/`staminaCost`, never broadcast) to the declaring socket only, so that client alone can render its own move as revealed (and compute its own pending-Stamina preview) until the real reveal Tic — see the `declared_moves` schema note above for why (no-auth: the server can't otherwise tell whose client this is).
- `combat:side_done_declaring` (client → server): `{ side }` — open access. A no-op unless `phase === 'declaration'` and `side === declaring_side`. First commits Stamina Cost: for every character seated on `side`, sums `stamina_cost` across their still-uncommitted `declared_moves` rows, updates `current_stamina` (clamped `[0, max_stamina]`) if that sum is nonzero, marks those rows `stamina_committed = 1`, and broadcasts `character:updated` for any character actually changed. Then advances `declaring_side` to `pending_declare_side` (clearing `pending_declare_side`) — which is `null` if there wasn't a second side left to open, meaning both sides are now done. Broadcasts `combat:updated`.
- `combat:start_tic_countdown` (client [GM] → server) — a no-op unless `phase === 'declaration'` and `declaring_side` is `null` (both sides done declaring). Sets `phase = 'tic_countdown'`. Broadcasts `combat:updated`.
- `combat:tic_forward` / `combat:tic_backward` (client [GM] → server) — a no-op unless `phase === 'tic_countdown'`. Adjusts `current_tic` by ±1; backward is clamped so it can't go before the current round's `round_start_tic` (moving further back into a previous round's history isn't supported). Reveal state for every `declared_moves` row is recomputed live from the new `current_tic` (`isMoveRevealedTo`, stateless — nothing is cached, so stepping back re-hides a move that hasn't "really" happened yet, per Combat Timing above). Broadcasts `combat:updated`.
- `chat:move_reveal` (server → all clients) — a `kind='move_reveal'` `chat_log` row, posted automatically (no client action) the instant `combat:tic_forward` crosses a declared move's `reveal_tic`; `declared_moves.reveal_posted` makes this idempotent, so oscillating the Tic counter back and forth across the same threshold never re-posts (`combat:tic_backward` never advances `current_tic`, so it can never newly cross one either). Broadcasts `{ kind: 'move_reveal', characterId, characterName, move: { id, name, imageData, imageMimeType, startupTics, activeTics, recoveryTics, description, staminaCost }, timestamp }`; `GET /api/chat` carries the same shape via a `moves` LEFT JOIN (`move: null` if the move was since deleted — no FK on `chat_log.move_id`, same survive-deletion reasoning as `character_id`). Rolling the move (if it has a Roll) is unchanged and posts its own ordinary `roll:result` entry, separately — not merged into this card. **Decided:** the card renders compact by default (portrait, name, `FrameBar`); clicking it toggles an expanded view showing the move's full `description` and Stamina Cost, client-side only (no extra request — the fields already ride the same payload).
- `chat:message` (client → server): `{ characterId, text?, imageData?, imageMimeType? }` — posts a free-text chat entry attributed to `characterId` (chosen in the compose box, same PC-only-for-Players visibility as elsewhere); needs `text` or `imageData` (or both), a no-op otherwise; `text` is trimmed and capped at 2000 characters. **Decided:** an image/GIF is attached by pasting it directly into the compose box (a clipboard `paste` event on the textarea, checked for an image `DataTransferItem`) rather than a file-picker button — same `fileToChatImage` client-side pipeline either way, since a clipboard item's `getAsFile()` returns an ordinary `File`. GIFs arrive as their raw uploaded bytes (no server-side re-encoding — that's a client-side choice, see Chat Log above). Inserts a `kind='message'` row into `chat_log` (`dice_rolled` stored as `'[]'`), broadcasts `chat:message` `{ kind: 'message', characterId, characterName, message, imageData, imageMimeType, timestamp }` to all clients.
- `chat:clear` (client [GM] → server) — truncates `chat_log`, broadcasts `chat:cleared` to all clients. GM-only is enforced client-side only (the server has no concept of role, same as everywhere else in this no-auth app). Also runs automatically on every server boot (a real `DELETE FROM chat_log`, not just an incidental effect of Render's free tier sleeping).
- `GET /api/combat` — the arena's current state: `{ unevenCombatEnabled, phase, roundNumber, currentTic, roundStartTic, roundLength, relativeTic, isOverflow, overflowBy, declaringSide, pendingDeclareSide, participants: [{id, character_id, side, pair_index}], characters: {[characterId]: {character, dice, stances, moves}}, counters, declaredMoves }` (`counters` = standalone ones plus any seated character's counter flagged Show in Combat; `characters[id].moves` = that seated character's available moves via `getMovesFor`, for the Declaration Phase's declare-a-move picker; `declaredMoves` is always the Tell-only redacted view — see `move:declare` above for how the declaring client gets its own real move instead). Fetched once on load; live updates after that come from `combat:updated` (the full state, same shape minus `characters`/`moves`, recomputed fresh on every relevant change — not a delta) plus the character sheet's own broadcasts (`character:updated`/`die:updated`/`stance:activated`), which the Arena page also listens for.
- `combat:add_participant` / `combat:move_participant` (client [GM only] → server): `{ characterId, side, pairIndex }` — both are the same upsert into `combat_participants` (a character can only hold one seat, enforced by `UNIQUE(character_id)`; add vs. move is purely which one the client happens to call). Broadcasts `combat:updated` — `{ unevenCombatEnabled, participants }`, not the resolved character data, which the client already has or fetches once via `GET /api/combat`.
- `combat:remove_participant` (client [GM only] → server): `{ characterId }` — deletes that character's `combat_participants` row. Broadcasts `combat:updated`. Deleting a seated character (`DELETE /api/characters/:id`) does the same cleanup automatically.
- `combat:toggle_uneven` (client [GM only] → server) — flips `combat_state.uneven_combat_enabled`, broadcasts `combat:updated`
- `combat:clear` (client [GM only] → server) — "Clear Arena": clears all `combat_participants` and `declared_moves`, and resets `combat_state`'s round/Tic timing fields (`phase`, `declaring_side`, `pending_declare_side` back to null; `round_number`/`current_tic`/`round_start_tic` back to 0) — a full reset, not just seating. Broadcasts `combat:updated`
- `combat:end` (client [GM only] → server) — "End Combat", the other half of the global header's Start/End Combat toggle (see Combat Timing above). Same round/Tic/`declared_moves` reset as `combat:clear`, but leaves `combat_participants` untouched — the fight ends, the roster stays seated. Broadcasts `combat:updated`
- `perk:create` / `perk:update` / `perk:delete` (client [GM] → server): `{ name, description, imageData?, imageMimeType? }` / `{ perkId, ...same fields }` (image only replaced when provided) / `{ perkId }` — manages `perks` only (delete refused while granted to anyone — same "in use" pattern as Tells), broadcasts `perk:created` / `perk:updated` / `perk:deleted`
- `perk:grant` (client [GM] → server): `{ characterId, perkId }` — inserts into `character_perks`, then calls `PERK_HOOKS[perk.name]?.onGrant?.({ characterId, perkId, characterPerkId })` from `server/perkAutomations.js` if a manual hook exists for that Perk's name (no-op otherwise). Broadcasts `perk:granted` plus whatever the hook itself broadcasts.
- `perk:revoke` (client [GM] → server): `{ characterId, perkId }` — deletes any `character_move_tags` / `character_move_overrides` / `character_move_roll_bonuses` rows tagged with that grant's `character_perk_id` (in case a hook wrote any), then the `character_perks` row, then calls `PERK_HOOKS[perk.name]?.onRevoke?.({ characterId, perkId, characterPerkId })` if present. Broadcasts `perk:revoked` plus whatever the hook itself broadcasts.
- `tag:create` / `tag:update` / `tag:delete` (client [GM] → server): `{ name, description }` / `{ tagId, name, description }` / `{ tagId }` — manages the world-level `tags` list (delete cascades off `move_tags`), broadcasts `tag:created` / `tag:updated` / `tag:deleted`
- `counter:create` (client → server): `{ characterId, name, targetPips, rewardType? }` — inserts into `counters`, broadcasts `counter:created`. `characterId: null` creates a standalone counter (the Arena's "+ New Arena Counter" form is the only GM-only-gated caller of this shape client-side; the server itself doesn't distinguish who's asking, same as everywhere else in this no-auth app). `rewardType` (one of `story`/`statistic`/`perk`/`move`/`combat_prowess`) is only ever stored when `characterId` is set — silently dropped to `NULL` for a standalone counter regardless of what's sent.
- `counter:adjust` (client → server): `{ counterId, delta }` — +/- to `current_pips`, clamped to `[0, target_pips]`, broadcasts `counter:updated`
- `counter:toggle_show_in_combat` (client → server): `{ counterId }` — flips `show_in_combat`, broadcasts `counter:updated`
- `counter:set_reward` (client → server): `{ counterId, rewardType }` — sets (one of the 5 values) or clears (anything else/omitted) a counter's reward tag; no-ops for a standalone counter (`character_id IS NULL`), same restriction as creation. Broadcasts `counter:updated`.
- `counter:delete` (client → server): `{ counterId }` — broadcasts `counter:deleted`

## Pages / views
Every page's header also carries, in order: the "Custom VTT" logo (links to the Combat Arena — see item 5), the GM-only **Compendium** link, an explicit **Characters** link (visible to every role — reaching the character list no longer requires clicking the logo), the **Search bar** (see Global UI — Search above), and the Chat Log toggle — all persistent regardless of which page is open.
1. **Role-select modal** — shown on every fresh load, before anything else: "Player" or "GM". Not persisted.
2. **Character list** (home) — cards for each character, filtered by role (`pc` only for Player, all for GM); a nested, indented folder tree (`FolderTreeNav`, shared with the Compendium's Discipline nav) sits in a sidebar beside the grid — 🏠 All Characters at the root, every folder at every depth selectable, drag a card onto any row to file it there (dropping on root clears it) — but management (create/rename/delete, and the ability to drag at all) is **GM-only**: Players just browse whatever folders exist. Deleting a folder promotes its direct characters and direct child folders one level up to its own parent (root if it was already at root); if the folder being viewed is the one deleted, the view follows it up to that same parent. "+ Add Character" button (name only, plus a PC/NPC toggle and a folder picker — showing the full indented hierarchy — for GM; Players' new PCs always land at root; dice auto-seeded either way); each card has a **Delete** option that asks for confirmation first (it cascades — dice, stances, moves, inventory, injuries all go with it). Cards sit in a responsive grid, each with a fixed-size portrait area that the art fills edge-to-edge (cropped to cover, not letterboxed — no visible empty space around it regardless of the source image's aspect ratio), and a small folder-path chip ("📁 Fighters / Bosses") shows on any card filed in a folder, next to the NPC badge.
3. **Character sheet**, split into 6 tabs:
   - **Tab 1 — Core Stats:**
     - **Name** — simple editable text field, saved live
     - **Portrait** — image area; clicking it opens a file picker to upload/replace the character's picture (same click-to-change flow whether setting it the first time or changing it later)
     - **Lock in Stats** / **Revert Stats to Base** buttons — snapshot or restore all 8 dice against the character's locked baseline (see mechanic above)
     - **Dice pools** — since Phase 8 (Polish, pilot in progress — see below), the 8 dice no longer sit in three flat Head/Core/Legs panels: they're overlaid on a Vitruvian-Man backdrop (`client/src/assets/vitruvian-man.png`, low-opacity/inverted for the dark theme) as three horizontal rows that mirror the original Head(2)/Core(4)/Legs(2) pool grouping rather than tracing the artwork point-for-point (`ANATOMY` map in `CoreStatsTab.jsx`, keyed by `slot_name`) — Skull+Brain a symmetric pair straddling the vertical midline; Left Hand, Stamina, Body, Right Hand sharing one row at the hands' height (Stamina/Body visually grouped with the hands, same as the pre-Vitruvian layout); Left Leg+Right Leg a symmetric pair at the spread stance. Full-size dice (not shrunk), each carrying its own icon (skull/brain/fist/lightning bolt/heart-pulse/footprints) rendered *inside* the die itself — low-opacity, behind the die-size number — rather than as a separate overlay. Each die shown sized/styled by its die type (or greyed-out/scratched-out if incapacitated), tinted green/red (opacity scaling with the gap) when current differs from locked, with a green up-arrow and red down-arrow beside it to step size (a quick GSAP flash-pop plays on step); clicking the die itself opens a roll dialog asking for an ad-hoc modifier. One **Pool Roll** button for the whole sheet enters selection mode — tap any set of dice (regardless of where they sit on the figure), then roll them together with one shared modifier
     - **Maximum Stamina** / **Current Stamina** — Max is computed from the locked Stamina die and the character's stamina multiplier; Current is tracked live and regenerates via a per-turn roll
     - **Inventory** — list of items, each with a name and an optional description (add/edit/remove; editing via a per-row pencil toggle)
     - **Injuries** — same widget/behavior as Inventory: name + optional effect (add/edit/remove)
     - Both lists render stacked: bold name on top, description/effect under it in smaller grey text — and no second line at all when it's empty, so description-less entries stay compact
   - **Tab 2 — Stances:** list of the character's own stances (left-click to set active, highlighted when active; edit/delete per stance, minus the last-stance/active-stance rules above); **Stance Creator** to build a new one (name + pick exactly 2 of the 7 styles, icon-buttons); the counter chart (SVG tournament graph, highlighted for the active stance) with Best/Worst Matchups lists; active stance badge on the sheet header
   - **Tab 3 — Moves:** read-only list of the character's available moves (all Default moves + any Unique moves granted by the GM), rendered as full move cards per the decided structure (Tell header — both Tells side by side for a move with an ambiguous Roll, see Moves & Tells above —, move art + name + Stamina Cost badge + frame-data squares, discipline label (always shown — the discipline name if filed, "Without Discipline" if not), style/tag chips, Roll row, description, interactions with automation chips); shows this character's **effective** frame data and tags — base template plus any Perk-granted `character_move_overrides`/`character_move_tags` — with a ⭐ indicator when they differ from the shared template, plus any Perk `move_roll_bonus` (live if the move has a Roll, otherwise marked "not yet active"); a move with a Roll shows its live current dice as a clickable button (two buttons, one per side, for an ambiguous Roll) that opens the roll dialog, pre-filled and editable; Default/Unique badges; moves whose style isn't in the active stance render dimmed (unusable); GM can revoke a Unique move from here
   - **Tab 4 — Perks:** read-only grid (infinite rows, 2 columns) of granted Perks — picture, name, description per card (no automation data — see Perks & Tags above)
   - **Tab 5 — Counters:** the character's own counters, name on its own line (plus its reward tag, if any — see Counters above) then a full-width row — a minus button on the left, dot pips filled up to the current count out of target across the middle, a plus button on the right (both clamped to `[0, target]`) — each with a "Show in Combat" toggle; anyone controlling the character can create a new one here (name + target pips 2-20 + optional reward)
   - **Tab 6 — Role-play:** persistent free-text fields, each under a question the player asks themselves about the character. Six canonical questions (what they love and can't pass by on the street; biggest traumatic event/memory; irrational fear; favorite food; what another person can do to infuriate them; biggest vice) with ~2-3-line answer boxes, kept compact so it all fits with little scrolling, plus the ability to add custom questions with answers — up to 20 additional per character (question editable, deletable). Same open-access editing as the rest of the sheet.
4. **Compendium** (GM-only) — a single page holding every compendium as an internal tab, rather than a separate top-level nav entry per type (decided — this is the pattern for any compendium added later too):
   - **Moves tab** — persistent library of every move; the Tell manager (name + uploaded image, placeholders replaceable, in-use Tells undeletable — "in use" now also covers a move's right/left ambiguous-Roll Tells, not just its base Tell); the Tag manager (world-level list, name + optional description shown as a tooltip everywhere the tag appears); disciplines (the folder mechanism, labeled "Discipline" in this UI, **nested** — the same `FolderTreeNav` sidebar as the character list: create/rename/delete at any depth, delete promotes direct moves and direct child disciplines one level up to the deleted one's own parent), reorganized either via the Move Creator's discipline field (a select showing the full indented hierarchy) or by **dragging a move card onto a discipline row** (or onto "All Moves"/root to clear it), with "All Moves" showing every move regardless of discipline and the style filter narrowing whichever of "All Moves" or a specific discipline is showing; Move Creator form (art upload, name, Default toggle, **Defensive toggle** — reveals two extra interaction sections at the bottom, On Successful Defense / On Failed Defense, once checked — either one Tell picker or — when the Roll includes a Left/Right Hand or Left/Right Leg slot — a Right Tell + Left Tell pair, required Style picker, optional Roll picker directly below Style — toggle any of 6 slots (Skull, Brain, Left/Right Hand, Stamina, Body, Left/Right Leg) plus a flat bonus, empty = no Roll —, Tag picker 0-10, discipline assignment, frame-data inputs with live colored preview, a required **Stamina Cost** field (0 is a valid free cost; negative restores Stamina instead of spending it — see Combat Timing above), description, On Hit/Block/Miss text + automation builders, always present); drag a move onto a character in the page's character rail to grant it (per-move Grant checklist as touch fallback, with unlearnable characters disabled). Every move card shows its full discipline path and, when applicable, a small "Defensive" badge.
   - **Perks tab** — persistent library of every Perk; Perk Creator (picture upload, name, description — no automation builder, see Perks & Tags above); drag a Perk onto a character in the page's character rail to grant it (per-Perk Grant checklist as touch fallback); delete blocked while granted to anyone
5. **Combat Arena** — shared page, no map/tokens; reachable by clicking the header logo, visible to every role. A GM-only roster rail (not-yet-seated characters, role-filtered) to drag from, grouped by character folder recursively — see Combat Arena above for the full collapsible/counted/Folderless-last behavior; two side-by-side columns (Left/Right) of pair rows with a divider between pairs, a fresh empty row always available to start a new one. Seated cards **fill their side's full width with no unoccupied space** — a single occupant's card spans the whole side, and under Uneven Combat, adding more to the same side scales every card on it down evenly so the row always stays fully occupied (a per-card minimum width plus horizontal scroll is the fallback if a side gets too crowded to stay legible), rendered horizontally with a full-height portrait on the left (see Combat Arena above). Each seated character renders as a **read-only** card — portrait, active stance name, dice pools (grouped into the same 3 Head/Core/Legs rows as the character sheet's Tab 1, in that order, rather than one flat mixed row), Current/Max Stamina — showing a live red/green **preview** instead of the real value while this client itself has a declared-but-not-yet-committed move pending (see Stamina Cost above; red if the preview is lower, green if higher, plain otherwise) — click the card to jump to the full sheet to actually roll/step, values here stay live via the same broadcasts the sheet itself uses; NPCs here are visible to Players as an explicit exception; a small ✕ (GM-only) removes one participant, a page-level **Clear Arena** button (GM-only) empties it entirely, including every declared move and the round/Tic state; a **Start Combat** button (GM-only, shown only while `phase` is null) rolls initiative and opens the first Declaration Phase — see Combat Timing above for how it and **End Combat** relate to Clear Arena. "Uneven Combat" toggle (GM-only; a read-only badge for Players when on) allows uneven pair sizes (dropping a character onto an occupied pair zone adds them rather than replacing). A **Counters** section lists every counter flagged "Show in Combat" for a currently-seated character (labeled `"{CharacterName} - {CounterName}"`, its reward tag if it has one shown read-only) plus standalone counters (labeled by name alone, never a reward tag); a small form creates a new standalone one (GM-only), but adjusting/deleting any counter shown here is open to everyone, matching the character sheet's own Counters tab.

   **Global Tic Counter header (decided):** while `phase` is non-null, a status bar appears at the top of *every* page (mounted once in `App.jsx`'s `Shell`, not inside the Arena route — see Combat Timing above), showing the round number and phase — in Declaration, which side is currently declaring (or that both are done) plus an open-access **Done Declaring** button for that side, and (GM-only, once both sides are done) a **Start Tic Countdown** button; in Tic Countdown, GM-only ◀/▶ step controls — and a **Next Round** button (GM-only) whenever not mid-Declaration, plus a GM-only **End Combat** button always available. Below that row, a horizontally-scrollable strip of **Tic squares** (the current round's Tics plus a lookahead buffer, so a player can drop a move further out than the current round without waiting for it to arrive) is the drag-and-drop **declare** target — see Combat Timing above for the drag/footprint-preview/snap-forward behavior.

   **Back in the Arena page itself:** during Declaration, a panel lists each seated character on the currently-open side, each with a **Default**/**Unique**-tabbed picker of draggable move cards (styled moves dimmed/excluded the same way Tab 3 already does, matching the active stance; each card shows its Stamina Cost) — dragging one onto the global header's Tic strip is how it's declared (see above). Separately, every seated character with at least one declared move (any round — an overflowing move still pending from a previous round stays visible) gets a row of small **flip cards**, one per declared move: the secret face shows only its Tell (or both Tells side by side, for an ambiguous Left/Right Roll), greyed out — deliberately **no timing/length information at all**, since a move can be declared to land at any open Tic and showing its position would leak exactly that; the moment it's either this client's own declare or actually revealed, it flips (a Framer Motion rotate+cross-fade) to the same full `MoveCard` Tab 3/Compendium already use. A move's reveal also posts a card to the Chat Log automatically (see Chat Log below) — no separate control needed here for that.
6. **Chat Log** — shared, live feed of rolls, revealed-move cards, and free-text messages, updates instantly on every connected device; each entry shows the poster's avatar beside their name, and (for rolls) the modifier folded into each die's formula rather than a separate tag; a compose box at the bottom lets anyone post free text and/or an attached image/GIF (character picker to attribute it, PC-only for Players), an empty send does nothing; a **Clear Chat** button (GM-only) empties it for everyone, and it also clears automatically on every server restart. A **revealed-move card** posts itself automatically (no button, no manual step) the instant a declared move's Tic Countdown reveal happens — compact, not the full move card: a small portrait, the move's name, and its Startup/Active/Recovery `FrameBar` strip; a move later deleted from the Compendium shows "(move deleted)" instead, same "(deleted)" spirit as a removed character. Rolling that move (if it has one) is completely separate — the same Roll button/dialog as anywhere else, landing as its own ordinary roll entry rather than folding into the reveal card.

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

**Phase 4 — Perks & Tags (Tab 4)** — done
- `tags` + `move_tags` (landed in Phase 3) + `perks` + `character_perks` + `character_move_tags` + `character_move_overrides` + `character_move_roll_bonuses`
- GM Perks Compendium, Perk Creator (picture/name/description); grant/revoke is pure `character_perks` membership — the original generic automation registry (`perk_automations`/`character_perk_automations`, 5 automation types applied/reversed automatically) was built here, then removed post-Phase-6 in favor of manual, case-by-case `PERK_HOOKS` entries in `server/perkAutomations.js` (see Perks & Tags above)
- Tab 4 read-only grid; Tab 3 (Moves) still reads `character_move_overrides`/`character_move_tags`/`character_move_roll_bonuses` to show a character's effective (Perk-adjusted) frame data and tags, whenever a manual hook has written rows there
- Checkpoint: grant/revoke a Perk, confirm plain membership works and a manual `PERK_HOOKS` entry's effect (once one exists) applies/reverses cleanly — still pending real Perk content and a multi-device playtest; automated coverage (unit + integration + browser) is in place

**Phase 5 — Counters (Tab 5)** — done
- `counters` table (character_id nullable — the standalone-counter creation path arrived in Phase 6), character-owned CRUD + Show in Combat toggle
- Tab 5: create form (name + target pips 2-20); each counter is name on top, then one full-width row (minus, dot pips filled up to current, plus — both buttons clamped to `[0, target]`), Show in Combat toggle, delete
- Checkpoint: create/adjust a counter live across devices — automated coverage in place, pending a real multi-device playtest

**Phase 6 — Combat Arena (structure only, no timing yet)** — done
- `combat_state` (Uneven Combat toggle only for now) + `combat_participants`
- Drag-in/out via a GM-only roster rail, pairing UI (drag onto a pair row's side, divider between pairs, dropping onto an occupied side adds rather than replaces), Uneven Combat toggle, ✕ remove + Clear Arena
- Read-only simplified participant cards (portrait, active stance, dice, stamina), live via existing character/die broadcasts — no roll/step controls on the card itself, click through to the sheet instead
- Standalone counters (GM-only creation) + Show-in-Combat counters (seated characters only) displayed and adjustable here
- Checkpoint: GM sets up a fight, Players see simplified NPC stats live — automated coverage (unit + integration + browser) in place, pending a real multi-device playtest

**Phase 7 — Combat Timing (the hard part — isolate before integrating)** — done
- ~~Build and unit-test the placement/reveal/overflow math on its own first~~ — done: `server/combatTiming.js` + `server/test/combatTiming.test.js`, a bare pure-function module with no UI/socket/DB wiring yet (see Combat Timing mechanic above for the exact functions and the Startup-only placement decision)
- ~~Then: `declared_moves`, per-side Brain initiative, Declaration Phase sequencing, Tic Countdown with GM forward/back, live reveal-vs-Tell filtering, Next Round flow, wired into the Arena~~ — done: schema + `combat:next_round`/`move:declare`/`combat:side_done_declaring`/`combat:start_tic_countdown`/`combat:tic_forward`/`combat:tic_backward` + the Arena's status bar/declare picker/Tell-vs-revealed badges (see Combat Timing and Combat Arena above)
- ~~Extend Chat Log with move-reveal-plus-roll cards~~ — done: a compact card (portrait, name, `FrameBar`) posts itself automatically to the Chat Log the instant a declared move reveals (`chat:move_reveal`, idempotent via `declared_moves.reveal_posted`); rolling the move is unchanged (same Roll button/dialog as everywhere else) and lands as its own separate ordinary roll entry, not merged into the card — see Chat Log above
- Checkpoint: run one full mock round end-to-end, including an overflow case — done server-side (`scripts/e2e.mjs`'s Phase 7 section: Next Round → Declaration → side-lock → Tic Countdown → reveal (incl. its chat card, exactly once even after oscillating the Tic back and forth) → re-hide on backward → Next Round with overflow carrying → explicit-`placementTic` declares (honored and clamp-forward) → `combat:end` (roster stays seated) → Clear Arena) and visually in the Arena/Chat UI (Playwright); still pending a real multi-device playtest
- ~~Combat redesign: global Tic Counter header, Start/End Combat, drag-and-drop declare~~ — done after playtest feedback: round length bumped 5→7 Tics; the round/phase status bar, Done Declaring, Next Round, and Tic ◀/▶ moved out of the Arena page into a global header shown on every page while `phase` is non-null (`CombatHeaderBar.jsx`, mounted in `App.jsx`'s `Shell`); a Start/End Combat toggle wraps the round loop without changing it (`combat:end` is new, `combat:clear`/"Clear Arena" unchanged); the dropdown-based declare picker was replaced with drag-and-drop (Default/Unique-tabbed move cards dragged onto the header's Tic strip, live footprint preview, `move:declare`'s new optional `placementTic` honored-or-clamped-forward) — see Combat Timing and Combat Arena above for the full mechanic and event-contract changes. Alongside this: a DB perf pass (parallelized/batched several combat handlers that were doing sequential per-participant round trips — `move:declare`, `combat:side_done_declaring` — plus a few redundant re-fetch-after-write patterns elsewhere) and the move-reveal chat card now expands on click to show the full description (see Chat Log above).

**Phase 8 — Polish** — in progress
- Tailwind styling, Framer Motion transitions, GSAP effects, fighting-game theme across every tab/page — **in progress, piloted on the character sheet first** (per the plan's own recommendation to nail the direction on one representative area before rolling it out everywhere, since this is the most likely piece to get reworked). Framer Motion + GSAP are now real dependencies (installed, not yet used anywhere before this). Shipped so far: the sheet's tab bar (sliding underline, animated tab-content transitions) and Tab 1 — Core Stats' Vitruvian-Man dice layout (see Tab 1 above), plus supporting die-widget/portrait/stamina motion touches. Awaiting a reaction on this direction before extending the same language to Tabs 2-6.
- ~~Clear Chat button + auto-clear on server boot~~ — done ahead of schedule, alongside free-text chat messages and image/GIF posting (see Chat Log above)
- Final full-system playtest across multiple devices

## Implementation Risks & Recommendations
A scope check for whoever picks this up: this grew well past "semi-simple website" over the course of design. Most of it (dice, inventory, injuries, stances, perks, counters) is standard CRUD-plus-broadcast work. Combat Timing (Tics/Startup/reveal/overflow) is the one genuinely hard piece — real software complexity, not just more forms — and it's also the most original part of the system, which is exactly why it deserves the most care rather than being rushed alongside everything else.

**Recommended approach:**
- Build and playtest Combat Timing in isolation first, with a bare-bones/unstyled harness, before wiring it into the full Arena UI. It's the highest-risk piece and the most likely to need a tweak once it's actually moving (round length was in fact revisited after playtesting — 5 Tics wasn't enough granularity, bumped to 7; does per-side initiative feel right with 3 vs 1?).
- **Write automated tests for the placement/reveal/overflow math specifically** — `placement_tic`, `reveal_tic`, the carryover rule, and Tell-vs-revealed visibility per client. This logic is pure and easy to test in isolation, and a bug here is the kind that's maximally disruptive mid-session and hard to spot just by looking at the UI.
- Populate real content early — actual Moves, Perks, and the final 7 Stance attributes — before polishing the Compendium UIs around them. Placeholder/TBD fields hide schema gaps that only surface once real content exists.
- Push the visual/GSAP polish pass to last. It's the most fun to build but also the most likely to get reworked if a mechanic changes shape during playtesting.

**Known risks to watch:**
- **No-login Tell secrecy gap** (see Open Items below) — a real, accepted trade-off, not a bug, but worth testing deliberately (refresh mid-round and confirm the behavior matches expectations) rather than discovering it live.
- **Render cold starts** could hit right as a session is starting. Worth explicitly testing Socket.io reconnection behavior after an idle spin-down, not just assuming it reconnects cleanly.
- **Interconnected live-sync systems** (a Perk hook touching a die, which touches tinting, which touches Lock/Revert, etc.) tend to fail as "this number doesn't match what I expected" rather than a clean crash — harder to track down without a testing habit already in place, which is the main reason testing is called out here rather than left implicit. This bit once already, in the original Phase 4 automation registry (since removed): a current-only die step and Revert Stats to Base both changed the same die's current value through different paths, so grant → Revert → revoke (in that order) could land the die somewhere other than its pre-grant baseline. Worth remembering when writing a future `PERK_HOOKS` entry that steps a die "current only" — track the delta you actually applied if the hook needs to cleanly reverse it later, rather than assuming the die's value at revoke time is still what grant time left it at.

## Open items to decide later (not blocking MVP)
- Exact combat/roll resolution rules (what a roll "means" mechanically) — not needed for the roll/step mechanism itself
- Visual theme specifics (colors, fonts, character art) — covered in the polish milestone
- How an active stance's attributes actually modify outcomes — the ±2 counter scoring is decided and displayed; full resolution depends on Moves/Combat Timing, still not fully described
- Per-style mechanical benefits (styles granting bonuses beyond counter matchups) — planned for later, structure TBD; attribute rows kept extensible for it
- How Current Stamina is spent/reduced during play — confirmed no automation for now; `stamina:adjust` remains the manual control, actual spending happens narratively at the table
- Full list of Default Moves (Block, Jab, Dodge, + others not yet named) — the Creator is live, content still needs to be written (in-app or provided)
- Real Tells (names + commissioned images) to replace the two seeded placeholders — GM task, tooling is live
- When/how On Hit / On Block / On Miss automations actually fire during combat (GM adjudicates hit/block/miss; presumably a GM control per resolved move) — Phase 7 design
- Perks are explicitly MVP-scope on the mechanics side; real Perk content (and whatever `PERK_HOOKS` entries it needs — see Perks & Tags above) still needs writing, one at a time, case by case
- A `character_move_roll_bonuses` row (however it gets written — currently only a manual `PERK_HOOKS` hook, previously the removed generic registry) is live for any Move that has a Roll configured (folds into that Roll's pre-filled modifier); for a Move with no Roll it's still stored/displayed but has no live effect yet, since that case needs Phase 7's declared-move reveal-and-roll to actually apply it. Also unresolved from Phase 3: exactly when/how On Hit/Block/Miss automations fire during combat — both are Phase 7 design work.
- Interrupt resolution (e.g. a fast Jab potentially interrupting a slower move) is tracked via Tic order but not auto-adjudicated — a GM/table call for now
- **Known no-login limitation:** since there's no session-to-character binding, if the client controlling a character reloads mid-round before their declared move's reveal Tic, the server has no way to know it's "their" client and re-show them their own hidden move (everyone, including them, would only see the Tell until it naturally reveals). This is an accepted trade-off of the shared-link, no-auth design rather than something to solve with real accounts.
