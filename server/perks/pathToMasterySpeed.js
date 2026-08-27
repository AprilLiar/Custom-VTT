// **Path To Mastery: Speed** — one line, on a seam that already existed.
//
// "All your moves gain -1 to Startup."
//
// Every move, not just attacks: a guard that comes up a Tic sooner is the same
// mastery as a punch that lands a Tic sooner, and the Perk does not qualify
// itself. `effectiveFrames` clamps each segment to 0..FRAME_MAX, so a move
// already at 1 Startup goes to 0 and no further — it comes out the instant it
// is placed, with no wind-up to read, which is exactly what the last step of
// speed should buy and is a shape the engine already handles.
//
// It rides `moveFrameDelta`, so the shorter footprint is visible in the declare
// picker *before* the move is placed and floors the next declaration correctly
// — it is a frame, not a number applied at resolution.
export default {
  name: 'Path To Mastery: Speed',
  description: 'All your moves gain -1 to Startup.',

  moveFrameDelta: () => ({ startup: -1 }),
};
