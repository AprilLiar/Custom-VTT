// The Panic at the Dojo rules content (client/src/data/patd): it matches its
// own JSON Schema (Draft 2020-12), every id is unique, every reference
// resolves, and the catalog holds what the export says it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { CONTENT_PATH, SCHEMA_PATH, patdContent } from '../patdContent.js';
import { collectReferences, indexContent } from '../../client/src/lib/patd/content.js';

const content = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// **One known source conflict** is left in the export on purpose: Brawling
// Style's Tough It Out keeps the printed cost as `sourceCostText` ("3+ or
// 11+") beside its structured cost ("3+ or 9+"), a field the schema does not
// allow. It awaits the user's ruling; nothing else may fail.
const KNOWN_SCHEMA_EXCEPTIONS = [{ actionId: 'action.style-brawling.tough-it-out', property: 'sourceCostText' }];

test('the content validates against its schema (bar the one known source conflict)', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  validate(content);
  const unexpected = (validate.errors ?? []).filter((e) => {
    const m = /^\/actions\/(\d+)$/.exec(e.instancePath);
    if (!m || e.keyword !== 'additionalProperties') return true;
    const action = content.actions[Number(m[1])];
    return !KNOWN_SCHEMA_EXCEPTIONS.some((k) => k.actionId === action?.id && k.property === e.params.additionalProperty);
  });
  assert.deepEqual(unexpected.slice(0, 3), []);
});

test('every id is unique and every reference resolves', () => {
  const idx = indexContent(content);
  const missing = collectReferences(content).filter((r) => !idx.byId.has(r.id));
  assert.deepEqual(missing.slice(0, 10), []);
});

test('the catalog holds what the export says', () => {
  const counts = content.metadata.validation.counts;
  for (const [key, n] of Object.entries(counts)) assert.equal(content[key].length, n, key);
  assert.equal(content.basicActionIds.length, 10);
  assert.deepEqual(content.heroTypes.map((h) => h.id), ['hero-type.focused', 'hero-type.fused', 'hero-type.frantic']);
});

test('the server loads and indexes it once', () => {
  const a = patdContent();
  assert.equal(a, patdContent());
  assert.equal(a.get('form.blaster').name, 'Blaster Form');
  assert.equal(a.get('nope.nope'), null);
  assert.throws(() => a.resolve('nope.nope'));
});
