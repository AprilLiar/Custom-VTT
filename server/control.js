// **Who controls a character (decided, new): NPCs assigned to a player.**
//
// A Player is the PC they picked at the door. By default an NPC belongs to the
// GM alone. The GM can assign an NPC to a player (`characters.assigned_to` =
// that player's PC id), and from then on that player controls it exactly as
// they control their own character: its sheet, Combat setup, Scene Pictures,
// summons, map tokens, fight state and stance picks.
//
// Every server-side write gate asks `controlsCharacter`. It must stay
// synchronous, because those gates are plain predicates, so the assignments are
// mirrored in memory: loaded once at boot and updated by every write that
// changes them. One server process holds the only copy (single Render instance).
const assignedTo = new Map(); // npc id → pc id

export async function loadAssignments(all) {
  assignedTo.clear();
  const rows = await all('SELECT id, assigned_to FROM characters WHERE assigned_to IS NOT NULL');
  for (const r of rows) assignedTo.set(Number(r.id), Number(r.assigned_to));
}

export function setAssignment(characterId, pcId) {
  if (pcId == null) assignedTo.delete(Number(characterId));
  else assignedTo.set(Number(characterId), Number(pcId));
}

// The NPCs a deleted PC controlled go back to the GM.
export function dropAssignmentsTo(pcId) {
  const freed = [];
  for (const [npc, pc] of assignedTo) {
    if (pc === Number(pcId)) {
      assignedTo.delete(npc);
      freed.push(npc);
    }
  }
  return freed;
}

// True when this viewer may act for this character: the GM always; a Player for
// their own PC and for every NPC assigned to them.
export function controlsCharacter(viewer, characterId) {
  if (!viewer) return false;
  if (viewer.role === 'gm') return true;
  if (viewer.role !== 'player' || characterId == null) return false;
  const id = Number(characterId);
  return viewer.characterId === id || assignedTo.get(id) === viewer.characterId;
}
