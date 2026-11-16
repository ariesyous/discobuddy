import { readFile } from 'node:fs/promises';
import { MAX_PROMPT_FIELD } from './conversation.mjs';
import { writeLocalJson } from './local-store.mjs';

export async function loadPrompt(path) {
  if (!path) return {};
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const { persona, guidelines } = JSON.parse(contents);
  if ([persona, guidelines].some((value) => typeof value !== 'string' || value.length > MAX_PROMPT_FIELD)) {
    throw new Error('The saved prompt settings are invalid.');
  }
  return { persona, guidelines };
}

export function savePrompt(path, { persona, guidelines }) {
  return writeLocalJson(path, { persona, guidelines });
}
