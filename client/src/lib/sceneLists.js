import { liveList } from './liveList.js';
import { getCharacterFolders, getCharacters, getSceneFolders, getScenes, getTempNpcFolders, getTempNpcs } from './api.js';

// **The Scene tab's lists, kept for the session (play feedback 8).** Loaded
// once when first shown, then kept live by their socket events, so opening or
// closing a drawer — or hiding the interface — never reloads them.
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));

// The GM's Scene list (`{ role: 'gm' }`: with each Scene's Timestamp cue).
export const useSceneList = liveList({
  load: () => getScenes({ role: 'gm' }),
  upsert: ['scene:created', 'scene:updated'],
  remove: [['scene:deleted', 'sceneId']],
  // A folder deleted moves its Scenes up a level.
  refetch: ['scene_folder:deleted'],
  sort: byName,
});

// Folders: rows on create / rename; a delete moves things, so it reloads.
export const useSceneFolders = liveList({ load: getSceneFolders, upsert: ['scene_folder:created', 'scene_folder:updated'], refetch: ['scene_folder:deleted'], sort: byName });
export const useCharacterFolders = liveList({ load: getCharacterFolders, upsert: ['character_folder:created', 'character_folder:updated'], refetch: ['character_folder:deleted'], sort: byName });
export const useTempNpcFolders = liveList({ load: getTempNpcFolders, upsert: ['temp_npc_folder:created', 'temp_npc_folder:updated'], refetch: ['temp_npc_folder:deleted'], sort: byName });

export const useTempNpcList = liveList({
  load: getTempNpcs,
  upsert: ['temp_npc:created', 'temp_npc:updated'],
  remove: [['temp_npc:deleted', 'tempNpcId']],
  refetch: ['temp_npc_folder:deleted'],
  sort: byName,
});

// Every character (the roster): `character:updated` may carry only the
// changed fields, so it merges; a new one reloads (its row comes shaped by
// the list endpoint).
export const useCharacterList = liveList({
  load: getCharacters,
  upsert: ['character:updated'],
  merge: true,
  remove: [['character:deleted', 'id']],
  refetch: ['character:created', 'character_folder:deleted'],
  sort: (a, b) => a.id - b.id,
});
