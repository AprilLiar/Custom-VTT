import { Clapperboard, Clock, Images, Map as MapIcon, StickyNote, Swords, Users, Wrench } from 'lucide-react';
import DialogShell from './DialogShell.jsx';
import SceneModeToggle from './SceneModeToggle.jsx';
import SceneListDrawer from './SceneListDrawer.jsx';
import SceneCastDrawer from './SceneCastDrawer.jsx';
import { CombatFightersDrawer, CombatMapDrawer } from './CombatDrawers.jsx';
import { InitiativeRail } from './FightControls.jsx';
import { gmTools } from '../lib/sceneFooter.js';

// **The GM's More sheet on a portrait phone (decided).** Everything a GM
// reaches on the landscape Scene page without a footer button of its own:
// the Scene / Simple Combat / Combat switch, Start Combat, the turn order
// (Next turn, Change sides, End Combat), the four drawers, Notes, Timestamps
// and GM Tools. The drawers open as sheets of their own; their landscape
// side-rail placement is overridden here rather than in each drawer.
const DRAWERS = {
  scenes: { title: 'Scenes', render: (p) => <SceneListDrawer activeSceneId={p.activeScene?.id ?? null} /> },
  cast: { title: 'Cast', render: () => <SceneCastDrawer /> },
  fighters: { title: 'Fighters', render: () => <CombatFightersDrawer /> },
  map: { title: 'Combat map', render: (p) => <CombatMapDrawer scene={p.activeScene} tokenCount={p.tokenCount} /> },
};

// **Below every ordinary dialog (z-50), above the footer (40).** A drawer
// opens its own dialogs from here — the Cast's art picker, the Scene editor —
// and those must land on top of this sheet, not under it (play feedback 11).
const SHEET_Z = 45;

// The drawers are `absolute` side rails, w-64, full height: here they fill the sheet instead.
const asSheet = '[&>div]:static! [&>div]:h-full! [&>div]:w-full! [&>div]:border-0! [&>div]:bg-transparent! [&>div]:p-0! [&>div]:pt-0!';

const tile =
  'flex min-h-14 flex-col items-center justify-center gap-1 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 font-display text-[11px] font-semibold uppercase tracking-wide text-zinc-200 active:border-brand-500';

export default function ScenePortraitMore({ sheet, setSheet, ...p }) {
  if (!sheet) return null;
  const close = () => setSheet(null);
  const drawer = DRAWERS[sheet];
  if (drawer) {
    return (
      <DialogShell title={drawer.title} onClose={close} dismissible closeButton zIndex={SHEET_Z} portal>
        <div className={`relative h-[70dvh] min-h-0 overflow-y-auto ${asSheet}`}>{drawer.render(p)}</div>
      </DialogShell>
    );
  }
  const isCombat = p.sceneMode === 'combat';
  const go = (fn) => () => {
    close();
    fn();
  };
  return (
    <DialogShell title="More" onClose={close} dismissible closeButton zIndex={SHEET_Z} portal>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {p.activeScene && <SceneModeToggle mode={p.sceneMode} inline />}
        {p.fightMode && !p.fight && p.activeScene && (
          <button type="button" onClick={go(p.onStartCombat)} className="flex min-h-11 items-center justify-center gap-2 panel-cut-sm border border-brand-500 bg-brand-600 font-display text-sm font-bold uppercase tracking-wide text-white">
            <Swords size={16} aria-hidden /> Start Combat
          </button>
        )}
        {p.fight && <InitiativeRail inline mode={p.fightMode} fight={p.fight} fighters={p.fighters} role="gm" weight={p.weight} onEditSides={go(p.onEditSides)} />}
        <div className="grid grid-cols-3 gap-2">
          {isCombat ? (
            <>
              <button type="button" className={tile} onClick={() => setSheet('fighters')}>
                <Users size={16} aria-hidden /> Fighters
              </button>
              <button type="button" className={tile} onClick={() => setSheet('map')}>
                <MapIcon size={16} aria-hidden /> Map
              </button>
            </>
          ) : (
            <>
              <button type="button" className={tile} onClick={() => setSheet('scenes')}>
                <Images size={16} aria-hidden /> Scenes
              </button>
              <button type="button" className={tile} onClick={() => setSheet('cast')}>
                <Clapperboard size={16} aria-hidden /> Cast
              </button>
            </>
          )}
          <button type="button" className={tile} onClick={go(p.onOpenNotes)}>
            <StickyNote size={16} aria-hidden /> Notes
          </button>
          <button type="button" className={tile} onClick={go(p.onOpenTimestamps)}>
            <Clock size={16} aria-hidden /> Timestamps
          </button>
          <button type="button" className={tile} onClick={go(() => gmTools.trigger())}>
            <Wrench size={16} aria-hidden /> GM Tools
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
