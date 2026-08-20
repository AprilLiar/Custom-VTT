# Dogfight — Martial Arts TTRPG

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

## What This Game Is

Dogfight is a martial-arts roleplaying game about **one fight at a time**.

Two fighters face each other. Both commit to what they are about to do before
either can see the other's answer, and then those commitments play out against
each other frame by frame. A punch is not "I attack, you defend" — it is a
thing with a wind-up, a moment where it can hurt someone, and a recovery you
are stuck in whether it worked or not. Most of the skill in this game is
choosing *when*, not *what*.

Everything else — your dice, your stances, what you carry, who you are —
exists to make that exchange mean something.

**The app plays the fight for you.** Once both sides have committed, the round
resolves itself: dice roll, defences resolve, damage lands. You are not asked
to arbitrate anything, because you were meant to be watching the fight, not
adding up numbers during it. The two exceptions are named in **Dodging** and
**Blocking** below, and they exist because a human genuinely has to decide.

### What you need

One Game Master, one or more players, and the shared link. There are no
accounts: whoever opens the link picks who they are. That is a deliberate
trade — this is a game for a table that trusts each other.

## Character Creation

Every character has eight **Stats**, each of them a die:

- **Skull** — taking a hit to the head, and giving one.
- **Brain** — reading a fight; also your initiative.
- **Left Hand** and **Right Hand** — everything you do with your arms.
- **Stamina** — how long you last, and what you can afford.
- **Body** — your trunk, absorbing and delivering.
- **Left Leg** and **Right Leg** — footwork and kicks.

### The guided flow

There is a **Character Creation** button at the top of every character sheet. It
walks the whole build in six steps and applies all of it at the end — you can
also do any of it by hand on the tabs, before or after.

**Every step is a suggestion.** Each one has a **Skip** next to **Next**, and
**Finish** is live from the first screen. Nothing here forces you to spend
everything, pick a set number of anything, or fill in a step you would rather
come back to.

**1 — How much fighting have they already done?** This is the only step that
sets any numbers, and even it can be skipped for a free-form build.

| | Stat points | Perks |
|---|---|---|
| **Teenager** | 8 | 3 |
| **Adult** | 16 | 5 |
| **Old Master** | 24 | 7 |

**2 — Stats.** Every Stat starts at **d4**, and one point raises one Stat one
step: d4 → d6 → d8 → d10 → d12, and past that each point is another **+1**.
Spend them however you like. Eight steps spread evenly makes every Stat a d6 — a
fighter with no holes and no edge. Four steps into one Stat takes it to d12 and
leaves the rest at d4 — a specialist who is terrifying in exactly one way.

The number your preset suggests is guidance. Going over it is allowed; the app
says so in the log, and the table decides whether that is fine. There is no
wrong spread — only fights you are built for and fights you are not.

**3 — Stance.** Two different Styles (see Stances and Styles). Whatever you
build here becomes your active stance. Skipping it is fine, but note that a Move
carrying a Style can only be learned by someone whose stance has that Style — so
a skipped stance means the styled Moves in the next step will not stick.

**4 — Moves.** Take whatever you want; there is no limit on Moves. Anything your
stance cannot support is flagged before you pick it, and named in the log if it
does not stick.

**5 — Perks.** Your preset suggests a number. Take fewer, take more.

**6 — Role-play.** Optional, and the tab is always there. One question — *what
is something they would fight for, no matter what?* — is the one with a mechanic
attached: see Reasons to Fight.

Finishing sets the Stats, takes the stance, grants the Moves and Perks, saves any
answers, and **locks the Stats in** — which records your starting dice as your
*base*, so damage and injuries have something to be measured against. Your
**Maximum Stamina** is four times your locked Stamina die's value, and your
current Stamina starts there.

Running the flow again re-states the same spread rather than stacking on top of
it, so it is safe to reopen and adjust.

## Stats and Dice

A Stat's die runs **d4 → d6 → d8 → d10 → d12**. Rolling a Stat means rolling
that die.

Stepping **up** past d12 keeps the size at d12 and adds a permanent **+1**
instead (d12+1, d12+2, …), added to every future roll of that die.

Stepping **down** takes the bonus off first, then the size. Only once a die is
at d4 with no bonus does the next step down **incapacitate** it. An
incapacitated die is silently dropped from any roll that would have included
it — you do not roll it, and you do not roll something else in its place.

**Half-Damage** is a marker on a die, not a step of its own. Taking half a
step sets the marker; taking another half clears it and steps the die down for
real. Two halves make a whole, and nothing else does.

### Locking and reverting

**Locking in Stats** records your current dice as your *base* values.
**Reverting** restores you to them — including clearing any **Half-Damage**
marker, since a base value is a whole one and half a step is damage you have
already taken. Between fights, reverting is how you heal, and it heals all of
it.

**Injuries** apply a structured penalty to the locked base rather than to your
live dice, so a lasting injury survives a revert. That is the point of them.

## Stances and Styles

There are seven **Styles**:

**Speed**, **Power**, **Improvisation**, **Technique**, **Keep-out**,
**Defensive**, **Close-Quarters**.

They form a complete tournament: every Style beats exactly three others and
loses to exactly three. There is no best Style, only a better answer to the
Style in front of you.

A **Stance** is a named pair of two Styles — a way of fighting, not a mood. A
character may know many stances but exactly **one is active** at a time, and
everyone can see which. Switching is public and immediate; you do not get to
hide what you are doing. There is no "no stance": your first stance activates
itself, and your last one cannot be deleted.

### The Stance matchup

While a fight is underway, your active stance is scored against your
opponent's. Compare all four cross-pairs of Styles:

- each pair where **your Style beats theirs**: **+1**
- each pair where **theirs beats yours**: **−1**
- a Style you both share: **0**

The result is a flat bonus applied to your rolls that fight, much like Reasons
to Fight.

**Two Stats are outside it: Brain and Stamina.** The matchup scores what two
fighting styles do to each other, and neither of those Stats is part of that
exchange — Brain is reading a fight, Stamina is your engine, and neither cares
what stance anybody took. A roll made of nothing but those two gets no matchup
at all, and that includes the round's **initiative** roll, which is a pure Brain
roll.

A roll that touches anything else still gets it in full. A move that rolls Skull
*and* Brain is still a punch — adding Brain to a Roll is not a way to step out
of the matchup.

At most three of the four cross-pairs can be wins, so the widest possible
matchup is **+3 for you and −3 for them**: a six-point swing. That tilts a
fight. It does not decide one.

**A side that is not exactly one fighter has no matchup** — with more than one
opponent there is no single opposing stance to score against, so the bonus is
simply absent for that pair. The arena-wide **Uneven Combat** toggle does not
switch it off: that toggle only *permits* lopsided pairs, and a plain duel in a
fight that happens to have the toggle on still has exactly one stance a side.

Both fighters can see this number: it sits either side of the **VS** divider in
the Arena, one signed value per side, from the moment both are seated. You are
never guessing at what you are walking into, and a stance is still worth
changing while you can see the price of it.

### Combat Style — a Move that brings its own Style

A Move may carry a **Combat Style** of its own. It is optional, and most Moves
will not have one.

When a Move with a Combat Style rolls, **that Style is added to its user's
stance for the matchup** — three Styles scored against three instead of two
against two. The other fighter's own Move does the same on their side, so what
gets compared is what both people are actually doing, not one commitment
against a bare stance.

**A Style already in your stance is counted twice.** That is the whole point. A
Strength/Technique fighter throwing a Strength Move is scored as *Strength,
Technique, Strength* — every comparison involving Strength happens twice, and
Strength's half of the matchup doubles. Against a stance Strength beats, the
Move is markedly better. Against one that beats Strength, it is markedly worse.
Committing hard to what you are good at is a bet, not a free bonus.

Two things follow that are easy to miss:

- A Style whose score against the opposing stance already nets to zero doubles
  to nothing. Doubling only pays where there was something to double.
- A Style the opponent also holds still cancels. The duplicate is inert — it
  never counters itself.

The Combat Style is **not** the same field as the Style that gates who may
learn and use a Move (below). A Move can have either, both, or neither, and
they need not be the same Style. Default Moves — usable by anyone — never carry
the gate, but they can absolutely carry a Combat Style.

Combat Style applies to a **Move's own roll**. It does not touch the round's
initiative roll, which happens before anyone has declared anything.

**You can see the price before you commit.** In the Arena's declare list, a Move
carrying a Combat Style shows what that Style is worth against the stance across
from you — `Strength +2 vs their stance`, green for a gain and red for a loss —
so choosing a Move is a choice you can actually read. It is scored against their
*stance* only, the same as the number either side of the VS divider: during
Declaration nothing has revealed, so what their Move will bring is still unknown.

Once the round resolves, the cutscene's log spells the whole total out term by
term — `9 + 2 (Stance matchup) + 3 (Combat Style: Strength) − 2 (Held in a
grapple) = 12` — so a modifier never has to be taken on faith.

## Moves

A **Move** is one physical action with a shape in time. It has:

- **Frame data** — its **Startup**, **Active**, and **Recovery** Tics
- an optional **Roll** — which Stats you throw when it lands
- an **Attack Target** — which Stats its damage may land on
- a **Stamina Cost**
- a **Tell** — the picture your opponent sees before they know what it is
- up to ten **Tags**

**Default** moves are available to everyone and never carry a Style. A
**Unique** move carries one Style, and only a character with that Style in one
of their stances can learn it.

### The Block Tag

Most Tags just describe a move. The **Block** Tag changes how it is paid for.

A move tagged **Block** has **no Stamina Cost**. It costs nothing to declare —
you can always throw up a guard. It pays afterwards, for exactly as much of
the attack as it actually **absorbed**, and never for more than the attack was
worth: a 6 met by a guard of 20 is stopped completely and costs **6**, not 20.

In place of a Cost, a Block carries a **Stamina Modifier** — a multiplier on
that bill. Above 1 is a guard that punishes you for using it; below 1 is one
you can hold all fight. It is never 0 or negative, so a Block is never free.
The final figure is rounded to the nearest whole point.

> **A guard only holds as much as you can pay for.** If stopping the whole
> attack would cost more Stamina than you have left, your guard holds as much
> as your Stamina buys and the rest gets through. Stamina *is* your defence —
> a fighter running on empty cannot keep blocking.

A **Dodge** is unaffected: it either works or it doesn't, so it has no "amount
absorbed" to charge for and keeps an ordinary Stamina Cost.

### The No Damage Tag

Not everything you do in a fight is meant to hurt. A shove, a feint, a hand
closing on a wrist — these land or they don't, and either way nobody's Stats
go down.

A move tagged **No Damage** deals none. Ever. Whatever it rolls, no Stat is
stepped, and it can never Interrupt anybody, because an Interruption is
something damage does.

Instead it has a **Success Threshold** — a number, 5 by default. Reach it and
the move **succeeded**; come up short and it **failed**. That is the whole
outcome.

- **On success it fires On Hit.** The move connected and did its job, and On
  Hit is where whatever it does is hung.
- **On failure nothing fires.** Not On Miss — a Miss means your opponent
  *dodged*, and nobody dodged this. It just wasn't good enough.

A No Damage move still costs Stamina, still has frame data, and can still be
Blocked or Dodged like anything else. A **Full** Block or Dodge stops it
outright, exactly as it would an attack. A **Partial** one leaves it whatever
got through the guard — and that reduced number is what has to reach the
Threshold, so a half-stopped shove can fail on a roll that would otherwise
have been plenty.

> The default of **5** is the same figure that separates a real hit from
> Insignificant Damage, and that is deliberate: a roll too weak to be worth
> half a point of damage is a roll too weak to have accomplished anything.
> Raise it on a move that should be hard to pull off.

### The Feint Tag

Every move you declare shows a **Tell** — everyone at the table can see the
shape of what you are about to do, even though they cannot see which move it
is. A **Feint** turns that against them.

A move tagged **Feint** shows its Tell like anything else. Nothing about it
looks unusual, and that is the point: it is a lie told in public.

What it changes is the move you declare **immediately after** it. That one
goes onto the timeline **hidden**:

- It shows **no Tell**. Nobody else sees a card for it at all.
- It shows **no wind-up**. The grey marking that normally shows everyone the
  Tics an attack is winding up on does not appear.
- It is otherwise **a completely ordinary declaration**. You pay its Stamina
  when you finish declaring, it occupies its Tics, and it resolves on its own
  frames exactly as it would have.
- It **reveals in the fight itself**, on the Tic it was always going to
  reveal on — and from that moment it is as public as any other move.

"Immediately after" is literal, and it means the same thing it means for a
Requirement: the hidden move must start **on the very Tic the Feint's own
frames end**. Hold it back even one Tic and you get a normal, visible move —
the concealment is bought by committing to the follow-up right now, in the
same breath as the lie.

> A Feint is worth what your opponent believed. Against someone who never
> reads Tells it does nothing at all, and it still costs you a move's worth
> of frames to throw.

### The Interruption Tags

Two Tags carry a **number in their own name**, written the way a table would
write it on a card: **Interrupter (2)**, **Hard to Interrupt (3)**. They are
the only Tags that do this, and both of them move exactly one comparison — the
Interruption check — and nothing else.

- **Interrupter (x)** goes on an *attack*. When that attack lands on somebody
  still winding up, the Interruption is counted **x higher**.
- **Hard to Interrupt (x)** goes on a move that might get *caught* winding up.
  It raises the bar an Interruption has to clear against that move by **x**.

Neither one touches a real roll or a real amount of damage. The attack does
not hit harder; it is only *considered* more disruptive, for that one
question. See **Interruption** under Resolution for the check itself.

If you write just **Interrupter**, with no number, it counts as 1. Several of
them on one move add up, so three different Tags worth 1, 2 and 3 sit on a
move as a 6.

### Grappling

Most moves try to hurt you. A **Grappling** move tries to *take* you.

A grappling move doesn't land or miss. It opens a **four-way branch**: up, down,
left, right, each of which can carry another move.

**You declare only the grab.** Nothing else. What follows it is decided during
the fight, not written down beforehand, and it happens in this order:

1. **The grab is settled first.** The grappler rolls, the target rolls their
   **Resist Roll**, and the grab has to clear its Success Threshold *and* beat
   them. Fail and nothing happens at all.
2. **The grappler chooses the follow-up.** Only now, holding them, and only from
   the moves on the four arrows. Anything they have not learned or cannot pay
   for is shown but greyed out, and they may always decline and simply keep the
   hold.
3. **The target guesses which way it went** — if there was more than one way it
   could have gone. Read it right and the follow-up takes **−5**; read it wrong
   and it takes **+5**. The grab itself is already settled, so the read decides
   how well the follow-up lands, not whether you were caught.
4. **The follow-up appears on the timeline**, right after the grab, as a Tell
   everyone can see. It costs its Stamina like any move, and resolves on its own
   Tic. If it runs past the round's end it simply carries into the next one.

**It chains as far as you can pay for.** If a follow-up is itself a grappling
move, the whole sequence starts again from step 1 — grab, choose, guess, declare
— with no limit but Stamina and the clock. Run out of Stamina and the chain
ends there; the hold you already have stays. The read carries into the chained
grab exactly as it would into any other follow-up: a grapple chained off a grab
your opponent read wrong is a grapple thrown at **+5**, and one they read right
is thrown at **−5**.

It is the one place in a fight where you read your opponent **during** the
exchange rather than before it.

Three parts make one up:

- **The four directions.** Any move in the game can sit on any arrow, and the
  same move may sit on more than one. You do not have to fill all four —
  **two or more** is what turns it into a guessing game. With one, the grab
  still works and still chains, it just arrives without the mind-game. With
  none, it is a grab that goes nowhere.
- **The Resist Roll.** What the *target* throws to fight it off, chosen on the
  grappling move itself — so a headlock and an ankle pick can be resisted with
  different Stats. Leave it empty and the target cannot contest the grab at
  all: it then succeeds on clearing its Success Threshold alone.
- **On Successful Grapple.** A grab has no "hit" of its own, so this is where
  whatever it does to you is written.

A grappling move is normally also tagged **No Damage** — taking someone down is
not the same as hurting them — but the two are separate, and a grab that also
does damage is legal.

**The guess.** When **two or more** directions carry a move, the grab becomes a
read. Both fighters are asked at the same moment, and neither answer is shown
to the other:

- **The grappler** sees the four arrows with their moves on them, and picks
  one.
- **The target** sees the same four arrows with the names stripped — they can
  see *which* directions carry something, not *what* — and guesses.

Guess right and the target takes **+5**; guess wrong and the grappler does.
The dice are not thrown until both have answered, so the read is made on a
blind grab rather than on a number already on the table.

With fewer than two directions assigned, or when both fighters are NPCs, there
is nothing to read: the grab goes straight to its contest with no bonus to
either side.

> A direction may point at *another* grappling move. That is allowed, and the
> chained grab resolves as an ordinary move: its own frames, its own roll, but
> no second guessing game and no second contest. A move can never point at
> itself.

### Rolls

A Move's Roll picks from six slots: **Skull**, **Brain**, **Stamina**,
**Body**, and the two *ambiguous* appendage choices **Hand** and **Leg**.

An ambiguous slot resolves to a real die only when the move is used — you pick
a side. Because of that, a move with a single ambiguous slot needs **two
Tells**, a left and a right, and shows both until it is actually thrown.

Taking an appendage slot **twice** means *both* sides at once — a straight
block that guards with both hands. Two is the ceiling. Taking a slot twice
also answers its own left/right question, so such a move needs only one Tell.

**Custom Roll** replaces the Stat slots with a single flat die (d4–d12)
belonging to the *item* rather than the wielder. That is how weapons work.

**A modifier modifies the roll, not each die.** Everything that adjusts a roll
— the move's own Roll Modifier, your Reasons to Fight, the Stance matchup, a
Perk's bonus, whatever the GM adds by hand — is summed into one number and
added **once**, at the end, to the whole roll.

So a move rolling Skull + Body + Brain at +4 throws three dice, adds them up,
and then adds 4. It does not add 4 three times.

> The one thing that *is* per-die is a die's own bonus — the `+1`s a Stat
> collects once it is past d12. That belongs to the die, so it rides with it.

### Attack Target

Every Move with a Roll lists which Stats its damage lands on — all of them, not
one of them. Naming two Stats is naming two places the blow arrives, each
defended on its own (see Damage below). An **empty** Attack Target is
meaningful, not an oversight:

- On a **Defensive** move it means the move is **defence-pure**: it exists to
  be selected as a defender and never attacks on its own account.
- On any other move the attack is real, and a **successful Block** is what
  gives it a target — see Blocking.

### Defense Frames

Any individual frame of a move — Startup, Active, or Recovery alike — can be
tagged as a **Defense Frame**: a Tic during which that move can defend.

This is an annotation on top of the frame's own phase, not a fourth phase. It
never changes how long a move takes.

**What matters is where those Defense Frames land on the timeline, not where
the move was placed.** Two moves placed on the same Tic are not automatically
in contact with each other — see Blocking.

## Combat Timing

Combat runs on **Tics**. A round is **seven Tics** long.

The Tic counter never resets. A round's seven Tics are a window onto one
absolute, continuous timeline — which is exactly what lets a move started near
the end of one round go on existing into the next.

Each **pair** of fighters runs its own independent clock. Fight A can be on
round 5 while fight B is still on round 3. No fight ever waits on another.

A round has exactly two phases:

1. **Declaration** — the human phase. Each side places its moves on the Tic
   Counter, in an order decided by initiative.
2. **Resolution** — automatic. The instant both sides finish declaring, the
   round resolves itself Tic by Tic and plays back as a cutscene.

### Placing a move

A move placed at a Tic **reveals** once its Startup elapses, is **Active** for
its Active frames, then **Recovers**. Until it reveals, your opponent sees
only its **Tell** — that a move is coming, and roughly what shape, but not
which one.

Your next move can never be placed before your previous move's full footprint
ends, including across a round boundary. A move whose footprint runs past the
round's last Tic simply carries into the next round; the strip marks that with
a **+N** while you are placing it, and you can preview exactly how much of
your next round it eats.

Placing several moves in one Declaration is allowed and often correct. You are
writing a short plan, not answering one question.

### Requirement — moves that only follow other moves

Some moves carry a **Requirement**: the name of another move. A move with a
Requirement can only be declared **immediately after** the move it names —
not on its own, not later in the round, not with anything in between.

It is strict in both senses. The required move must be the very last thing you
queued, and the follow-up starts on the exact Tic that move's Recovery ends.
You do not choose where it goes: drop it anywhere and it snaps to the one Tic
it is allowed to occupy. If you queue something else in between, the sequence
is broken and the follow-up is no longer available — queue the required move
again and it opens back up.

This is how **combos** are built. A Cross that requires a Jab is a Cross you
have to earn by throwing the Jab first, and it lands on the beat the Jab
finishes rather than whenever you please.

What a Requirement does **not** check is whether the first move connected. The
whole round is declared before any of it is resolved, so at the moment you
commit to the follow-up nobody yet knows whether the Jab landed. A combo that
whiffs still runs — you committed to it, and paying for a read that went wrong
is the same bargain every other declaration makes.

A move can never require itself, and deleting a move frees anything that
required it. Moves chained by a successful **Grapple** are placed by the
system rather than declared, so they ignore Requirements entirely.

### Secondary — moves you are handed, not moves you reach for

A move can be marked **Secondary**. You can be taught it, it sits on your
sheet, you can read it in full — but you can never simply *choose* it. It is
greyed on the sheet and greyed in the declaration list, and it will not go onto
the timeline no matter how you drag it.

There are exactly two ways a Secondary move arrives:

- **As a combo follow-up.** Give it a Requirement, and it becomes declarable —
  but only ever in the one slot right after the move it names. The rest of the
  round it stays grey.
- **As a grapple option.** Give it no Requirement, put it on some grappling
  move's cross, and nothing can declare it at all. It reaches the board only
  when a grappler takes hold of someone and picks that direction.

That is the whole of it: Secondary never opens a new way to declare a move, it
closes the ordinary one. A move that is Secondary with no Requirement and
nothing pointing at it is simply unreachable — legal to write down, but nothing
in a fight can ever produce it.

The point is moves that belong to a moment rather than to your hand. The knee
that only exists once you already have someone in a clinch is not a move you
pick; it is a move the clinch gives you.

### Recovery somebody else puts on you

Some moves do more than hurt. A move can carry an effect that **puts Recovery
on the person it lands on** — a shove that staggers, a clinch that turns them
around, a stamp that costs them a beat.

That Recovery is not paperwork for later. It happens **the moment the move
lands**, on the clock, and what it does depends on what you were doing right
then:

- **Caught winding up.** The extra Tics go onto that move's **Startup**. The
  move is not ruined — it is *late*. It still comes out, further down the
  strip than you planned.
- **Caught mid-move.** Whatever you were doing plays out exactly as declared,
  and the extra Tics go **on the end**, after your own Recovery. You finish
  the punch and then you are stuck there.
- **Caught between moves.** There is nothing to lengthen, so the cost is the
  delay itself.

In all three, **everything else you had queued slides that many Tics later**.
A plan is a sequence, and pushing one part of it back pushes the rest.

> This is the cheapest thing in the game to underestimate. Two Tics of
> imposed Recovery on someone who had three moves lined up costs them two Tics
> on all three — and hands you the initiative for the rest of the round.

### Initiative

At the start of every round, both sides roll **Brain**. **The loser declares
first** — being forced to commit before you have seen anything is the
disadvantage.

The roll takes your Reasons to Fight, your Stance matchup, and **−1 per Tic of
overflow** you are still carrying in from last round. Being mid-move at the
turn of a round costs you the read on the next one.

Ties break, in order: current Brain, then locked Brain, then whether your
active stance contains **Speed**, then random.

## Resolution

Every Tic, in order:

1. Reveal any move whose reveal Tic has arrived.
2. Roll it, if it has a Roll.
3. Pick the target.
4. Select the defending move by frame overlap.
5. Resolve a Block, a Dodge, or a plain Hit.
6. Check for an Interruption.
7. Apply Idle-Tic Stamina regeneration.

Nobody steps a Tic by hand and nobody rolls anything by hand. Every roll in a
fight is made by the engine, with every bonus already folded in.

### Damage

A roll deals **one Half-Damage step per full 5 rolled**. A 12 is two steps, a
9 is one, a 4 is none.

A roll under 5 is **Insignificant Damage**: the swing landed but did nothing
worth counting. It deals no damage, and because it *connected*, it fires the
move's **On Hit** trigger.

> **A Miss is an attack that was evaded — nothing else.** Only a successful
> **Dodge** produces one, and only a Dodge fires **On Miss**. An
> Insignificant hit is not a Miss: it touched its target. A **Full Block** is
> not a Miss either — something was there to stop it — and fires **On Block**.

**An insignificant attack is still a real attack, and can still be blocked or
dodged.** It goes through defence exactly like any other: the defender's guard
is selected, rolled and classified as normal, and every defensive trigger —
**On Block**, **On Successful Defense**, **On Failed Defense** — fires just as
it would against a heavy blow. Only when nothing defends it does the attack
land for nothing and report Insignificant Damage; when a defence resolved it,
the defence's own outcome is what the log reports.

Damage lands on **every** Stat in the move's Attack Target that still has a
working die — a Move that names two Stats hits both of them. Stats are worked
through in a fixed order:

**Skull, Brain, Left Hand, Stamina, Body, Right Hand, Left Leg, Right Leg.**

A Move that comes at several Stats is several lines of attack, and a defence has
to answer each of them separately. A **Block** is rolled once per attacked Stat
— one roll cannot guard two lines, and a Block Tag pays for each line it
absorbs, so a guard that spent everything holding the first Stat has nothing
left for the second. A **Dodge** is called once per attacked Stat: the GM is
asked about each in turn, and the attack only counts as evaded if the Dodge got
clear of all of it. Whatever gets through on a line lands on that line's Stat.

### Blocking

Blocks are fully automatic — pure dice, no prompts, ever.

A Block engages when its Defense Frames overlap the attacker's Active window.
There are three ways that can land:

- **Full coverage.** The Block is rolled against the attack. The net result
  decides a **Full** Block (no damage) or a **Partial** one (reduced damage).
- **The guard catches the opening frame and no more.** This is a *working
  Block*, not a failed one. It resolves normally, and the blocker's own
  **Recovery is extended** to hold the guard through the rest of the attack.
  That is announced, and drawn on the timeline in the Block's own colour.
  Being committed for longer is the price of catching it late, and it is a
  fair one.
- **Too early.** The guard was already down by the time the attack became
  Active. Automatic failure.

And one way it can fail to happen at all: **no overlap**. Placing a Block on
the same Tic as an attack does not make it a Block. If its Defense Frames sit
on its Startup square, those Tics fall *before* the attacker's Active window
even opens — the attacker has a Startup too. Nothing meets, and the attack
lands in full. The Arena says so by name when it happens, rather than leaving
you to wonder.

A **successful Block replaces the attack's Attack Target with the blocker's
own rolled Stat** — which is how an attack with no Attack Target of its own
ever lands anywhere. You blocked it with your arm; your arm is what took it.

A Block must roll a Stat. A Custom Roll move can never serve as a Block, since
it has no named Stat to become that replacement target.

If an extended Recovery collides with a move the blocker had already declared,
they choose: **Forfeit** it (full Stamina refund) or **Postpone** it past the
extension.

### Dodging

Dodge is the one call in the game left to a human.

It is stricter than Block: anything less than **full coverage** fails
automatically, with no prompt. A dodge that only half-covers an attack is
already mechanically doomed, and there is no judgement in confirming that.

Full coverage pauses that pair's fight and asks the **GM**: did it land? Every
other pair keeps resolving while that one waits.

**A Dodge is binary.** The GM's answer is the whole resolution — there is no
third outcome and no roll-off:

- **Successful** — you are not there any more. No damage, none at all, and the
  attack counts as a **Miss** for the attacker's own interactions.
- **Failed** — the dodge does nothing whatsoever, and the attack resolves as
  though it had never been declared as a defence.

The dodger does not roll. Nothing about their dice can make a successful dodge
partly fail or a failed one partly work, so there is nothing to roll for. This
is the one place Dodge and Block genuinely differ: a guard is a surface that
absorbs some of a blow and can be overwhelmed by a bigger one, which is why a
Block *does* roll and *can* come out Partial. Empty air cannot be
half-occupied.

If the dodge does not cover the attack completely, that is simply a **failed
dodge** — not a partial one.

### Interruption

Taking a hit while you are still inside your own move's **Startup** can
disrupt it.

The engine walks the attacker's Active window for the first Tic at which the
target is still in Startup. The Interruption is then rolled **on the caught
move's own Roll** — or **Body**, if that move has none — at **+1 per elapsed
Active Tic**: the shock is measured on the very move it caught. Reaching the
damage that just landed means that move **comes apart** — it is cancelled and
half its Stamina Cost refunded. Falling short means the fighter held it
together and it comes out as declared.

**Interrupter (x)** on the attack adds x to that roll; **Hard to Interrupt (x)**
on the caught move adds x to the bar it has to reach. See **The Interruption
Tags** under Moves.

Getting caught winding up is how a fight turns over in one exchange — which is
why a wind-up is not a secret. Every Tic an attack spends in **Startup** is
marked on the Tic Counter for everyone: a grey square where it begins and a
fainter one for each Tic it is still winding up on. A three-Tic wind-up
therefore *looks* like a three-Tic wind-up, and you can see the window you are
aiming an Interruption into rather than guessing at it.

What the marking never tells you is **what** the move is, when its Active
frames land, or how long it recovers for. That is what the Tell is for, and
what reading one is worth.

### What a move does besides damage

A move can carry effects that fire on a specific outcome — **On Hit**, **On
Block**, **On Miss**, **On Successful Defense**, **On Failed Defense**, **On
Successful Grapple**. Each one is a line of description plus any number of
mechanical effects, and they all resolve the instant that outcome is decided:

- **Recovery on you or on them** — see *Recovery somebody else puts on you*
  under Combat Timing. It lands on the clock immediately.
- **Stamina off you or off them**, on top of whatever the move already cost.
- **Step a Stat down** — yours or theirs. Half-Damage steps, exactly as damage
  works, but they land wherever the move says rather than where the attack
  was aimed.
- **Step your own Stat up** — the same thing running backwards, a move that
  puts something of yours back together as it lands.
- **Weaken their next roll** — a flat penalty on the very next roll that
  fighter makes, **of any kind**. It is a debt, not a condition: it is paid by
  that one roll and then it is gone. Nothing else about them changes, and it
  does not expire at the end of a round — an opponent who never rolls again
  this round carries it into the next one.

## Stamina

Stamina is a Stat like any other, and also a pool: `current / max`.

- Declaring a move commits its **Stamina Cost**. Taking the move back before
  you finish declaring refunds it in full.
- **Idle Tics** — Tics in which you have nothing happening at all — regenerate
  Stamina. Doing nothing is a real option.
- At the start of every round after the first, every fighter rolls their
  Stamina die and adds it to the pool.
- **Start Combat** restores everyone to full **only if the GM ticks "Fresh"**.
  Fresh is off for every new fight, so by default a fight begins on whatever
  Stamina you still had — back-to-back fights wear you down. Fresh changes the
  start of a fight only; the round-start Stamina roll above happens either way.

**At zero Stamina you can still fight, but only with moves that cost nothing.**
You are not down and you are not penalised — your good options are simply gone
until you buy them back with idle Tics and the round-start roll. Exhaustion in
this game narrows what you can do rather than telling you that you have lost.

## Reasons to Fight

Each seated fighter carries a **0–3** counter. Each point is **+1 to all of
that character's rolls** for the fight, initiative included.

It lives on the *seat*, not the character, so it resets when they are seated
for a new fight. What you were fighting for last time is not automatically
what you are fighting for now.

The GM sets it, and the honest way to set it is from the answer on that
character's Role-play tab: *what is something they would fight for, no matter
what?* A fighter with three points in a fight that matches that answer should
feel like a different fighter.

## Winning, Losing, and Stopping

**There is no hit-point threshold in this game, and no rule that says when a
fighter is finished. The GM calls it.**

That is deliberate. The dice already tell you everything you need: a character
with an incapacitated Skull, no Stamina, and both hands stepped down to d4 is
plainly done, and no number needed to announce it. A character who is one bad
Tic from that but standing in front of the person who killed their brother may
very well not be.

The app tracks the damage precisely and takes no view on what it means. A
fight ends when the table agrees it has ended — someone yields, someone can't
continue, someone walks away, someone is stopped.

If your table wants a hard line, agree one before you start and hold to it.
The rules will not fight you either way.

## Rolling Outside a Fight

Not everything is a fight. When something outside combat is uncertain and
worth a die, the GM asks for a Stat roll — from the GM Tools widget, which
puts the request in front of that player wherever they are in the app.

**The GM names a difficulty before the roll, and you beat it.** The same
5-point granularity damage uses:

- **5** — awkward. Most people manage it.
- **8** — genuinely difficult.
- **12** — you should not be able to do this.

Your Reasons to Fight and Stance matchup do not apply here; they are combat
things. Your die and its bonus are what you have.

Roll the Stat that fits what you are actually doing: Brain to read a room,
Body to hold a door, a Leg to make a jump. If it is not obvious which Stat
applies, that is usually a sign the thing does not need a roll.

## Perks

A **Perk** is something your character is, rather than something they do. Moves
are choices you make in a round; a Perk is standing, always there, and you never
declare it.

Your GM writes them and hands them out. A Perk has a picture, a name and a
description, and that description is the rule — most Perks in a world are exactly
that, a line of text the table reads and applies between them, which is a
perfectly good Perk.

Some Perks do more: the app knows them by name and applies them itself. Those
carry a small **⚙ Auto** badge on their card, and it means you can stop tracking
them. They fire on their own, and when one changes a number it says so — a Perk
that adds to a roll appears on that roll's own breakdown under its own name, and
a Perk that fires in the middle of a round gets its own line in the log, exactly
like a move's On Hit would.

A Perk with no badge is not a lesser Perk. It just means the table applies it, the
way tables always have.

### The Perks in play

- **Genius Observer.** You read a fight faster than anyone should. Any move that
  has publicly revealed can be opened in full from the Chat Log — its
  description, its frames, everything it does — instead of just its name and
  shape. Without it, a revealed move shows you what everyone can see and no more.
- **Cornered Animal.** You fight hardest with your back to the wall. While your
  Stamina is at a quarter of its maximum or below, every roll you make counts +2.
- **Second Wind.** Getting hit wakes you up. The first time your guard fails in a
  round, you recover 2 Stamina. Once per round — it comes back when your fight
  reaches its next round, not when somebody else's does.

## Counters

A Counter is a simple clock: a name, a target number of pips, and how many are
filled. Characters own their own; the Arena can also hold standalone ones for
the GM to track something about the fight itself.

Counters can be adjusted from a character's sheet, from the Arena, or directly
from the `+` on any roll card in the chat log — the last of these being where
you will actually use them, since counters usually tick because of something
that just got rolled.

A character's counter can carry a **reward** tag (Story, Statistic, Perk,
Move, Combat Prowess). That is a tracking label for the GM, with no mechanical
effect of its own.

## Uneven Combat

A toggle for fights that are not one-on-one. It changes two things:

- Participant cards scale down so more than one fighter fits a side.
- **The Stance matchup bonus is switched off for everyone in the arena.**

The app does not otherwise enforce the toggle — it is a GM-facing flag, not a
rules engine. Everything else about an uneven fight is the same game, with
more people in it and worse odds for somebody.
