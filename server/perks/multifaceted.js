// **Multifaceted** — deliberately NOT automated, and registered anyway.
//
// It lets a character build a second Stance, and `stance:create` has never
// counted them: the limit of one is a rule the table keeps, not one the server
// enforces. There is genuinely nothing for the engine to do, and adding an
// enforcement path just so this Perk could switch it off would be building a
// cage in order to sell the key.
//
// `manual: true` says exactly that. It is the one metadata key that changes
// nothing at runtime — every seam resolver skips a definition that has no
// function for its seam, so this contributes to none of them — and its whole
// job is to let the Perk be *accounted for*: it gets seeded into the compendium,
// it gets the ⚙ badge so it reads as handled rather than forgotten, and
// perk:update refuses to rename it out from under this file.
//
// server/test/perkRegistry.test.js asserts that a `manual` Perk declares no seam
// and no lifecycle hook, so the flag can never quietly end up on a Perk that
// does something.
export default {
  name: 'Multifaceted',
  description:
    'You are not one fighter but two. You may build and keep a second Stance, switching between them as any fighter switches Stance.',

  manual: true,
};
