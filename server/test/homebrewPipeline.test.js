// Commit Homebrew → Claude's automation (vttprojectplan.md, "Commit Homebrew"):
// stable part uids, wording fingerprints, the wrench, the core files, the
// GitHub commit (against a fake GitHub), the automation running on top of the
// live item — and a check of the repo's own homebrew/ folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookContent } from '../patdContent.js';
import { indexContent } from '../../client/src/lib/patd/content.js';
import { census } from '../../client/src/lib/patd/coverage.js';
import { ruleSupport } from '../../client/src/lib/patd/interpreter.js';
import { HOMEBREW_TOKEN_KEYS, cleanHomebrew, ensureUids, isUid, itemToContent, mergeHomebrew } from '../../client/src/lib/patd/homebrew.js';
import {
  abilityFingerprint,
  actionFingerprint,
  automationReport,
  coreFilePath,
  coreFileText,
  parseCoreFile,
  partsOf,
  planCommit,
  wrenchState,
} from '../../client/src/lib/patd/homebrewSync.js';
import { commitHomebrew, gitBlobSha } from '../githubCommit.js';
import { loadCore } from '../homebrewCore.js';
import { fakeGithub } from './fakeGithub.js';

const book = bookContent();
const clean = (raw) => cleanHomebrew(raw, book, HOMEBREW_TOKEN_KEYS);

const ember = {
  ...clean({
    kind: 'form',
    name: 'Ember Form',
    published: true,
    abilities: [
      { name: 'Ember Form', rulesText: 'At the start of your turn, gain 1 Power.', rules: [{ moment: 'own_turn.start', steps: [{ kind: 'gain_tokens', token: 'power', amount: 1, who: 'self' }] }] },
      { name: 'Smoulder', rulesText: 'When you are hit, gain 1 Shield.', rules: [] },
    ],
    actions: [{ name: 'Flare', cost: '4+', rulesText: 'Deal 2 damage.' }],
  }),
  id: 'form.hb-ember-ab12',
};
const [a1, a2] = ember.abilities;
const [x1] = ember.actions;

test('every Ability and Action gets a uid that survives a save; a repeated one is replaced', () => {
  assert.ok([a1, a2, x1].every((p) => isUid(p.uid)));
  assert.equal(new Set([a1.uid, a2.uid, x1.uid]).size, 3);
  const again = clean({ ...ember, name: 'Cinder Form', abilities: [{ ...a2 }, { ...a1, name: 'Cinder' }] });
  assert.deepEqual(again.abilities.map((a) => a.uid), [a2.uid, a1.uid], 'renamed and reordered: same uids');
  const dup = clean({ ...ember, abilities: [a1, { ...a2, uid: a1.uid }] });
  assert.equal(dup.abilities[0].uid, a1.uid);
  assert.notEqual(dup.abilities[1].uid, a1.uid);
  // Older saved items had none: the boot migration adds them once.
  const legacy = { ...ember, abilities: ember.abilities.map(({ uid: _u, ...rest }) => rest) };
  let n = 0;
  const { item, changed } = ensureUids(legacy, () => ((n++ * 0.137) % 1));
  assert.equal(changed, true);
  assert.ok(item.abilities.every((a) => isUid(a.uid)));
  assert.equal(ensureUids(item).changed, false);
  assert.equal(ensureUids(item).item, item);
});

test('only rules wording changes a fingerprint (not names, descriptions or spacing)', () => {
  assert.equal(abilityFingerprint(a1), abilityFingerprint({ ...a1, name: 'Renamed' }));
  assert.equal(abilityFingerprint(a1), abilityFingerprint({ ...a1, rulesText: `  ${a1.rulesText.replace(/ /g, '   ')}\n` }));
  assert.notEqual(abilityFingerprint(a1), abilityFingerprint({ ...a1, rulesText: a1.rulesText.replace('1 Power', '2 Power') }));
  assert.notEqual(abilityFingerprint(a1), abilityFingerprint({ ...a1, rules: [] }), 'the rule steps count too');
  assert.notEqual(actionFingerprint(x1), actionFingerprint({ ...x1, cost: '5+' }), 'an Action’s cost counts');
  assert.equal(actionFingerprint(x1), actionFingerprint({ ...x1, name: 'Blaze' }));
  assert.match(abilityFingerprint(a1), /^[0-9a-f]{16}$/);
});

const autoFor = (item, sha = 'c0ffee') => ({
  entries: Object.fromEntries(partsOf(item).map((p) => [p.uid, { part: p.part, name: p.name, fingerprint: p.fingerprint, basedOn: sha }])),
});

test('the wrench: none → outline (committed) → blue (automated) → grey (wording changed or a part added)', () => {
  assert.equal(wrenchState(ember, {}), 'none');
  assert.equal(wrenchState(ember, { inCore: true }), 'waiting');
  const autoItem = autoFor(ember);
  assert.equal(wrenchState(ember, { autoItem, inCore: true }), 'automated');
  assert.equal(wrenchState({ ...ember, name: 'Cinder Form', descriptionText: 'new words' }, { autoItem }), 'automated', 'a rename keeps it blue');
  const reworded = { ...ember, actions: [{ ...x1, rulesText: 'Deal 3 damage.' }] };
  assert.equal(wrenchState(reworded, { autoItem }), 'stale');
  const grown = { ...ember, actions: [...ember.actions, { uid: 'zzzz9999', name: 'Kindle', cost: '1+', rulesText: 'Gain 1 Speed.' }] };
  assert.equal(wrenchState(grown, { autoItem }), 'stale');
  const shrunk = { ...ember, abilities: [a1] };
  assert.equal(wrenchState(shrunk, { autoItem }), 'automated', 'a removed part leaves the rest automated');
});

test('automation runs on top of the live item, by uid — even after a rename, a reorder or new wording', () => {
  const rules = [{ events: ['own_turn.start'], effect: { op: 'gain_tokens', token: 'power', amount: 2, target: { ref: 'self' } }, optional: false }];
  const effect = { op: 'sequence', steps: [{ op: 'deal_damage', amount: 2, target: { ref: 'target' } }] };
  const automation = {
    items: {
      [ember.id]: {
        entries: {
          [a2.uid]: { fingerprint: 'old', basedOn: 'c0ffee', rules },
          [x1.uid]: { fingerprint: 'old', basedOn: 'c0ffee', effect, cost: { selection: 'exactly_one', options: [] } },
        },
      },
    },
  };
  const live = { ...ember, abilities: [{ ...a2, name: 'Smoulder II' }, a1] };
  const c = itemToContent(live, automation.items[ember.id]);
  assert.equal(c.abilities[0].name, 'Smoulder II');
  assert.equal(c.abilities[0].automationState, 'automated');
  assert.deepEqual(c.abilities[0].rules.map((r) => r.id), ['ability.hb-ember-ab12.a1.rule-1']);
  assert.equal(c.abilities[0].rules[0].effect.amount, 2);
  assert.equal(c.abilities[1].automationState, 'structured', 'no entry: its own rule steps');
  assert.deepEqual(c.actions[0].effect, effect);
  assert.equal(c.actions[0].cost.text, '4+', 'the cost text stays the live one');
  assert.equal(c.actions[0].cost.selection, 'exactly_one');
  const merged = indexContent(mergeHomebrew(book.content, [live], { automation }));
  assert.equal(merged.get('ability.hb-ember-ab12.a1').rules[0].effect.amount, 2);
});

test('core files: one per published item, deterministic, round-trip; drafts stay out', () => {
  const text = coreFileText(ember);
  assert.equal(text, coreFileText({ ...ember }));
  assert.ok(!text.includes('"published"'));
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(parseCoreFile(text, ember.id), { ...JSON.parse(text), published: true });
  assert.equal(parseCoreFile(text, 'form.hb-other-zz99'), null, 'the file name must match the id');
  assert.equal(parseCoreFile('{ nope'), null);
  const draft = { ...ember, id: 'form.hb-draft-cd34', published: false };
  const existing = new Map([[coreFilePath(ember.id), text], [coreFilePath('style.hb-gone-ef56'), '{}']]);
  const plan = planCommit([{ ...ember, name: 'Renamed' }, draft], existing);
  assert.deepEqual(plan.files.map((f) => f.path), [coreFilePath(ember.id)]);
  assert.equal(plan.change.length, 1);
  assert.equal(plan.add.length, 0);
  assert.deepEqual(plan.remove, [coreFilePath('style.hb-gone-ef56')]);
});

test('the GitHub commit: one commit of the published items, skipped when nothing changed, retried when main moved', async () => {
  const gh = fakeGithub();
  const cfg = { token: 'test-token', repo: 'AprilLiar/Custom-VTT', branch: 'main', fetchImpl: gh.asFetch() };
  const style = { ...clean({ kind: 'style', name: 'Kindling Style', published: true, range: { minimum: 1, maximum: 3 } }), id: 'style.hb-kindling-ef56' };
  const draft = { ...ember, id: 'form.hb-draft-cd34', published: false };

  const first = await commitHomebrew([ember, style, draft], cfg);
  assert.equal(first.added, 2);
  assert.equal(first.sha, gh.head());
  assert.match(first.url, /github\.com\/AprilLiar\/Custom-VTT\/commit\//);
  const files = gh.files();
  assert.equal(files.get(coreFilePath(ember.id)), coreFileText(ember));
  assert.ok(!files.has(coreFilePath(draft.id)), 'drafts stay out');
  assert.equal(files.get('README.md'), 'hello\n', 'the rest of the repo is untouched');
  assert.match(gh.commit().message, /^Commit Homebrew: 2 added, 0 changed, 0 removed/);

  const posts = gh.log.filter((r) => r.method !== 'GET').length;
  const same = await commitHomebrew([style, ember], cfg);
  assert.equal(same.unchanged, true);
  assert.equal(gh.log.filter((r) => r.method !== 'GET').length, posts, 'nothing written');

  gh.raceNextPatch();
  const next = await commitHomebrew([{ ...ember, descriptionText: 'Hot.' }], cfg);
  assert.deepEqual([next.added, next.changed, next.removed], [0, 1, 1]);
  const after = gh.files();
  assert.ok(!after.has(coreFilePath(style.id)), 'unpublished/deleted: removed');
  assert.equal(after.get('OTHER.md'), 'someone else\n', 'the other push is kept (rebuilt on the new head)');
  assert.ok(after.get(coreFilePath(ember.id)).includes('Hot.'));

  await assert.rejects(commitHomebrew([ember], { ...cfg, token: 'wrong' }), /401/);
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a', 'git’s own blob id');
});

test('Claude’s to-do list: new, stale and automated parts, and leftovers to prune', () => {
  const autoItem = autoFor(ember);
  autoItem.entries.gone1234 = { fingerprint: 'x', basedOn: 'c0ffee' };
  const reworded = { ...ember, actions: [{ ...x1, rulesText: 'Deal 3 damage.' }] };
  const fresh = { ...ember, id: 'form.hb-fresh-gh78' };
  const report = automationReport([reworded, fresh], { items: { [ember.id]: autoItem, 'style.hb-deleted-ij90': { entries: {} } } });
  const byId = Object.fromEntries(report.items.map((r) => [r.id, r]));
  assert.equal(byId[ember.id].wrench, 'stale');
  assert.deepEqual(byId[ember.id].parts.map((p) => p.state), ['automated', 'automated', 'stale']);
  assert.equal(byId[fresh.id].wrench, 'waiting');
  assert.ok(byId[fresh.id].parts.every((p) => p.state === 'new'));
  assert.deepEqual(report.orphanItems, ['style.hb-deleted-ij90']);
  assert.deepEqual(report.orphanEntries, [{ itemId: ember.id, uid: 'gone1234' }]);
});

// The repo's own homebrew/: whatever Claude wrote must be real and must run.
test('the repo’s homebrew core: automation names real items and parts, and everything it claims runs', () => {
  const { items, automation } = loadCore();
  const report = automationReport(items, automation);
  assert.deepEqual(report.orphanItems, [], 'automation of a deleted item — run scripts/homebrew-automation.mjs prune');
  assert.deepEqual(report.orphanEntries, [], 'automation of a deleted part — run scripts/homebrew-automation.mjs prune');
  for (const [id, autoItem] of Object.entries(automation.items ?? {})) {
    for (const [uid, e] of Object.entries(autoItem.entries ?? {})) {
      assert.match(e.fingerprint ?? '', /^[0-9a-f]{16}$/, `${id} ${uid}: stamp it (scripts/homebrew-automation.mjs stamp)`);
      assert.match(e.basedOn ?? '', /^[0-9a-f]{40}$/, `${id} ${uid}: basedOn must be a commit`);
      for (const r of e.rules ?? []) assert.ok(ruleSupport(r).ok, `${id} ${uid}: ${ruleSupport(r).reason}`);
    }
  }
  if (!items.length) return;
  const merged = indexContent(mergeHomebrew(book.content, items, { automation }));
  const report2 = census(merged.content);
  const byHand = new Set([...report2.abilities.triggered.byHand, ...report2.abilities.continuous.byHand, ...report2.actions.byHand].map((b) => b.id));
  for (const a of merged.content.abilities.filter((x) => x.homebrew && x.automationState === 'automated'))
    for (const r of a.rules) assert.ok(!byHand.has(r.id) && !byHand.has(a.id), `${a.id}: automated by Claude but the engine runs it by hand`);
  for (const x of merged.content.actions.filter((y) => y.homebrew && y.effect)) assert.ok(!byHand.has(x.id), `${x.id}: automated by Claude but the engine runs it by hand`);
});
