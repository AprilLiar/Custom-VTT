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

- **Interrupter (x)** goes on an *attack*. Its roll counts **x higher** when it
  is contested against a move it caught winding up.
- **Hard to Interrupt (x)** goes on a move that might get *caught* winding up.
  Its roll counts **x higher** in that same contest.

Neither one touches a real roll. Both rolls go out at their real values; the Tag
is only what that roll is *considered* to be worth for this one question. See
**Interruption** under Resolution for the contest itself.

If you write just **Interrupter**, with no number, it counts as 1. Several of
them on one move add up, so three different Tags worth 1, 2 and 3 sit on a
move as a 6.

### The Movement Tags

These two only mean anything about each other. On its own, neither does a thing.

- **Movement** goes on a move that takes you somewhere — a step in, a roll out,
  a lunge. It is the one Tag in the game that is purely a **liability**: it
  buys the move nothing and tells the table what it is vulnerable to.
- **Movement Punisher** goes on a move built to catch somebody doing that.

If a **Movement Punisher** attack **connects** with a fighter who is in the
middle of a **Movement** move, that fighter **trips**: **3 Trip Recovery
Frames**, added to whatever they are doing exactly the way any other imposed
Recovery is. Three Tics later than you meant to be is what being put on the
floor costs in a game measured in Tics.

Trip Recovery Frames are Recovery you spend **on the ground** — see *Trip
Recovery Frames* below. They block and delay exactly like ordinary Recovery;
the difference is that a move tagged **Off The Ground** can be thrown out of
them.

**"Connects" means at least half a point of damage actually landed.** A miss
trips nobody, and neither does a blow a guard reduced to nothing — you have to
have genuinely caught them mid-stride. It does not matter whether their move
had come out yet: a Movement move still winding up is a fighter already
committed to going somewhere.

### Trip Recovery Frames

Most Recovery is a fighter catching their balance. **Trip Recovery** is a
fighter on the floor. Mechanically the two are the same thing — trip frames end
a move's footprint, block the next one, and push back everything queued behind
them, just as ordinary Recovery does — and on the Tic strip they are drawn in a
**darker blue with a down arrow** on every frame, so you can see at a glance
which of the two somebody is in.

Where they come from: the **Movement Punisher** Tag above, and any move whose
On Hit (or other) effect says **Trip the opponent** or **Trip yourself**.

They always sit at the **end** of whatever you were doing. A trip does not undo
the punch that was already landing — it lands, and then you are on the ground.

### Off The Ground

A move tagged **Off The Ground** can be thrown while you are still getting up:
its **Startup may overlap your own Trip Recovery Frames**.

Two limits, and they are the whole shape of the Tag:

- **Only Trip Recovery.** Ordinary Recovery still has to finish. The Tag is not
  a general licence to start early — it does nothing at all unless you have
  actually been tripped.
- **Only the Startup.** The move's **Active** frames can never begin before you
  are back on your feet. A move with 2 Startup thrown into 3 trip frames starts
  2 Tics early and connects exactly when the trip ends; one with 5 Startup
  still only reaches back 3, because that is all the trip there was.

So a fighter with the right move in their list is not simply three Tics behind
after a trip — they can spend those Tics winding up instead of lying there. It
is the answer to Movement Punisher, and it costs a Tag slot on the move.

**A broken Leg forbids Movement moves entirely.** Either Leg — you do not step,
slip or lunge on one leg, and the rule needs no follow-up question. A Movement
move cannot be declared while a Leg is out, and the picker greys it and says so
rather than letting you commit to something that will be refused.

If a Leg breaks **after** you declared one, the move is **lost** and its Stamina
comes back. You did not choose that; the leg went under you mid-round, and the
rule that ends the move should not also charge you for it. The round says so
when it happens, so a move that simply never comes out is never a mystery.

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

A Move's Roll picks from seven slots: **Skull**, **Brain**, **Stamina**,
**Body**, the two *ambiguous* appendage choices **Hand** and **Leg**, and
**Weapon** — which is not a Stat at all, but whatever you happen to be carrying
(see The Weapon).

An ambiguous slot resolves to a real die only when the move is used — you pick
a side. Because of that, a move with a single ambiguous slot needs **two
Tells**, a left and a right, and shows both until it is actually thrown.

Taking an appendage slot **twice** means *both* sides at once — a straight
block that guards with both hands. Two is the ceiling. Taking a slot twice
also answers its own left/right question, so such a move needs only one Tell.

A move that rolls the **Weapon** slot cannot be declared with empty hands —
there is nothing to swing. Such a move is greyed out on your sheet and in the
declare picker until you are carrying something.

**Custom Roll** replaces the Stat slots with a single flat die (d4–d12)
belonging to the move itself rather than to the wielder — for a move whose
damage die should not move when your Stats do.

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
defended on its own (see Damage below). **Weapon** can be named here too, and
it means something different from the six Stats: the move goes for what they
are holding, not for them (see The Weapon). An **empty** Attack Target is
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

**Every move marks the Tic it begins on, for everybody.** One square glows on
the Tic Counter, joined by a line to the Tell it belongs to: "something is
committed here." That is all it says — not what the move is, not how long its
wind-up runs, not whether it can hurt you. **Guards included**: a Block or a
Dodge glows exactly like a strike does. It used to be only attacks that glowed,
which meant the *absence* of a glow was a free and perfectly reliable read that
your opponent was turtling — the one move in the game you could identify without
reading anything.

A move hidden by a **Feint** glows on nothing, because it is not on the board at
all until it reveals.

Your next move can never be placed before your previous move's full footprint
ends, including across a round boundary. A move whose footprint runs past the
round's last Tic simply carries into the next round; the strip marks that with
a **+N** while you are placing it, and you can preview exactly how much of
your next round it eats.

If something pushes a move so far that **not one of its frames is left in the
round it was declared for** — an extended guard cascading through your queue, an
imposed Recovery — it stops being that round's business at all. It becomes a
declaration of the round it now sits in: your Stamina comes back, it appears in
that round's lane, and you can cancel it or leave it exactly like anything else
you declared there. A plan that got shoved into next week is a plan you get to
reconsider.

Placing several moves in one Declaration is allowed and often correct. You are
writing a short plan, not answering one question.

**Facing more than one opponent, you choose who each move is for.** The declare
panel asks — only when there is genuinely a choice — and the pick rides on every
move you declare after it, so one round can be split between two enemies by
changing it partway through. Your **Stance matchup** follows that choice: the
number on your card is what your stance is worth against the person you are
currently coming for, not an average and not nothing at all.

Change your mind before the round runs and the moves already declared keep the
target they were declared with. You committed to them; commitment is what a
declaration is.

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

> **That 5 is the Minimum Damage Threshold, and it is the one gate that can
> move.** A couple of Perks push on it — up for attacks against them, down for
> attacks they make (see **Perks**) — and only the *smallest* gate shifts:
> raised to 7 the ladder reads 7-10-15-20, lowered to 3 it reads 3-10-15-20.
> Everything above the first rung stays where it is. Two fighters pushing it in
> opposite directions cancel out.

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

Damage lands on **every** Stat in the move's Attack Target — a Move that names
two Stats hits both of them. Stats are worked through in a fixed order:

**Skull, Brain, Left Hand, Stamina, Body, Right Hand, Left Leg, Right Leg.**

A Move that comes at several Stats is several lines of attack, and a defence has
to answer each of them separately. A **Block** is rolled once per attacked Stat
— one roll cannot guard two lines, and a Block Tag pays for each line it
absorbs, so a guard that spent everything holding the first Stat has nothing
left for the second. A **Dodge** is called once per attacked Stat: the GM is
asked about each in turn, and the attack only counts as evaded if the Dodge got
clear of all of it. Whatever gets through on a line lands on that line's Stat.

#### Hitting a Stat that is already broken

A broken Stat is at the floor. There is nothing left to step down, so damage
aimed at one **cannot be applied** — but the blow itself is real, and the
attack resolves in full: it rolls, it can be blocked or dodged, and every
trigger fires as it would anywhere else.

Nothing is redirected. The damage does not slide onto a neighbouring Stat; it
simply does not land.

At the end of the round the Chat Log says so, once per Stat, with everything
that failed to land on it added up:

> *1.5 damage should have been dealt to Roy's Left Hand, but it cannot be
> applied. Take this into consideration for Injuries.*

That is the GM's cue. The rules have run out of room, and what happens to an
arm that keeps getting hit after it has already been wrecked is a call for the
table to make — as an **Injury**, or however else the fiction wants it.

### Blocking

A Block engages when its Defense Frames overlap the attacker's Active window.
There are three ways that can land:

- **Full coverage.** The GM is asked whether the guard applies (below). If it
  does, the Block is rolled against the attack, and the net result decides a
  **Full** Block (no damage) or a **Partial** one (reduced damage).
- **The guard catches the opening frame and no more.** This is a *working
  Block*, not a failed one. The GM is asked the same question; if the guard
  applies, it resolves normally and the blocker's own **Recovery is extended**
  to hold the guard through the rest of the attack. That is announced, and
  drawn on the timeline in the Block's own colour. Being committed for longer
  is the price of catching it late, and it is a fair one.
- **Too early.** The guard was already down by the time the attack became
  Active. Automatic failure, no question asked.

#### The GM calls the guard

Overlapping in time is not proof the guard was the *right* guard. A Straight
and a Haymaker can both come at your head, but a front block stops one and a
side block stops the other, and no amount of frame data knows the difference.
So a Block that reaches the guard stops that pair's fight and asks the **GM**:
did it hold? Every other pair keeps resolving while that one waits.

- **Successful** — the guard applies. It rolls, and can still come out Partial.
- **Failed** — the guard is discarded entirely. The attack lands as though
  nothing had been declared against it: damage on the Stats the attack itself
  named, and **no Recovery extension**, because nothing was held. The move
  still cost its Stamina and still occupies its Tics; only its defensive
  effect is ignored.

An attack that names several Stats is **one question per Stat** — a guard that
got your head out of the way did not necessarily get your body out of it. If
every line comes back Failed the guard never happened. If any line held, the
Block stands, and everything that got past it — on a Partial line or a Failed
one — lands on the Stat that did the blocking, exactly as a Partial always
has.

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
the fighter is asked once — by their own player, or by the GM for an NPC — and
the question covers **everything the extension runs into**, not just the first
move. It lists each move and where it would land, and you pick:

- **Push Everything Back.** The queue slides forward to clear the guard, each
  shifted move making room for the one behind it.
- **Forfeit.** Give up only the move the guard actually ran into — its Stamina
  comes back — and everything behind it still slides forward.

Either way, a move shoved so far that **none of it is left in this round** stops
being a commitment: its Stamina is refunded and it goes back to being an
ordinary declaration sitting at its new Tic, which you can cancel or re-place
when the next Declaration opens. A move that merely runs past the last Tic while
still starting inside the round is unaffected — that is ordinary overflow, and
it resolves next round as it always has.

### Dodging

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
target is still in Startup, and then the two moves are **contested**:

- **The attack** brings its own attack roll, plus **Interrupter (x)**.
- **The caught move** brings its own attack roll — or **Body**, if it has no
  Roll of its own — plus **Hard to Interrupt (x)**, plus **+1 for every Active
  Tic of the attack that has already elapsed**. The longer the attack has been
  out, the more of it you have had to read.

**Failing means the move is cancelled** and half its Stamina Cost refunded. Tie
or beat the attack and you hold it together — it comes out exactly as declared.

The damage the blow dealt is not part of this. It is what triggered the check,
not what decides it — and either way, the hit still lands.

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
  puts something of yours back together as it lands. This one has no ceiling:
  it can take a Stat past where it started.
- **Recover your own Stat** — the same step up, but it **stops at your base**.
  It is healing: it clears half a step of damage before it buys a whole one,
  it can never carry a Stat above the value it was locked at, and used on
  something already undamaged it simply does nothing. Whatever recovery you
  do not need is not banked and does not spill anywhere.
- **Weaken their next roll** — a flat penalty on the very next roll that
  fighter makes, **of any kind**. It is a debt, not a condition: it is paid by
  that one roll and then it is gone. Nothing else about them changes, and it
  does not expire at the end of a round — an opponent who never rolls again
  this round carries it into the next one.

## The Weapon

You carry **one weapon, or none — and none is where everyone starts.** Nothing
about you changes when you pick something up except that you have one more die
to throw and a few more Moves open to you.

A weapon is four things and no more:

- **Name** — what it is.
- **Dice** — one of the game's own, d4 through d12.
- **Modifier** — a flat number added to that die.
- **Durability** — a positive whole number. What is left of it.

It lives at the bottom right of your Vitruvian figure, off the body, because it
is the one thing there that is not part of you. Click the empty slot to take
something up; click the weapon to roll it.

### Rolling it

**It rolls like any other Stat.** Die plus its modifier, and then everything
else that adjusts a roll lands on top exactly as it would for Skull or Body —
the Stance matchup, your Reasons to Fight, a Perk, the number the GM adds by
hand.

A weapon has no Half-Damage and cannot be incapacitated. It is not a limb.
Things do not get progressively worse; they break.

### Durability

**Rolling the weapon costs nothing.** A check, a flourish, a contest of
strength — throw it as often as you like.

**Using it in a Move costs 1.** Once per Move, not once per roll: a guard swung
at two limbs is still one guard, and a move that gets rolled twice for its own
reasons still only wears the weapon once. At 0 the weapon is gone.

Every point spent is announced, not just the last one. You should never
discover you were at 1 by finding out you are at 0.

### Going for their weapon

A Move can name **Weapon** as its Attack Target. That move goes for what they
are holding rather than for them, and it is settled by one roll-off:

**Your roll against the weapon's own.** Beat it and the weapon is **destroyed**
outright. **A tie holds it** — breaking a thing is the bigger consequence, so it
has to be earned outright, the same way every other close call in this game
falls to the defender.

Nothing guards the weapon: no Block, no Dodge, no Defense Frame stands between
your swing and it. Its own die is its defence.

**If it holds, nothing lands** — for a move that named nothing else, that is
the whole outcome.

**Against someone carrying nothing, the swing lands on a random Hand instead.**
It was aimed at what they should have been holding, and it arrives at the hand
that should have been holding it. From there it is an ordinary attack on an
ordinary Stat: blockable, dodgeable, and damaging like any other.

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

- **Genius Observer.** You read a fight faster than anyone should. Every move
  that reveals posts a card to the Chat Log, and everyone gets the same thing on
  it: **the move's name, its picture, its frame data and what it cost**. With
  this Perk you can open that card and read the whole move — its description,
  what it rolls, what it is aimed at, its Tags, and everything it does on a hit.
  Without it, the card is as far as you get.
- **Cornered Animal.** You fight hardest with your back to the wall. While your
  Stamina is at a quarter of its maximum or below, every roll you make counts +2.
- **Second Wind.** Getting hit wakes you up. The first time your guard fails in a
  round, you recover 2 Stamina. Once per round — it comes back when your fight
  reaches its next round, not when somebody else's does.
- **Iron Skin.** Hitting you is like hitting a wall. The **Minimum Damage
  Threshold** for attacks against you goes up by 2 — the smallest gate only, so
  damage against you reads 7-10-15-20. A blow under it does nothing at all, and
  a guard that lets less than that through counts as a Full Block.
- **Not Just a Scratch.** Nothing you land is nothing. The Minimum Damage
  Threshold against your attacks drops by 2 — again the smallest gate only, so
  your damage reads 3-10-15-20. Facing an Iron Skin the two cancel out and the
  threshold is the usual 5.
- **Spiked Shell.** Your guard is not a soft place to land. When you
  **Successfully Block**, the attacker takes 0.5 damage for every 5 points your
  guard beat their Attack roll by, and it lands on the **limb they attacked
  with** — both hands if they came in with both, one at random if they mixed a
  hand and a leg. Beat them by less than 5 and nothing comes back, and a guard
  that ran out of Stamina mid-block did not successfully block.
- **Perfect Player.** You are only untouchable while you are untouched. While no
  Stat of yours has dropped below its current Locked Value, any **Dodge** costs
  2 less Stamina. Half a step of damage does not break it; a Stat actually
  losing a die size does.
- **Healing Factor.** You knit back together faster than you come apart. At
  **Round Start**, one instance of Half-Damage is removed from you at random. It
  clears a *pending* half — the marked half-step still waiting for its other
  half — so if nothing of yours is showing one, nothing heals that round.
- **Multifaceted.** You are not one fighter but two. You may build and keep a
  second Stance, switching between them as any fighter switches Stance. Nothing
  automates this one — the table simply lets you make the second Stance.
- **Punches in Bunches.** You throw in combinations, not singles. A **Hand
  Attack** thrown right after another Hand Attack costs 1 less Stamina. A Hand
  Attack is one that *rolls* a Hand — what you are hitting with, not what you
  are aiming at, so a kick aimed at their wrist is not one. "Right after" means
  the move you queued immediately before it, and there is no limit: a third
  punch off a second is still a punch off a punch. What stops you is the clock —
  every punch you string together is a Tic you are not guarding with.
- **The Simplest Tool.** The jab is the whole game. Your **Jab** costs 1 less
  Stamina and rolls with a +1 Bonus to the Attack. It finds the move named
  exactly `Jab` — a "Power Jab" is a different move and gets nothing — so if
  your table wants this Perk, someone writes a Jab into the Compendium.
- **Deadly Pendulum.** You hit hardest coming back. An **Attack** declared right
  after a **Dodge** gets +2 to the Attack, provided the GM called that Dodge
  Successful. You are betting when you declare it: the whole round goes down
  before any of it resolves, so you queue the counter-punch behind the sway and
  find out afterwards whether you earned it. Only a Dodge — a Block that held is
  not a swing away from anything.
- **Baron of Suffering.** You feed on what you do to people. You regain 1
  Stamina for each 0.5 Damage you **deal** — 1 at a 5, 2 at a 10, and every Stat
  a multi-target attack wrecks pays separately. Damage that lands nowhere pays
  nothing: a blow aimed at a Stat already broken is reported at the end of the
  round rather than applied, and there is nothing there to feed on.
- **Wounded Wolf.** What the wound took, it paid for. Lose 1 Step in one Stat
  and gain 3 Steps in another. Nothing automates this one either — you and your
  GM set the two Stats when you take the Perk, and from then on it is simply
  what your sheet says.
- **Piercing Headache.** You hit hard enough to rattle what is behind the bone.
  For every **Full Damage** — a whole point, two half-steps — your Attack deals
  to the target's **Skull**, half a point goes into their **Brain**. Half a
  point on the Skull is not a Full Damage and splashes nothing; 1.0 buys 0.5,
  2.5 buys 1.0. It is counted per Attack, so two separate half-point hits in a
  round never add up into one.
- **Last Breath Taker.** You knock the air out of people. The same rule one Stat
  over: every Full Damage to the **Body** sends half a point into their
  **Stamina** — the Stamina *Stat*, not their Stamina pool.
- **Grounded.** You are never off balance. All your moves ignore the **Movement
  Punisher** Tag: a fighter who catches you mid-stride does not trip you, and
  the Arena says so when it happens.
- **Dogfighter.** You do not come apart when someone lands one. All your Moves
  count as having **Hard to Interrupt (2)** — and a Move that already had Hard
  to Interrupt (x) has it increased by 2 instead. It only makes you harder to
  break up; it does nothing for your own attempts to break up somebody else.
- **Osu!** Technique, paid for in time. Every **Attack** you declare gets **+1
  Recovery** — you are returning to your stance after each one — and in exchange
  every Attack Roll you make gets **+2**. The extra frame is real: it is on the
  Tic strip before you place the move, and it floors where your next one can go.
- **Never Empty-Handed.** **Once per Fight**, you can pick something up off the
  floor: a **d12 Weapon with 3 Durability** and no modifier. The offer sits on
  your empty Weapon slot; taking it is your choice and your timing. Reaching for
  it early spends the Fight's only chance, and what you find is 3 Durability
  that an attack aimed at your Weapon can break.
- **Non-Committed.** You do not commit until you have to. After everyone has
  finished declaring but **before anything is Revealed**, you are asked whether
  to take any of your own moves back. Anything you Interrupt refunds its Stamina
  in full and frees its Tics. Nothing you keep moves — the rest of your queue
  stays exactly where you threw it — but the freed Tics no longer hold up where
  you may place next round. It buys you nerve, not information: nothing has
  revealed yet, and you are guessing exactly as blindly as everybody else.
- **Path To Mastery: Speed.** All your Moves gain **-1 to Startup** — every one
  of them, guards included, not just your attacks. The shorter wind-up is real:
  it is on the Tic strip before you place the Move, and it is what your next
  declaration is floored against. A Move already at 1 Startup goes to 0, which
  means it comes out the instant you place it, with no wind-up for anyone to
  read.
- **Path To Mastery: Strength.** You are hard to stand in front of. **Blocks
  against you take a -5 Penalty** — Dodges do not, since getting out of the way
  does not care how hard you hit — and your own **Minimum Damage Threshold is
  reduced by 1**, so blows that would have been shrugged off as Insignificant
  land instead.
- **Path To Mastery: Durability.** The **first 2 times in a Fight** that a Stat
  of yours would be **Broken**, it is kept at **1d4** instead. The Stat still
  takes everything the blow was worth — it lands at a bare d4, no bonus, no
  pending Half-Damage — it simply does not go out, and the table is told it
  refused. This buys you the two worst moments of a Fight, not two free hits: a
  d4 Stat is one more Half-Damage step from breaking anyway. The charges come
  back when the Fight ends.
- **Eye Catcher.** You read where a blow is going. For any attack aimed at you,
  you know whether it is **High** (Skull, Brain), **Mid** (Body, Stamina, Hands)
  or **Low** (Legs) — **in addition to** its Tell, and **before** it Reveals. A
  Move aimed across two bands shows you both. A pure guard has no Attack Target
  and so shows you nothing, and neither does an attack aimed at a Weapon, which
  is a strike at what you are holding rather than at a height on your body.

> **Splash damage lands like any other damage.** If the second Stat is already
> broken, the splash cannot be applied and is reported at the end of the round
> with everything else that had nowhere to land. And because it is priced off
> what actually landed, a Successful Block that redirects an attack onto the
> blocker's own Skull still splashes — damage to the Skull is damage to the
> Skull, however it got there.

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
