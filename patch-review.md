# 1e "PATCH'd UP" (Purist Edition) vs our rules — differences to decide

Source: `Panic at the Dojo - 1st Edition Patches.pdf` (43 pages). Our rules data is
*Panic at the Dojo 2e / PATCH'D UP Beta*, so many differences come from the edition gap.
Items where the patch already matches us are not listed (Armor 3/2/1 + temporary Armor,
WEPIA order, Burning, Outside only from the edge + Dizzy, Comeback Rule, Traps once per
turn, Teleport is safe, Swap = 2 Speed, Chaos tokens, most Super Moves, XP 2/1, Tags).

Decided by the user one by one (2026-11-24). **Bold** = adopted from 1e — all implemented in v0.3.0 (see the plan, "1e PATCH'd UP adoption").

| # | Topic | The 1e patch says | We have now | Decision |
|---|---|---|---|---|
| 1 | Cinematic Weight HP / Heal | HP per bar 8 / 12 / 16 / 20 / 25; Heal 1/2/2/3/**4** | HP 10 / 15 / 20 / 25 / 30; Heal 1/2/2/3/3; plus Bleed Values | **Implement 1e**: HP 8/12/16/20/25, Heal 1/2/2/3/4; Bleed scaled to 20%: 2/2/3/4/5 |
| 2 | 1v1 fights | Minimum 2 Health Bars per side; a 1v1 gives each fighter 2 bars | No such rule | Keep ours (no 1v1 rule) |
| 3 | Hero advancement | L3/5/7/9 new Stance, L4 Fused Archetype, L6 2nd Super, L8 improve Archetype, L10 Mastery (set one number to 1-9); +HP 0,1,2,2,3,4,5,5,6,8 global for everyone; may swap a Form/Style on level up; all heroes share one level | 2e tracks (Improved/Greater Focus/Fusion/Frenzy, Mastery per type), +HP 0,1,2,3,4,6,7,8,9,10 (heroes) / 0,2,3,5,7,8,10,12,13,15 (warriors), per-character levels | Keep 2e tracks |
| 4 | Enemy advancement | Enemies = players' level. Boss: d4 at L1, second d4 at L2, then lowest die steps up (two d12 at L10), Super at L1, 4th Stance+Super at L5, 5th at L10. Warriors: bonus die like heroes but max d10, Super at L2, 2nd Archetype L4, improve L8. Stooges: one Archetype at L6, nothing else | 2e Warrior track (Warrior's Path, A Warrior's Death…); Bosses/Stooges no levelled extras | Keep 2e |
| 5 | Super Moves in Worldweight | Each unit may use 2 per fight (not both on the same turn) | 1 per unit per fight in every weight | **Implement**: Worldweight — 2 Super Moves per unit per fight, not both on the same turn |
| 6 | Super Moves vs tokens | No tokens in response (Power, Weakness, Iron, Control); Abilities don't trigger; Armor still applies | Not Controllable; other token interactions not specifically blocked | Keep ours (tokens and Abilities still work against Supers) |
| 7 | Super Move texts | Siren's Scream 10-pt Shield; Unending Despair 4 Burning + 4 Weakness; Watch The World Burn 4 Burning; Funny Little Box no Fatigue; Hyper Install 5 Shield + lasts the whole fight; Blizzard gives Burning; Knuckle Sandwich "may push up to 3"; Teacher Delta named "Remember My Teachings" | 8-pt Shield; 4 Burning/3 Fatigue/2 Weakness; 2 Burning + 3 Fatigue; +5 Fatigue; 3 Luck tokens + rest of Round; Fatigue; "Push them 3"; "Transcendant Spirit" | **Implement 1e texts for all** (Siren's Scream 10-pt Shield — see 12) |
| 8 | Deadly Trap | 2 damage; cannot be removed by Actions or Abilities | 3 damage (our ruling); removable | **Keep 3 damage, make it unremovable** by Actions and Abilities |
| 9 | Basic Actions | Grapple X: pull up to 3 (no Gates). Bring It On! 4+: Challenge any number within 1-3. Put It Out! removes non-**Rare** tokens | Grapple: pull 2, Gates 4+/7+ with Fatigue. A Challenger Approaches 1+/4+ (1-4). Put It Out! non-Unique, with a Unique option at 4+/7+ | **Implement 1e** for Grapple, Bring It On! (replaces A Challenger Approaches), Put It Out! (non-Rare) |
| 10 | Power tokens per hit | Up to 2 per hit | 1 per hit (more only via Abilities) | **Implement**: Power works like Iron — base 2 per hit, Abilities add on top |
| 11 | Fatigue & Rubble | No Fatigue tokens at all. Rubble: Free Movement +1 Speed, Action Movement ends on it, Forced Movement stops on it | Fatigue tokens (2e); Rubble gives Fatigue | Keep Fatigue (2e) |
| 12 | Token cap | 10 per type | 9 per type | **Implement**: Shield and every normal token cap at 10; special tokens keep their in-game caps (Training 4, Challenge 1) |
| 13 | Super Tokens | Super Tokens (e.g. Rapid Strike) can't be discarded, copied or converted by anything | Treated like other tokens | **Implement**: Super Tokens untouchable |
| 14 | Taken Out at 0 HP | Empty space (walk over them); can be targeted but only healing / forced movement affect them; self-only parts of their Abilities still work | Full space; enemies can't target them; Abilities mostly off | **Implement all of 1e** |
| 15 | Challenge on fall | Unit leaves play or falls to 0 HP: everyone holding their Challenge discards it | Challenge stays | **Implement** |
| 16 | Save Yourself | After ANY forced movement, 1 Speed: move 1 space | Offered only when the landing is dangerous; 2 Speed out of a Pit | Keep ours |
| 17 | Shields | Only one Shield; gaining another, choose which to keep | A new Shield adds to/raises the old one | Keep ours |
| 18 | Dizzy | Exit your Stance until your next turn: Range 1, no Form/Style Abilities or Unique Actions | Dizzy: no damage taken, no Actions; Stance kept | **Implement**: Dizzy loses the Stance until their next turn |
| 19 | Combat Start | Everyone declares a Stance before Round 1 (enemies first: Stooges, Warriors, Bosses); locked until their 2nd turn | Stance chosen at each turn's start | **Implement**: declare Stances at Start Combat (Stooges, Warriors, Bosses, then heroes); first turn uses it |
| 20 | Reactions | After each Action every other character gets ONE Reactive Action (allies first), plus a last one at the end | Interrupt button any time; queued after the current Action | Keep the Interrupt button |
| 21 | Control tokens | At declaration: Negate or Steal the Action | Copy (1) / Dodge (2) / Parry (3) after declaration | Keep 2e Copy/Dodge/Parry |
| 22 | Max Action Pool | 10 numbers; discard down to 10 | No cap | No cap |
| 23 | Frantic Heroes | Only Styles from their 3 Archetypes, one per Archetype; no free Style | A Freestyle may be picked from any Archetype | Keep 2e (Freestyle ok) |
| 24 | Builds | New: Bulky (+3 HP/bar), Experimental (end of turn: 1 Burning to an enemy you damaged), Intimidating (start or end of turn: 1 Weakness to an enemy in range); Tough = END of turn +1 Iron | 6 Builds (Agile, Bumbling, Mysterious, Overpowering, Scheming, Tough); Tough = START of turn | **Implement**: add Bulky, Experimental, Intimidating; Tough stays start of turn |
| 25 | Poltergeist tokens | Up to 2 per Action; options slightly different (Rubble overrides obstacles; +1 to non-damage numbers) | "Up to 2 additional" per Action; 2e option wording | Keep 2e wording |
| 26 | Map size & placement | Arenas ~140-180 spaces (13×13 / 9×18 / 7×28); over half the edge Walls; enemies place first (5 of their leader), heroes within 7 of each other and 3+ from enemies | Any picture size; free placement | Nothing |
