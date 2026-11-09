import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wrench, X, Music, ImageDown, Scale, GitCommitHorizontal } from 'lucide-react';
import { useRole } from '../roleContext.jsx';
import AudioPlayerDialog from './AudioPlayerDialog.jsx';
import ImageReencodeTool from './ImageReencodeTool.jsx';
import CombatWeightTool from './CombatWeightTool.jsx';
import CommitHomebrewTool from './CommitHomebrewTool.jsx';
import { registerAudioPanelOpener } from '../lib/audioPanel.js';

// GM Tools (decided, new) — a small circular widget the GM can reach from
// anywhere in the app, overlaid above every page's own content. Opening it
// darkens and blurs everything behind, so the tool sheet is unambiguously
// "the thing you're using now" rather than another panel competing with the
// page underneath.
//
// The tool list is deliberately a list, not a single button, so the next tool
// is one more entry: Combat Weight, the Audio Player, Re-encode Images and
// Commit Homebrew. (The Roll Requester and Fight Pauses went with the old
// system: one asked a player to roll one of their eight Stat dice, the other
// re-summoned a paused fight.)
//
// GM-only, client-side — the same trust model as every other GM-only control
// in this app; hiding the widget is a convenience, not the boundary.

const TOOLS = [
  {
    // Panic at the Dojo: the fight's Cinematic Weight, levels and HP. Works on
    // the Scene page in Simple Combat or Combat; says so anywhere else.
    id: 'combat-weight',
    name: 'Preset Narrative Combat Weight',
    blurb: 'Pick the fight\u2019s weight class and everyone\u2019s level: HP, Heal and Bleed for this fight.',
    icon: Scale,
    render: (props) => <CombatWeightTool {...props} />,
  },
  {
    // **`standalone` means "open instead of the drawer, not inside it".** The
    // drawer's own scrim is z-[1100] (above the Scene page's z-1000 controls) and DialogShell is z-50, so a fullscreen
    // dialog rendered inside this sheet would be painted underneath it. The
    // Audio Player wants the whole screen anyway — playlists beside tracks —
    // which is the same call Notes and Timestamps already make.
    id: 'audio-player',
    name: 'Audio Player',
    blurb: 'Run the table\u2019s music. Everyone hears the same song at the same moment.',
    icon: Music,
    standalone: true,
  },
  {
    // Renders inside the drawer like the other tools: it is a progress bar and
    // two buttons, not a workspace, so it has no need of the whole screen.
    id: 'reencode-images',
    name: 'Re-encode Images',
    blurb: 'Shrink every stored picture to WebP. Run once after a batch of uploads.',
    icon: ImageDown,
    render: (props) => <ImageReencodeTool {...props} />,
  },
  {
    // The homebrew → core pipeline: see CommitHomebrewTool and the plan's
    // "Commit Homebrew".
    id: 'commit-homebrew',
    name: 'Commit Homebrew',
    blurb: 'Snapshot your published homebrew into the game\u2019s core on GitHub, for Claude to automate.',
    icon: GitCommitHorizontal,
    render: (props) => <CommitHomebrewTool {...props} />,
  },
];

export default function GmToolsWidget() {
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const [toolId, setToolId] = useState(null);
  // A standalone tool replaces the drawer rather than rendering inside it.
  const [audioOpen, setAudioOpen] = useState(false);

  // The spinning now-playing record opens this panel, from wherever it happens
  // to be rendered — see lib/audioPanel.js for why that is a registry.
  useEffect(() => {
    if (role !== 'gm') return undefined;
    return registerAudioPanelOpener(() => {
      setOpen(false);
      setToolId(null);
      setAudioOpen(true);
    });
  }, [role]);

  // Escape closes whatever layer is on top: the tool first, then the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (toolId) setToolId(null);
      else setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, toolId]);

  if (role !== 'gm') return null;

  const tool = TOOLS.find((t) => t.id === toolId && !t.standalone) ?? null;

  const close = () => {
    setToolId(null);
    setOpen(false);
  };

  return (
    <>
      {audioOpen && <AudioPlayerDialog onClose={() => setAudioOpen(false)} />}

      <AnimatePresence>
        {open && (
          <motion.div
            key="gm-tools-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            // The blur is the point: it puts the page behind out of focus
            // rather than merely dimming it, so the tool sheet reads as a
            // mode you're in, not a panel floating over a live page.
            className="fixed inset-0 z-[1100] flex items-end justify-center bg-black/70 backdrop-blur-sm md:items-center md:p-4"
            onClick={close}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              // See DialogShell: added to p-4's 1rem, not replacing it.
              style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}
              className="flex max-h-[88dvh] w-full max-w-lg flex-col gap-3 rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 md:rounded-none md:panel-cut-lg"
            >
              <div className="flex shrink-0 items-center gap-2">
                <h3 className="font-display font-bold uppercase tracking-wide text-zinc-100">
                  {tool ? tool.name : 'GM Tools'}
                </h3>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close GM tools"
                  className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-500 hover:text-zinc-200 md:h-8 md:w-8"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {tool ? (
                  tool.render({ onDone: close })
                ) : (
                  <div className="flex flex-col gap-2">
                    {TOOLS.map(({ id, name, blurb, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          const picked = TOOLS.find((t) => t.id === id);
                          if (picked?.standalone) {
                            setOpen(false);
                            setToolId(null);
                            if (id === 'audio-player') setAudioOpen(true);
                            return;
                          }
                          setToolId(id);
                        }}
                        className="flex min-h-11 items-center gap-3 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-left hover:border-brand-500"
                      >
                        <Icon size={20} className="shrink-0 text-brand-400" />
                        <span>
                          <span className="block font-display text-sm font-semibold text-zinc-100">
                            {name}
                          </span>
                          <span className="block text-xs text-zinc-500">{blurb}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {tool && (
                <button
                  type="button"
                  onClick={() => setToolId(null)}
                  className="shrink-0 self-start border-t border-zinc-800 pt-2 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  ← All GM tools
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Always visible, on every page — a GM shouldn't have to navigate
          somewhere to reach a GM tool. Sits clear of the mobile bottom nav's
          safe area. z-[45] puts it above the mobile chat overlay (z-40, where
          it's still useful) but below any modal dialog (z-50): a dialog is a
          decision you're in the middle of, and a button floating over it
          reads as part of it. */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.92 }}
        onClick={() => setOpen((v) => !v)}
        aria-label="GM tools"
        title="GM tools"
        style={{ bottom: 'calc(var(--safe-bottom) + 4.5rem)' }}
        className="fixed right-4 z-[45] flex h-12 w-12 items-center justify-center rounded-full border border-brand-500/60 bg-brand-700/90 text-zinc-100 shadow-lg shadow-black/50 hover:bg-brand-600 md:bottom-6 md:h-14 md:w-14"
      >
        <Wrench size={20} />
      </motion.button>
    </>
  );
}
