import { readFile } from 'node:fs/promises';
import { MAX_PROMPT_FIELD, normalizeAliases, relevantIntervals, replyModes } from './conversation.mjs';
import { writeLocalJson } from './local-store.mjs';

export async function loadPrompt(path) {
  if (!path) return {};
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const { persona, guidelines, aliases = '', replyMode = 'group', relevantInterval = 30 } = JSON.parse(contents);
  if ([persona, guidelines].some((value) => typeof value !== 'string' || value.length > MAX_PROMPT_FIELD)) {
    throw new Error('The saved prompt settings are invalid.');
  }
  if (!replyModes.includes(replyMode) || !relevantIntervals.includes(relevantInterval)) throw new Error('The saved conversation settings are invalid.');
  return { persona, guidelines, aliases: normalizeAliases(aliases), replyMode, relevantInterval };
}

export function savePrompt(path, { persona, guidelines, aliases, replyMode, relevantInterval }) {
  return writeLocalJson(path, { persona, guidelines, aliases, replyMode, relevantInterval });
}
