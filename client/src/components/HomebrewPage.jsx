import { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { socket } from '../socket.js';
import { useRole } from '../roleContext.jsx';
import { useBookContent, useContent, useHomebrewState } from '../lib/patd/useContent.js';
import { abilityFingerprint, actionFingerprint, partState, wrenchState } from '../lib/patd/homebrewSync.js';
import HomebrewWrench, { WrenchLegend } from './HomebrewWrench.jsx';
import {
  DIE_COLORS,
  DIE_SIDES,
  HOMEBREW_TOKENS,
  MOMENTS,
  OTHER_SKILL,
  STEP_KINDS,
  VARIANT_KEYS,
  WHO,
  copyFromBook,
  describeSpec,
  newUid,
} from '../lib/patd/homebrew.js';
import { DiceRow, cardClass, rangeText, selectClass } from './builder/BuildParts.jsx';

// **The homebrew builder (GM only — vttprojectplan.md, "Homebrew builder").**
// The GM's own Forms, Styles and Archetypes, each with Abilities (written with
// a simple rule editor, so they run as turn triggers) and Actions (reference
// only). New items start as drafts; publishing offers them in every player's
// builder. "Copy from book" starts from a book entry. The wrench by each item
// (HomebrewWrench) is its automation state — see "Commit Homebrew" in the plan.

const KIND_LABEL = { form: 'Form', style: 'Style', archetype: 'Archetype' };
const inputClass = 'min-h-9 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500';
const smallBtn = 'min-h-9 panel-cut-sm border border-zinc-700 px-2.5 text-xs text-zinc-200 hover:border-zinc-500';
const tokenName = (k) => HOMEBREW_TOKENS.find((t) => t.key === k)?.name ?? k;

const blank = (kind) => ({
  kind,
  name: `New ${KIND_LABEL[kind]}`,
  descriptionText: '',
  published: false,
  abilities: [],
  actions: [],
  ...(kind === 'form'
    ? {
        aliases: [],
        actionDice: [
          { kind: 'die', sides: 6, color: 'purple' },
          { kind: 'die', sides: 6, color: 'green' },
          { kind: 'die', sides: 6, color: 'green' },
        ],
        skillId: null,
      }
    : {}),
  ...(kind === 'style' ? { range: { minimum: 1, maximum: 2 }, archetypeId: null } : {}),
  ...(kind === 'archetype' ? { archetypeKind: 'player' } : {}),
});

export default function HomebrewPage() {
  const { role } = useRole();
  const hb = useHomebrewState();
  const items = hb?.items ?? null;
  const book = useBookContent();
  const idx = useContent();
  const [edit, setEdit] = useState(null); // the item being edited (a working copy)
  const [copyKind, setCopyKind] = useState('form');

  // A new item comes back with its id: keep editing it.
  useEffect(() => {
    const onSaved = ({ id, clientKey }) => setEdit((e) => (e && !e.id && e.clientKey === clientKey ? { ...e, id } : e));
    socket.on('homebrew:saved', onSaved);
    return () => socket.off('homebrew:saved', onSaved);
  }, []);

  if (role !== 'gm') return <p className="p-4 text-sm text-zinc-500">The homebrew builder is for the GM.</p>;
  if (!items || !book || !idx) return <p className="p-4 text-sm text-zinc-500">Loading…</p>;

  const start = (item) => setEdit({ ...structuredClone(item), clientKey: `k${Date.now()}` });
  const coreIds = new Set(hb.coreIds);
  const syncOf = (id) => ({ autoItem: (id && hb.automation?.items?.[id]) || null, inCore: Boolean(id) && coreIds.has(id) });
  const bookList = { form: book.content.forms, style: book.content.styles, archetype: book.content.archetypes };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="space-y-1">
        <h1 className="font-display text-xl font-bold uppercase tracking-wide text-zinc-100">Homebrew</h1>
        <p className="text-xs text-zinc-500">
          Your own Forms, Styles and Archetypes. Drafts are only offered to you; publish one to offer it in every player&rsquo;s character builder.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <aside className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {['form', 'style', 'archetype'].map((k) => (
              <button key={k} type="button" onClick={() => start(blank(k))} className={`${smallBtn} inline-flex items-center gap-1`}>
                <Plus size={13} aria-hidden /> {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="space-y-1.5 panel-cut-sm border border-zinc-800 bg-zinc-900/60 p-2">
            <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
              <Copy size={12} aria-hidden /> Copy from book
            </p>
            <div className="flex gap-1.5">
              <select value={copyKind} onChange={(e) => setCopyKind(e.target.value)} className={selectClass} aria-label="Kind to copy">
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                value=""
                onChange={(e) => {
                  const entry = book.get(e.target.value);
                  const item = entry && copyFromBook(entry, book);
                  if (item) start(item);
                }}
                className={`${selectClass} min-w-0 flex-1`}
                aria-label="Book entry to copy"
              >
                <option value="">— pick —</option>
                {bookList[copyKind].map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {['form', 'style', 'archetype'].map((k) => {
            const list = items.filter((i) => i.kind === k);
            return (
              <div key={k}>
                <h2 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">{KIND_LABEL[k]}s</h2>
                {list.length === 0 && <p className="text-xs italic text-zinc-600">None yet.</p>}
                <ul className="space-y-1">
                  {list.map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => start(i)} className={`${cardClass(edit?.id === i.id)} w-full`}>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                          <span className="min-w-0 flex-1 truncate">{i.name}</span>
                          <HomebrewWrench state={wrenchState(i, syncOf(i.id))} />
                        </span>
                        <span className={`block text-[10px] uppercase ${i.published ? 'text-emerald-400' : 'text-zinc-500'}`}>{i.published ? 'Published' : 'Draft'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <WrenchLegend />
        </aside>
        <main>
          {edit ? (
            <ItemEditor key={edit.id ?? edit.clientKey} item={edit} setItem={setEdit} idx={idx} book={book} sync={syncOf(edit.id)} onClose={() => setEdit(null)} />
          ) : (
            <p className="text-sm text-zinc-500">Pick an item, make a new one, or copy one from the book.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function ItemEditor({ item, setItem, idx, book, sync, onClose }) {
  const set = (patch) => setItem((e) => ({ ...e, ...patch }));
  const save = () => {
    // An Ability without its own text gets its rules' summary.
    const abilities = item.abilities.map((a) => ({ ...a, rulesText: a.rulesText?.trim() ? a.rulesText : a.rules.map((r) => describeSpec(r, tokenName)).join(' ') }));
    socket.emit('homebrew:save', { item: { ...item, abilities } });
  };
  const archetypes = idx.content.archetypes;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="panel-cut-sm bg-zinc-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-300">{KIND_LABEL[item.kind]}</span>
        <HomebrewWrench state={wrenchState(item, sync)} size={15} />
        <label className="flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={item.published} onChange={(e) => set({ published: e.target.checked })} />
          Published (players can pick it)
        </label>
        <div className="ml-auto flex gap-1.5">
          <button type="button" onClick={save} className="min-h-9 panel-cut-sm bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-500">
            {item.id ? 'Save' : 'Create'}
          </button>
          {item.id && (
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Delete ${item.name}? Characters using it lose it from their build.`)) return;
                socket.emit('homebrew:delete', { id: item.id });
                onClose();
              }}
              className={`${smallBtn} inline-flex items-center gap-1 text-red-400`}
            >
              <Trash2 size={13} aria-hidden /> Delete
            </button>
          )}
          <button type="button" onClick={onClose} className={smallBtn}>
            Close
          </button>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={item.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} className={inputClass} />
        </Field>
        {item.kind === 'archetype' && (
          <Field label="Kind">
            <select value={item.archetypeKind} onChange={(e) => set({ archetypeKind: e.target.value })} className={`${selectClass} w-full`}>
              <option value="player">Player Archetype</option>
              <option value="villain">Villain Archetype</option>
            </select>
          </Field>
        )}
        {item.kind === 'style' && (
          <>
            <Field label="Archetype">
              <select value={item.archetypeId ?? ''} onChange={(e) => set({ archetypeId: e.target.value || null })} className={`${selectClass} w-full`}>
                <option value="">— none —</option>
                {archetypes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.homebrew ? ' ✦' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Range (${rangeText(item.range)})`}>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={9}
                  value={item.range.minimum}
                  onChange={(e) => set({ range: { ...item.range, minimum: Number(e.target.value) } })}
                  className={inputClass}
                  aria-label="Minimum range"
                />
                <span className="text-zinc-500">to</span>
                <input
                  type="number"
                  min={0}
                  max={12}
                  value={item.range.maximum}
                  onChange={(e) => set({ range: { ...item.range, maximum: Number(e.target.value) } })}
                  className={inputClass}
                  aria-label="Maximum range"
                />
              </div>
            </Field>
          </>
        )}
        {item.kind === 'form' && (
          <>
            <Field label="Stance names (aliases, comma-separated)">
              <input
                value={item.aliases.join(', ')}
                onChange={(e) => set({ aliases: e.target.value.split(',').map((a) => a.trimStart()) })}
                onBlur={() => set({ aliases: item.aliases.map((a) => a.trim()).filter(Boolean) })}
                placeholder="Dragon, Star"
                className={inputClass}
              />
            </Field>
            <Field label="Skill">
              <select
                value={item.customSkill ? OTHER_SKILL : (item.skillId ?? '')}
                onChange={(e) =>
                  e.target.value === OTHER_SKILL
                    ? set({ skillId: OTHER_SKILL, customSkill: item.customSkill ?? { name: '', rulesText: '' } })
                    : set({ skillId: e.target.value || null, customSkill: null })
                }
                className={`${selectClass} w-full`}
              >
                <option value="">— none —</option>
                {book.content.skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={OTHER_SKILL}>Other (write your own)…</option>
              </select>
            </Field>
            {item.customSkill && (
              <div className="space-y-2 sm:col-span-2">
                <Field label="Custom Skill name">
                  <input
                    value={item.customSkill.name}
                    maxLength={40}
                    placeholder="e.g. Fire Breathing"
                    onChange={(e) => set({ customSkill: { ...item.customSkill, name: e.target.value } })}
                    className={inputClass}
                  />
                </Field>
                <Field label="What the Skill lets you do">
                  <textarea
                    value={item.customSkill.rulesText}
                    rows={2}
                    onChange={(e) => set({ customSkill: { ...item.customSkill, rulesText: e.target.value } })}
                    className={`${inputClass} py-1.5`}
                  />
                </Field>
              </div>
            )}
          </>
        )}
      </section>

      {item.kind === 'form' && <DiceEditor dice={item.actionDice} set={(actionDice) => set({ actionDice })} />}

      <Field label="Description">
        <textarea value={item.descriptionText} rows={3} onChange={(e) => set({ descriptionText: e.target.value })} className={`${inputClass} py-1.5`} />
      </Field>

      <AbilitiesEditor kind={item.kind} abilities={item.abilities} autoItem={sync.autoItem} set={(abilities) => set({ abilities })} />
      <ActionsEditor actions={item.actions} autoItem={sync.autoItem} set={(actions) => set({ actions })} />
    </div>
  );
}

function DiceEditor({ dice, set }) {
  const update = (i, patch) => set(dice.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
        Action Dice <DiceRow dice={dice} />
      </h3>
      {dice.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <select
            value={d.kind}
            onChange={(e) => update(i, e.target.value === 'fixed' ? { kind: 'fixed', value: 4, sides: undefined } : { kind: 'die', sides: 6, value: undefined })}
            className={selectClass}
            aria-label={`Die ${i + 1} kind`}
          >
            <option value="die">Die</option>
            <option value="fixed">Fixed number</option>
          </select>
          {d.kind === 'fixed' ? (
            <input type="number" min={1} max={12} value={d.value} onChange={(e) => update(i, { value: Number(e.target.value) })} className={`${selectClass} w-16`} aria-label={`Die ${i + 1} value`} />
          ) : (
            <select value={d.sides} onChange={(e) => update(i, { sides: Number(e.target.value) })} className={selectClass} aria-label={`Die ${i + 1} size`}>
              {DIE_SIDES.map((s) => (
                <option key={s} value={s}>
                  d{s}
                </option>
              ))}
            </select>
          )}
          <select value={d.color} onChange={(e) => update(i, { color: e.target.value })} className={selectClass} aria-label={`Die ${i + 1} colour`}>
            {DIE_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => set(dice.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">
            Remove
          </button>
        </div>
      ))}
      {dice.length < 6 && (
        <button type="button" onClick={() => set([...dice, { kind: 'die', sides: 6, color: 'green' }])} className={smallBtn}>
          Add a die
        </button>
      )}
    </section>
  );
}

// A part's own wrench, once Claude automated its item.
const partWrench = (autoItem, uid, fingerprint) => (autoItem ? <HomebrewWrench state={partState({ uid, fingerprint }, autoItem)} /> : null);

function AbilitiesEditor({ kind, abilities, autoItem, set }) {
  const update = (i, patch) => set(abilities.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-zinc-400">Abilities</h3>
      {abilities.map((a, i) => (
        <div key={i} className="space-y-2 panel-cut-sm border border-zinc-800 bg-zinc-900/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {partWrench(autoItem, a.uid, abilityFingerprint(a))}
            <input value={a.name} onChange={(e) => update(i, { name: e.target.value })} className={`${inputClass} max-w-xs`} aria-label="Ability name" />
            {kind === 'archetype' && (
              <select value={a.variant ?? ''} onChange={(e) => update(i, { variant: e.target.value || null })} className={selectClass} aria-label="Which heroes get it">
                <option value="">Always (every hero)</option>
                {VARIANT_KEYS.map((v) => (
                  <option key={v} value={v}>
                    {v[0].toUpperCase() + v.slice(1)} ability
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={() => set(abilities.filter((_, j) => j !== i))} className="ml-auto text-xs text-red-400 hover:text-red-300">
              Remove ability
            </button>
          </div>
          <textarea
            value={a.rulesText}
            rows={2}
            onChange={(e) => update(i, { rulesText: e.target.value })}
            placeholder="Rules text (left empty, it is written from the rules below)"
            className={`${inputClass} py-1.5 text-xs`}
          />
          {a.rules.map((r, j) => (
            <RuleEditor
              key={j}
              rule={r}
              set={(rule) => update(i, { rules: a.rules.map((x, k) => (k === j ? rule : x)) })}
              remove={() => update(i, { rules: a.rules.filter((_, k) => k !== j) })}
            />
          ))}
          {a.rules.length < 6 && (
            <button type="button" onClick={() => update(i, { rules: [...a.rules, { moment: 'own_turn.start', optional: false, steps: [] }] })} className={smallBtn}>
              Add a rule
            </button>
          )}
        </div>
      ))}
      {abilities.length < 8 && (
        <button
          type="button"
          onClick={() => set([...abilities, { uid: newUid(), name: 'New Ability', rulesText: '', ...(kind === 'archetype' ? { variant: null } : {}), rules: [] }])}
          className={`${smallBtn} inline-flex items-center gap-1`}
        >
          <Plus size={13} aria-hidden /> Ability
        </button>
      )}
    </section>
  );
}

const newStep = (kind) => {
  const def = STEP_KINDS.find((s) => s.id === kind);
  if (kind === 'choose') return { kind, options: [newStep('gain_tokens'), newStep('heal')] };
  if (kind === 'notify') return { kind, text: '' };
  return { kind, who: def.who[0], ...(def.amount ? { amount: 1 } : {}), ...(def.token ? { token: 'power' } : {}), ...(def.filter ? { filter: 'any' } : {}) };
};

function RuleEditor({ rule, set, remove }) {
  if (rule.raw) {
    return (
      <div className="flex items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-400">
        <span className="flex-1">Rule copied from the book ({(rule.raw.events ?? []).join(', ')}), kept as is.</span>
        <button type="button" onClick={remove} className="text-red-400 hover:text-red-300">
          Remove
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={rule.moment} onChange={(e) => set({ ...rule, moment: e.target.value })} className={selectClass} aria-label="When">
          {MOMENTS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {rule.moment !== 'text' && (
          <label className="flex items-center gap-1 text-xs text-zinc-300">
            <input type="checkbox" checked={rule.optional} onChange={(e) => set({ ...rule, optional: e.target.checked })} />
            &ldquo;You may&rdquo; (asks first)
          </label>
        )}
        <button type="button" onClick={remove} className="ml-auto text-xs text-red-400 hover:text-red-300">
          Remove rule
        </button>
      </div>
      {rule.moment !== 'text' && (
        <>
          {rule.steps.map((s, i) => (
            <StepEditor
              key={i}
              step={s}
              set={(step) => set({ ...rule, steps: rule.steps.map((x, j) => (j === i ? step : x)) })}
              remove={() => set({ ...rule, steps: rule.steps.filter((_, j) => j !== i) })}
            />
          ))}
          {rule.steps.length < 8 && (
            <select value="" onChange={(e) => e.target.value && set({ ...rule, steps: [...rule.steps, newStep(e.target.value)] })} className={selectClass} aria-label="Add an effect">
              <option value="">+ Add an effect…</option>
              {STEP_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      <p className="text-[11px] italic text-zinc-500">{describeSpec(rule, tokenName)}</p>
    </div>
  );
}

function StepEditor({ step, set, remove, nested = false }) {
  const def = STEP_KINDS.find((s) => s.id === step.kind);
  const kinds = useMemo(() => STEP_KINDS.filter((k) => !nested || k.id !== 'choose'), [nested]);
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${nested ? '' : 'border-l-2 border-zinc-700 pl-2'}`}>
      <select value={step.kind} onChange={(e) => set(newStep(e.target.value))} className={selectClass} aria-label="Effect">
        {kinds.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      {def.amount && (
        <>
          {step.amount === 'heal_value' ? (
            <span className="text-xs text-zinc-300">the Heal Value</span>
          ) : (
            <input type="number" min={1} max={12} value={step.amount} onChange={(e) => set({ ...step, amount: Number(e.target.value) })} className={`${selectClass} w-16`} aria-label="Amount" />
          )}
          {def.healValue && (
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">
              <input type="checkbox" checked={step.amount === 'heal_value'} onChange={(e) => set({ ...step, amount: e.target.checked ? 'heal_value' : 1 })} />
              Heal Value
            </label>
          )}
        </>
      )}
      {def.text && (
        <input
          value={step.text ?? ''}
          maxLength={300}
          onChange={(e) => set({ ...step, text: e.target.value })}
          placeholder="Message for the chat (empty: the Ability's rules text)"
          className={`${selectClass} min-w-0 flex-1 basis-56`}
          aria-label="Notification text"
        />
      )}
      {def.token && (
        <select value={step.token} onChange={(e) => set({ ...step, token: e.target.value })} className={selectClass} aria-label="Token">
          {HOMEBREW_TOKENS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {def.filter && (
        <select value={step.filter} onChange={(e) => set({ ...step, filter: e.target.value })} className={selectClass} aria-label="Which tokens">
          <option value="any">any tokens</option>
          <option value="status">Status tokens</option>
        </select>
      )}
      {def.who.length > 0 && (
        <select value={step.who} onChange={(e) => set({ ...step, who: e.target.value })} className={selectClass} aria-label="Who">
          {WHO.filter((w) => def.who.includes(w.id)).map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      )}
      <button type="button" onClick={remove} className="text-xs text-red-400 hover:text-red-300">
        ✕
      </button>
      {step.kind === 'choose' && (
        <div className="w-full space-y-1 pl-3">
          {step.options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase text-zinc-500">{i === 0 ? 'either' : 'or'}</span>
              <StepEditor
                nested
                step={o}
                set={(opt) => set({ ...step, options: step.options.map((x, j) => (j === i ? opt : x)) })}
                remove={() => step.options.length > 2 && set({ ...step, options: step.options.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
          {step.options.length < 4 && (
            <button type="button" onClick={() => set({ ...step, options: [...step.options, newStep('gain_tokens')] })} className="text-[11px] text-zinc-400 hover:text-zinc-200">
              + another option
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ActionsEditor({ actions, autoItem, set }) {
  const update = (i, patch) => set(actions.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-zinc-400">Actions (reference on the sheet until Claude automates them)</h3>
      {actions.map((a, i) => (
        <div key={i} className="space-y-1.5 panel-cut-sm border border-zinc-800 bg-zinc-900/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {partWrench(autoItem, a.uid, actionFingerprint(a))}
            <input value={a.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Name" className={`${inputClass} max-w-xs`} aria-label="Action name" />
            <input value={a.cost} onChange={(e) => update(i, { cost: e.target.value })} placeholder="Cost, e.g. 1+ or 3+ or 6+" className={`${inputClass} max-w-[14rem]`} aria-label="Action cost" />
            <button type="button" onClick={() => set(actions.filter((_, j) => j !== i))} className="ml-auto text-xs text-red-400 hover:text-red-300">
              Remove
            </button>
          </div>
          <textarea value={a.rulesText} rows={2} onChange={(e) => update(i, { rulesText: e.target.value })} placeholder="Rules text, with its Gates" className={`${inputClass} py-1.5 text-xs`} />
        </div>
      ))}
      {actions.length < 12 && (
        <button type="button" onClick={() => set([...actions, { uid: newUid(), name: '', cost: '', rulesText: '' }])} className={`${smallBtn} inline-flex items-center gap-1`}>
          <Plus size={13} aria-hidden /> Action
        </button>
      )}
    </section>
  );
}
