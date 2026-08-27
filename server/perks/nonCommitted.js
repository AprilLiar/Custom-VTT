// **Non-Committed** — the `interruptsOwnDeclarations` seam, and the only Perk
// that stops the round rather than changing a number inside it.
//
// "After everyone has finished their declaration phase, before any Move is
// Revealed, you can Interrupt any of your own moves, gaining back the spent
// Stamina and making those Frames Unoccupied."
//
// **The window is the mechanic.** Declaration is blind — you commit before you
// know what is coming — and this Perk buys back the one thing that costs: the
// right to change your mind once the board is set but before anyone has seen
// anything. It is not information (nothing has revealed), it is nerve.
//
// Implemented as a fifth pause on the pair's own resolution row
// (`paused_noncommit`), at the head of the round, before the first reveal — the
// same architecture the Dodge, conflict, Block and grapple prompts already use,
// so it inherits the crash-recovery and reconnect behaviour those have rather
// than inventing a parallel one.
//
// **Cancelling refunds in full and frees the Tics, but nothing slides earlier**
// (decided). That last part is the engine's standing rule — a shortened window
// never pulls later moves forward, because nothing should arrive earlier than
// it was thrown — and this is the same rule, not an exception to it. The freed
// Tics still matter: they are unoccupied, so they no longer floor where this
// character may place next round.
//
// A boolean seam, OR-ed: two Perks granting the window grant the same window.
export default {
  name: 'Non-Committed',
  description:
    'After everyone has finished their declaration phase, before any Move is Revealed, you can Interrupt any of your own moves, gaining back the spent Stamina and making those Frames Unoccupied.',

  interruptsOwnDeclarations: () => true,
};
