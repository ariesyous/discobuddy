import { readFile } from 'node:fs/promises';
import { writeLocalJson } from './local-store.mjs';

export function parseLines(text) {
  if (typeof text !== 'string' || text.length > 12_000) throw new Error('Keep the list under 12,000 characters.');
  const lines = text.split(/\r\n|\r|\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 100 || lines.some((line) => line.length > 300)) {
    throw new Error('Use at most 100 lines, each no longer than 300 characters.');
  }
  return [...new Set(lines)];
}

export async function loadLines(path) {
  if (!path) return [];
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const data = JSON.parse(contents);
  if (!Array.isArray(data.lines) || data.lines.some((line) => typeof line !== 'string' || /[\r\n]/u.test(line))) {
    throw new Error('The saved joke and question bank is invalid.');
  }
  return parseLines(data.lines.join('\n'));
}

export function saveLines(path, lines) { return writeLocalJson(path, { lines }); }
