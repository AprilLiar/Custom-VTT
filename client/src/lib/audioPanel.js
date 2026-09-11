// Opening the Audio Player from the spinning record.
//
// **A module-level registry rather than props, for the reason this codebase
// already solves twice** (see ticDropTarget.js's own note, and the two it
// names): the record lives in the global header strip and on the Scene stage,
// while the panel is owned by GmToolsWidget — all three are siblings mounted
// separately in App.jsx, so there is no parent to thread a handler through.
//
// Nothing is registered for a Player (GmToolsWidget renders null for them), so
// `openAudioPanel()` is a no-op there — which is exactly the behaviour wanted:
// their record is an indicator, not a button.
let opener = null;

export function registerAudioPanelOpener(fn) {
  opener = fn;
  // Guarded on identity: React can mount the next instance before unmounting
  // the previous one, and a blind clear would drop the live handler.
  return () => {
    if (opener === fn) opener = null;
  };
}

// `playlistId` lets the caller ask for a specific playlist — the record passes
// the playing song's, so tapping it lands on that song rather than wherever the
// panel was last left.
export function openAudioPanel(playlistId = null) {
  opener?.(playlistId);
}

export const audioPanelAvailable = () => opener != null;
