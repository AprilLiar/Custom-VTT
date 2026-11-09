// The rules content, read once at startup (see client/src/lib/patd/content.js),
// with the GM's homebrew items merged in (client/src/lib/patd/homebrew.js,
// server/homebrew.js). Fights and builds read it through patdContent().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexContent } from '../client/src/lib/patd/content.js';
import { mergeHomebrew } from '../client/src/lib/patd/homebrew.js';
import { applyRulings } from '../client/src/lib/patd/rulings.js';
import { homebrewAutomation } from './homebrewCore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTENT_PATH = path.join(here, '..', 'client', 'src', 'data', 'patd', 'content.json');
export const SCHEMA_PATH = path.join(here, '..', 'client', 'src', 'data', 'patd', 'schema.json');

let book = null;
let homebrew = [];
let cached = null;
let version = 0;

// The book's own content (with the table's rulings), never with homebrew.
export function bookContent() {
  if (!book) book = indexContent(applyRulings(JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'))));
  return book;
}

export function patdContent() {
  // Claude's automation (homebrew/automation.json) runs on top of each item.
  if (!cached) cached = homebrew.length ? indexContent(mergeHomebrew(bookContent().content, homebrew, { automation: homebrewAutomation() })) : bookContent();
  return cached;
}

// Replaces the homebrew items (each { id, ...cleaned item }); bumps the version
// so anything derived from the content is recomputed.
export function setHomebrewItems(items) {
  homebrew = items;
  cached = null;
  version++;
}
export const contentVersion = () => version;
