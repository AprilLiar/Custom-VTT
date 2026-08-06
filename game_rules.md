# Dogfight — Rules

> **This file is the rule book players read in-app.** The Rules button in the
> app header renders it, split into sections by its `##` headings, with its own
> full-text search. Edit this file to edit the rules; nothing else needs
> touching, and a deploy picks the change up.
>
> Keep `##` headings as the section boundaries — they are what the Rules page
> builds its section list from. Anything under a `##` belongs to that section,
> including `###` sub-headings.
>
> This is deliberately a Markdown file in the repository rather than rows in
> the database: the rules are authored, versioned, and reviewed like the rest
> of the project, they are the same for every table, and nobody needs to edit
> them from inside a session. See "Where the rules live" in `vttprojectplan.md`
> for the reasoning in full.

## Stats

Every character has eight Stats, each a die: **Skull**, **Brain**, **Left
Hand**, **Right Hand**, **Stamina**, **Body**, **Left Leg**, **Right Leg**.

A die runs d4 → d6 → d8 → d10 → d12. Stepping up past d12 keeps the size at d12
and adds a permanent **+1 bonus** instead (d12+1, d12+2, …), which is added to
every future roll of that die. Stepping down takes the bonus off first, then
the size; only once a die is at d4 with no bonus does the next step down
**incapacitate** it. An incapacitated die is silently dropped from any roll
that would have included it.

**Half-Damage** is a marker on a die, not a step of its own: taking half a step
sets the marker, and taking another half clears it and steps the die down for
real.

**Locking in Stats** records the character's current dice as their *base*
values. Reverting restores them. Injuries apply a structured penalty to the
locked base rather than to the live value.

## Stances and Styles

There are seven Styles: **Speed**, **Power**, **Improvisation**, **Technique**,
**Keep-out**, **Defensive**, **Close-Quarters**. They form a complete
tournament — every Style beats exactly three others and loses to exactly three.

A **Stance** is a named pair of two Styles. A character may have many stances
but exactly one is **active** at a time, and everyone can see which — switching
is public, Pokémon-style. There is no "no stance": the first stance created
auto-activates, the last one cannot be deleted.

### Stance matchup bonus

While a fight is underway, your active stance is scored against your
opponent's. Each of the four cross-pairs where your Style beats theirs is
**+1**; each where theirs beats yours is **−1**; a shared Style contributes 0.
The result is a flat bonus applied to **all** of your rolls, including the
round's initiative roll.

At most three of the four cross-pairs can be wins, so the best possible
matchup is **+3 for you and −3 for them** — a six-point swing. It tilts a
fight; it does not decide one.

**Uneven Combat turns this off entirely, for everyone in the arena.** With more
than two fighters there is no single opposing stance to score against.

## Moves

A Move has frame data — **Startup**, **Active**, and **Recovery** Tics — plus
an optional **Roll**, an **Attack Target**, a **Stamina Cost**, a **Tell**, and
up to ten Tags.

**Default** moves are available to everyone and never carry a Style. A
**Unique** move carries one Style, and can only be learned by a character with
a stance containing it, or used while that stance is active.

### Rolls

A Move's Roll picks from six slots: Skull, Brain, Stamina, Body, and the two
*ambiguous* appendage choices **Hand** and **Leg**. An ambiguous slot resolves
to a real die only when the move is used — the player picks a side.

Taking an appendage slot **twice** means *both* sides at once (a Straight Block
guards with both hands). Two is the ceiling. Taking a slot twice answers its
Left/Right question, so such a move needs only one Tell.

A Move with an ambiguous slot taken once needs **two Tells**, a Right and a
Left, and shows both until it is actually used.

**Custom Roll** replaces the Stat slots with one flat die (d4–d12) belonging to
the item rather than the wielder — for weapons.

### Attack Target

Every Move with a Roll also lists which Stats its damage may land on. An empty
Attack Target is meaningful, not an oversight:

- On a **Defensive** move it means the move is *defence-pure* — it exists to be
  selected as a defender and never attacks on its own account.
- On any other move the attack is still real, and a **Successful Block** is
  what gives it a target (see Blocking).

## Combat Timing

Combat runs on **Tics**. A round is seven Tics long. The Tic counter never
resets — a round's Tics are just a window onto an absolute timeline, which is
what lets a move overflow from one round into the next.

Each **pair** of fighters runs its own independent clock. Fight A can be on
round 5 while fight B is still on round 3; no fight ever waits on another.

A round has exactly two phases:

1. **Declaration** — a human phase. Each side places its moves on the Tic
   Counter, in an order decided by initiative.
2. **Resolution** — automatic. The moment both sides finish declaring, the
   round resolves itself Tic by Tic and plays back as a cutscene.

### Placing a move

A move is placed at a Tic. It **reveals** after its Startup elapses, is
**Active** for its Active frames, and then **Recovers**. Until a move reveals,
opponents see only its **Tell**, not what it is.

A character's next move can never be placed before their previous move's full
footprint ends — including across a round boundary. A move whose footprint runs
past the round's last Tic simply carries into the next round, and the strip
marks that with a **+N** while you are placing it.

### Initiative

At the start of each round both sides roll **Brain**. The loser declares first.
The roll takes the character's Reasons to Fight, their Stance matchup, and a
**−1 per Tic of overflow** they are still carrying into this round.

Ties break on: current Brain, then locked Brain, then whether the active stance
contains Speed, then random.

## Resolution

Every Tic, in order: reveal any move whose reveal Tic has arrived → roll it if
it has a Roll → pick the target → select the defending move by frame overlap →
resolve Block, Dodge, or a plain Hit → check for an Interruption → apply
Idle-Tic Stamina Regen.

Nobody steps a Tic by hand. Every roll is made by the engine.

### Damage

A roll's damage is **one Half-Damage step per full 5 rolled** — 12 is two
steps, 9 is one, 4 is none.

A roll under 5 is **Insignificant Damage**: the attack landed and did too
little to matter. It is *not* a Miss.

**A Miss is an attack evaded with a Dodge.** Nothing else is a Miss.

Damage lands on the first Stat in the move's Attack Target order that still has
a working die. That order is fixed: Skull, Brain, Left Hand, Stamina, Body,
Right Hand, Left Leg, Right Leg.

### Defense Frames

A Move can tag any of its own frames — Startup, Active, or Recovery — as a
**Defense Frame**. That is an annotation on top of the frame's own phase, not a
fourth phase: it never changes the move's length.

**What matters is where those frames land, not where the move is placed.** A
Block placed on the same Tic as an attack does nothing if its Defense Frames
sit on its Startup square, because that square is a Tic *earlier* than the
attack's Active window. The Arena says so when it happens.

### Blocking

Blocks are fully automatic — pure dice, no prompts, ever.

- The defender's Defense Frames must overlap the attacker's Active window.
- **Full coverage**: the Block is rolled against the attack. The net result
  decides Full (no damage) or Partial (reduced damage).
- **Too early** (the guard is already down when the attack becomes Active):
  automatic failure.
- **Too late** (the guard comes up but runs out before the attack does): the
  Block resolves, and the blocker's **Recovery is extended** to cover the rest
  of the attack. That is announced, and drawn on the timeline in the Block's
  own colour. If the extension collides with a move the blocker already
  declared, they choose: **Forfeit** it (full Stamina refund) or **Postpone**
  it past the extension.

A Successful Block replaces the attack's Attack Target with the blocker's own
rolled Stat — which is how an attack with no Attack Target of its own ever
lands at all.

A Block must roll a Stat. A Custom Roll move can never serve as a Block, since
it has no named Stat to become a replacement target.

### Dodging

Dodge is the one call left to a human. It is stricter than Block: anything less
than **full coverage** fails automatically, with no prompt — a partly-covered
dodge is already mechanically doomed.

Full coverage pauses the fight and asks the **GM**: did it land? Every other
pair keeps resolving while that one waits.

A **Full** Dodge is a Miss. A **Partial** Dodge still lets damage through.

### Interruption

Taking a hit while still inside your own move's **Startup** can disrupt it.
The engine walks the attacker's Active window for the first Tic at which the
target is still in Startup, and the interrupted character rolls their own
Startup move's Roll (or **Body**, if it has none) at **+1 per elapsed Active
Tic**. Failing means the move is cancelled and half its Stamina Cost refunded.

## Stamina

Stamina is a die like any other Stat, but also a pool: `current / max`.

- Declaring a move commits its **Stamina Cost**. Taking the move back before
  committing refunds it in full.
- **Idle Tics** — Tics in which you have nothing happening — regenerate
  Stamina.
- At the start of every round after the first, every seated character rolls
  their Stamina die and adds it to the pool.
- **Start Combat** restores everyone to full.

## Reasons to Fight

Each seated fighter carries a 0–3 counter. Each point is **+1 to all of that
character's rolls** while the fight is underway — including initiative. It
lives on the seat, not the character, so it resets when they are re-seated for
a new fight.

## Counters

A Counter is a simple clock: a name, a target number of pips, and how many are
filled. Characters own their own; the Arena can also hold standalone ones for
the GM to track something about the fight itself.

Counters can be adjusted from a character's own sheet, from the Arena, or
directly from the `+` on any roll card in the chat log.

A character's counter can carry a **reward** tag (Story, Statistic, Perk, Move,
Combat Prowess) — purely a tracking label, with no mechanical effect.

## Uneven Combat

A toggle for fights that are not one-on-one. It changes two things:

- Participant cards scale so more than one fighter fits a side.
- **The Stance matchup bonus is switched off for everyone.**

The app does not otherwise enforce the toggle — it is a GM-facing flag, not a
rule engine.
