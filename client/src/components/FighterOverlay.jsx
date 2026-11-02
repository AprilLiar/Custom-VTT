import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Minus, Plus, X } from 'lucide-react';
import { GiDeathSkull, GiSleepy } from 'react-icons/gi';
import { socket } from '../socket.js';
import { TOKEN_BY_KEY, TOKEN_CAP, tokensFor } from '../lib/panicTokens.js';
import { KIND_CLASS, TokenIcon } from '../lib/panicIcons.jsx';
import { HP_MAX, barsLeft, isTakenOut } from '../lib/hpBars.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';

// Everything drawn around one fighter in a fight (Panic at the Dojo, Phase 4),
// shared by the Combat map's tokens and Simple Combat's miniatures.
//
//   - Always: every token with a count above the fighter (red count badge in
//     the icon's bottom-right quarter), the Challenge they hold (the
//     Challenger's portrait, half-transparent), a compact HP bar stack under
//     them (decided: visible to everyone), and the Dizzy / Taken Out marks.
//   - When selected: the full panel — the whole token row with + / − / −− for
//     the one opened icon, the Challenge picker, the HP bar with − and + at its
//     ends and the golden + under it, Max HP, and the Stance switch.
//
// `anchor` is the fighter's box in stage pixels: { x (centre), top, bottom }.
// `fighterRef` is the server ref ({ combatantId } or { summonId }).
// `candidates`: the other fighters this one may Challenge, [{ key, ref, name,
// image_url, crop, combatantId }]. `challenger`: the one they hold, resolved.

const BADGE_RED = '#ef1d1d';

const cropFrom = (c) => (c ? cropOf({ crop_x: c.x, crop_y: c.y, crop_w: c.w, crop_h: c.h }) : null);

function Portrait({ fighter, className }) {
  if (!fighter) return null;
  return fighter.image_url ? (
    <CroppedImage src={fighter.image_url} crop={cropFrom(fighter.crop)} alt={fighter.name} className={className} draggable={false} />
  ) : (
    <span className={`flex items-center justify-center bg-zinc-700 text-[10px] font-bold uppercase text-zinc-200 ${className}`}>
      {(fighter.name ?? '?').slice(0, 1)}
    </span>
  );
}

// One token icon with its count badge.
function CountedIcon({ tokenKey, count, size, dim = false, active = false, onClick, disabled, title }) {
  const def = TOKEN_BY_KEY[tokenKey];
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      title={title ?? def?.name}
      className={`relative flex shrink-0 items-center justify-center rounded-md border bg-zinc-950/85 ${
        onClick ? 'pointer-events-auto' : ''
      } ${
        active ? 'border-yellow-400' : 'border-zinc-700'
      } ${dim ? 'opacity-50' : ''}`}
      style={{ width: size, height: size }}
    >
      <TokenIcon tokenKey={tokenKey} className={`h-[72%] w-[72%] ${KIND_CLASS[def?.kind] ?? 'text-zinc-200'}`} />
      {count > 0 && (
        <span
          className="absolute bottom-0 right-0 flex items-center justify-center rounded-sm font-black leading-none text-white"
          style={{
            width: size / 2,
            height: size / 2,
            fontSize: size * 0.42,
            background: BADGE_RED,
            boxShadow: '0 0 0 1px black',
          }}
        >
          {count}
        </span>
      )}
    </Tag>
  );
}

// The stacked bars. `compact` is the always-on strip; otherwise the full bar
// with its buttons. A bar breaking plays a shatter, and the next bar slides up.
// `weight`: the fight's Cinematic Weight (cinematicWeight.js), or null.
function HpStack({ hp, compact, width, canEdit, fighterRef, weight = null }) {
  const left = barsLeft(hp);
  const behind = Math.max(0, left - 1);
  const pct = hp.max ? (hp.current / hp.max) * 100 : 0;
  const [shatter, setShatter] = useState(0);
  const prevBroken = useRef(hp.broken);
  useEffect(() => {
    if (hp.broken > prevBroken.current) setShatter((n) => n + 1);
    prevBroken.current = hp.broken;
  }, [hp.broken]);
  const barH = compact ? 6 : 18;
  const emit = (event, extra = {}) => socket.emit(event, { ref: fighterRef, ...extra });
  const tone = pct > 50 ? 'bg-emerald-500' : pct > 25 ? 'bg-amber-400' : 'bg-red-500';

  return (
    <div className="relative" style={{ width }}>
      {/* The bars behind: each peeks out below the one in front by half its height. */}
      {Array.from({ length: Math.min(behind, 6) }, (_, i) => (
        <div
          key={i}
          className="absolute inset-x-0 rounded-sm border border-black bg-emerald-800"
          style={{ top: (i + 1) * (barH / 2), height: barH, zIndex: -1 - i, opacity: 0.85 - i * 0.1 }}
        />
      ))}
      <div className="relative flex items-center" style={{ height: barH }}>
        {!compact && canEdit && (
          <button
            type="button"
            onClick={() => emit('fighter:hp', { delta: -1 })}
            disabled={hp.max == null}
            className="z-10 -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-zinc-200 hover:border-red-500 disabled:opacity-40"
            aria-label="Minus 1 HP"
          >
            <Minus size={14} aria-hidden />
          </button>
        )}
        <div className="relative h-full flex-1 overflow-hidden rounded-sm border border-black bg-zinc-900/90">
          <motion.div
            key={hp.broken}
            initial={hp.broken > 0 ? { y: barH / 2, opacity: 0.4 } : false}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className={`h-full ${tone}`}
            style={{ width: `${pct}%`, transition: 'width 200ms ease-out' }}
          />
          {/* **The Bleed zone (decided):** the last part of the bar — HP at or
              below the fight's Bleed Value — in purple, so the table sees how
              close a fighter is to Bleeding. A faint band where it is empty,
              solid purple over the HP still in it, and a line at its edge. */}
          {weight && hp.max != null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 left-0 bg-purple-500/25"
                style={{ width: `${(Math.min(weight.bleed, hp.max) / hp.max) * 100}%` }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 left-0 bg-purple-500"
                style={{ width: `${(Math.min(hp.current, weight.bleed) / hp.max) * 100}%`, transition: 'width 200ms ease-out' }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-purple-200/80"
                style={{ left: `${(Math.min(weight.bleed, hp.max) / hp.max) * 100}%` }}
              />
            </>
          )}
          {!compact && (
            <span className="absolute inset-0 flex items-center justify-center font-display text-xs font-bold tabular-nums text-white [text-shadow:0_1px_2px_black]">
              {hp.max == null ? 'Set Max HP' : `${hp.current} / ${hp.max}`}
            </span>
          )}
        </div>
        {!compact && canEdit && (
          <button
            type="button"
            onClick={() => emit('fighter:hp', { delta: 1 })}
            disabled={hp.max == null}
            className="z-10 -ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-zinc-200 hover:border-emerald-500 disabled:opacity-40"
            aria-label="Plus 1 HP"
          >
            <Plus size={14} aria-hidden />
          </button>
        )}
        {/* The shatter: the broken bar splits in two and falls away. */}
        <AnimatePresence>
          {shatter > 0 && (
            <motion.div key={shatter} className="pointer-events-none absolute inset-0" exit={{ opacity: 0 }}>
              {[-1, 1].map((side) => (
                <motion.div
                  key={side}
                  className="absolute top-0 h-full w-1/2 rounded-sm bg-red-500"
                  style={{ left: side < 0 ? 0 : '50%' }}
                  initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                  animate={{ x: side * 18, y: 16, rotate: side * 18, opacity: 0 }}
                  transition={{ duration: 0.6, ease: 'easeIn' }}
                  onAnimationComplete={() => side > 0 && setShatter(0)}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {compact && left > 1 && (
        <span className="absolute -right-4 top-1/2 -translate-y-1/2 text-[9px] font-bold text-zinc-300 [text-shadow:0_1px_2px_black]">
          ×{left}
        </span>
      )}
      {!compact && <div style={{ height: (Math.min(behind, 6) * barH) / 2 }} />}
    </div>
  );
}

function FullPanelHp({ hp, canEdit, fighterRef, width, weight = null }) {
  const [maxDraft, setMaxDraft] = useState(hp.max ?? '');
  useEffect(() => setMaxDraft(hp.max ?? ''), [hp.max]);
  const emit = (event, extra = {}) => socket.emit(event, { ref: fighterRef, ...extra });
  return (
    <div className="flex flex-col items-center gap-1.5">
      <HpStack hp={hp} width={width} canEdit={canEdit} fighterRef={fighterRef} weight={weight} />
      {canEdit && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => emit('fighter:add_bar')}
            title="Add another HP bar (same Max HP)"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-amber-400 bg-amber-500/20 text-amber-300 hover:bg-amber-500/40"
            aria-label="Add an HP bar"
          >
            <Plus size={16} strokeWidth={3} aria-hidden />
          </button>
          {/* Heal by the fight's Heal Value (healing that names no number). */}
          {weight && (
            <button
              type="button"
              onClick={() => emit('fighter:heal')}
              disabled={hp.max == null}
              title={`Heal ${weight.heal} (the ${weight.name} Heal Value)`}
              className="h-7 rounded-full border border-emerald-500 bg-emerald-500/15 px-2 font-display text-[11px] font-bold uppercase text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40"
            >
              Heal +{weight.heal}
            </button>
          )}
          {barsLeft(hp) > 1 && (
            <button
              type="button"
              onClick={() => emit('fighter:remove_bar')}
              title="Remove a bar from the back of the stack"
              className="text-[10px] text-zinc-400 hover:text-red-400"
            >
              −bar
            </button>
          )}
          <label className="flex items-center gap-1 text-[10px] uppercase text-zinc-400">
            Max
            <input
              type="number"
              min={1}
              max={HP_MAX}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={() => maxDraft !== '' && Number(maxDraft) !== hp.max && emit('fighter:set_hp', { max: Number(maxDraft) })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="h-7 w-12 rounded-sm border border-zinc-700 bg-zinc-900 px-1 text-center text-xs tabular-nums text-zinc-100 outline-none focus:border-brand-500"
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default function FighterOverlay({
  name,
  fight,
  setup,
  anchor,
  iconSize = 22,
  selected = false,
  canEdit = false,
  fighterRef,
  candidates = [],
  challenger = null,
  onClose,
  bounds = null,
  weight = null,
}) {
  const panelRef = useRef(null);
  const belowRef = useRef(null);
  // **An open panel never leaves the screen (decided, mobile fix).** The row
  // above the fighter and the panel below it move as ONE: if either would
  // cross an edge of the stage (`bounds`), both shift by the same distance,
  // so the gap between them — and the fighter they belong to — stays as it
  // is. Measured after layout, and again whenever their content changes size
  // (opening a token adds its buttons).
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!selected || !bounds) {
      setShift((s) => (s.x || s.y ? { x: 0, y: 0 } : s));
      return undefined;
    }
    const measure = () => {
      const above = panelRef.current;
      const below = belowRef.current;
      if (!above || !below) return;
      const margin = 8;
      const top = anchor.top - 4 - above.offsetHeight;
      const bottom = anchor.bottom + 4 + below.offsetHeight;
      let y = 0;
      if (bottom > bounds.height - margin) y = bounds.height - margin - bottom;
      if (top + y < margin) y = margin - top;
      const half = Math.max(above.offsetWidth, below.offsetWidth) / 2;
      let x = 0;
      if (anchor.x + half > bounds.width - margin) x = bounds.width - margin - (anchor.x + half);
      if (anchor.x - half + x < margin) x = margin - (anchor.x - half);
      setShift((s) => (Math.abs(s.x - x) < 0.5 && Math.abs(s.y - y) < 0.5 ? s : { x, y }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panelRef.current) observer.observe(panelRef.current);
    if (belowRef.current) observer.observe(belowRef.current);
    return () => observer.disconnect();
  }, [selected, bounds?.width, bounds?.height, anchor.x, anchor.top, anchor.bottom]);
  const blockTransform = `translate(calc(-50% + ${selected ? shift.x : 0}px), ${selected ? shift.y : 0}px)`;
  const [openKey, setOpenKey] = useState(null);
  const [pickingChallenge, setPickingChallenge] = useState(false);
  useEffect(() => {
    if (!selected) {
      setOpenKey(null);
      setPickingChallenge(false);
    }
  }, [selected]);

  // A click anywhere that is not this panel or a fighter closes it.
  useEffect(() => {
    if (!selected) return undefined;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || belowRef.current?.contains(e.target)) return;
      if (e.target.closest?.('[data-combat-token],[data-lane-mini]')) return;
      onClose?.();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [selected, onClose]);

  const hp = fight.hp;
  const takenOut = isTakenOut(hp);
  const held = Object.entries(fight.tokens).filter(([, n]) => n > 0);
  const allTokens = tokensFor(setup?.unique_tokens ?? []);
  const emit = (event, extra = {}) => socket.emit(event, { ref: fighterRef, ...extra });
  const barWidth = Math.max(56, iconSize * 3.2);
  // The open panel is for clicking, so its icons never shrink with the map.
  const rowIcon = selected ? Math.max(iconSize, 28) : iconSize;
  const stances = setup?.stances ?? [];
  const activeStance = fight.active_stance_id ?? stances[0]?.id ?? null;

  return (
    <>
      {/* Dizzy / Taken Out over the fighter itself. */}
      {(hp.dizzy || takenOut) && (
        <div
          className="pointer-events-none absolute flex items-center justify-center"
          style={{
            left: anchor.x - iconSize,
            top: (anchor.top + anchor.bottom) / 2 - iconSize,
            width: iconSize * 2,
            height: iconSize * 2,
            zIndex: 40,
          }}
        >
          {takenOut ? (
            <GiDeathSkull className="h-full w-full text-zinc-100 opacity-80 drop-shadow-[0_0_4px_black]" title="Taken Out" />
          ) : (
            <motion.span
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
              className="h-full w-full"
            >
              <GiSleepy className="h-full w-full text-sky-200 drop-shadow-[0_0_4px_black]" title="Dizzy" />
            </motion.span>
          )}
        </div>
      )}

      {/* Above: held tokens and the Challenge (always), or the full row (panel). */}
      <div
        ref={panelRef}
        className={`absolute flex flex-col items-center ${selected ? 'pointer-events-auto' : 'pointer-events-none'}`}
        style={{ left: anchor.x, bottom: `calc(100% - ${anchor.top - 4}px)`, zIndex: selected ? 60 : 35, transform: blockTransform }}
      >
        {selected && openKey && (
          <span className="mb-1 rounded-sm bg-zinc-950/90 px-1.5 py-0.5 font-display text-[11px] font-bold uppercase tracking-wide text-zinc-100">
            {TOKEN_BY_KEY[openKey]?.name}
          </span>
        )}
        <div className={`flex items-end gap-1 ${selected ? 'rounded-md border border-zinc-700 bg-zinc-950/85 p-1' : ''}`}>
          {(selected ? allTokens.map((t) => [t.key, fight.tokens[t.key] ?? 0]) : held).map(([key, count]) => (
            <div key={key} className="flex flex-col items-center">
              <CountedIcon
                tokenKey={key}
                count={count}
                size={rowIcon}
                active={selected && openKey === key}
                dim={selected && !count}
                // **A quick spend (decided):** with the panel closed, clicking
                // a held token takes one off — the same as its "−" — since
                // tokens are spent far more often than they are gained.
                onClick={
                  selected
                    ? () => setOpenKey((k) => (k === key ? null : key))
                    : canEdit
                      ? (e) => {
                          e.stopPropagation();
                          emit('fighter:token', { key, delta: -1 });
                        }
                      : undefined
                }
                title={!selected && canEdit ? `Spend 1 ${TOKEN_BY_KEY[key]?.name}` : undefined}
              />
            </div>
          ))}
          {/* The Challenge slot. */}
          {(selected || fight.challenge_id != null) && (
            <div className="relative">
              <button
                type="button"
                disabled={!selected || !canEdit}
                onClick={() => setPickingChallenge((v) => !v)}
                title={challenger ? `${challenger.name}'s Challenge` : 'Challenge'}
                className={`flex items-center justify-center overflow-hidden rounded-full border-2 ${
                  challenger ? 'border-red-500' : 'border-dashed border-zinc-500 bg-zinc-950/80'
                } ${selected ? '' : 'opacity-60'}`}
                style={{ width: rowIcon, height: rowIcon }}
              >
                {challenger && <Portrait fighter={challenger} className="h-full w-full rounded-full" />}
              </button>
              {selected && pickingChallenge && (
                <div className="absolute left-full top-0 z-10 ml-1 max-h-56 w-44 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950/95 p-1 shadow-xl">
                  <p className="px-1 pb-1 text-[10px] font-bold uppercase text-zinc-500">Challenged by</p>
                  {candidates.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => {
                        emit('fighter:challenge', { target: c.ref });
                        setPickingChallenge(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      <Portrait fighter={c} className="h-6 w-6 shrink-0 rounded-full" />
                      <span className="truncate">{c.name}</span>
                    </button>
                  ))}
                  {fight.challenge_id != null && (
                    <button
                      type="button"
                      onClick={() => {
                        emit('fighter:challenge', { target: null });
                        setPickingChallenge(false);
                      }}
                      className="mt-1 w-full rounded-sm px-1 py-1 text-left text-xs text-red-400 hover:bg-zinc-800"
                    >
                      Remove Challenge
                    </button>
                  )}
                  {candidates.length === 0 && <p className="px-1 text-xs italic text-zinc-500">Nobody else here.</p>}
                </div>
              )}
            </div>
          )}
        </div>
        {selected && openKey && canEdit && (
          <div className="mt-1 flex gap-1">
            {[
              ['+', { delta: 1 }, 'Add 1', (fight.tokens[openKey] ?? 0) >= TOKEN_CAP],
              ['−', { delta: -1 }, 'Remove 1', !(fight.tokens[openKey] > 0)],
              ['−−', { clear: true }, 'Remove all', !(fight.tokens[openKey] > 0)],
            ].map(([label, payload, title, disabled]) => (
              <button
                key={label}
                type="button"
                title={title}
                disabled={disabled}
                onClick={() => emit('fighter:token', { key: openKey, ...payload })}
                className="h-7 min-w-8 rounded-sm border border-zinc-600 bg-zinc-900 px-1.5 font-display text-sm font-bold text-zinc-100 hover:border-brand-500 disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Below: the compact HP stack (always), or the full HP panel. */}
      <div
        className={`absolute flex flex-col items-center gap-1 ${selected ? 'pointer-events-auto' : 'pointer-events-none'}`}
        style={{ left: anchor.x, top: anchor.bottom + 4, zIndex: selected ? 60 : 35, transform: blockTransform }}
        ref={belowRef}
      >
        {selected ? (
          <div data-fighter-panel className="flex flex-col items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-950/90 p-2 shadow-xl">
            <div className="flex w-full items-center justify-between gap-2">
              <span className="max-w-[10rem] truncate font-display text-xs font-bold uppercase tracking-wide text-zinc-100">
                {name}
              </span>
              <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-100" aria-label="Close">
                <X size={14} aria-hidden />
              </button>
            </div>
            <FullPanelHp hp={hp} canEdit={canEdit} fighterRef={fighterRef} width={Math.max(140, barWidth * 1.6)} weight={weight} />
            {hp.dizzy && canEdit && (
              <button type="button" onClick={() => emit('fighter:clear_dizzy')} className="text-[10px] text-sky-300 hover:text-sky-100">
                Clear Dizzy
              </button>
            )}
            {stances.length > 0 && (
              <label className="flex items-center gap-1 text-[10px] uppercase text-zinc-400">
                Stance
                <select
                  value={activeStance ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => emit('fighter:set_stance', { stanceId: Number(e.target.value) })}
                  className="h-7 rounded-sm border border-zinc-700 bg-zinc-900 px-1 text-xs normal-case text-zinc-100 outline-none focus:border-brand-500"
                >
                  {stances.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          hp.max != null && <HpStack hp={hp} compact width={barWidth} weight={weight} />
        )}
      </div>
    </>
  );
}

// A Challenge's reminder: a few faint red sparks drifting from the fighter
// holding it towards their Challenger. `from`/`to` in stage pixels.
export function ChallengeSparks({ from, to }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return (
    <>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="challenge-spark pointer-events-none absolute rounded-full"
          style={{
            left: from.x - 2.5 + (i - 1) * 4,
            top: from.y - 2.5,
            width: 5,
            height: 5,
            background: 'rgba(239, 68, 68, 0.7)',
            boxShadow: '0 0 6px rgba(239, 68, 68, 0.6)',
            zIndex: 34,
            opacity: 0,
            '--dx': `${dx}px`,
            '--dy': `${dy}px`,
            animation: `challenge-drift 3.2s linear ${i * 1.1}s infinite`,
          }}
        />
      ))}
    </>
  );
}
