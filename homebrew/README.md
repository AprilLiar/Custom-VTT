# Homebrew core

The GM's published homebrew (Forms, Styles, Archetypes), committed by the app's
**GM Tools → Commit Homebrew**, plus Claude's automation of it. The plan's
"Commit Homebrew" section in `vttprojectplan.md` is the full design.

- `items/<id>.json` — one file per published item, rewritten by every Commit
  (the app writes them straight to `main`; an unpublished or deleted item's
  file is removed). Every Ability and Action carries a `uid` that survives
  renames, edits and reorders.
- `automation.json` — written only by Claude's passes ("automate homebrew
  content"). Per item id, per part `uid`: the automation (an Ability's
  `rules`, an Action's `effect`, structured `cost`, `gates`, `limits`…), the
  `fingerprint` of the wording it was written for, and `basedOn`, the commit
  that wording came from. The app runs it on top of the live item, even after
  the wording changes (the wrench turns grey until the next pass).

`node scripts/homebrew-automation.mjs` prints the to-do list (new and changed
parts, with a word diff against `basedOn`); `stamp`, `prune` and `import` are
documented at the top of that script.
