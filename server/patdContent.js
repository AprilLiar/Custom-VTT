// The rules content, read once at startup (see client/src/lib/patd/content.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexContent } from '../client/src/lib/patd/content.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTENT_PATH = path.join(here, '..', 'client', 'src', 'data', 'patd', 'content.json');
export const SCHEMA_PATH = path.join(here, '..', 'client', 'src', 'data', 'patd', 'schema.json');

let cached = null;
export function patdContent() {
  if (!cached) cached = indexContent(JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8')));
  return cached;
}
