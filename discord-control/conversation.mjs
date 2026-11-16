export const defaultConversation = Object.freeze({
  replyMode: 'group',
  interruptions: 'addressed',
  aliases: '',
  relevantInterval: 30,
  guidelines: 'Start with the answer. For a simple question, give exactly one short sentence that contains the answer, then end the turn. Give more detail when asked. Skip greetings, names, introductions, filler, and generic offers to help further. Ask for clarification only if you need it to answer.',
});

export const replyModes = ['group', 'addressed', 'open', 'relevant'];
export const interruptionModes = ['addressed', 'any', 'finish'];
export const MAX_PROMPT_FIELD = 12_000;
export const PROMPT_TOKEN_BUDGET = 1500;
export const relevantIntervals = [15, 30, 60, 120];

export function normalizeAliases(value) {
  if (typeof value !== 'string' || value.length > 400) throw new Error('Use up to eight alternative names of 40 characters each.');
  const aliases = value.split(/\r\n|\r|\n|,/u).map((name) => name.trim().replace(/\s+/gu, ' ')).filter(Boolean);
  if (aliases.length > 8 || aliases.some((name) => name.length > 40 || !/[\p{L}\p{N}]/u.test(name) || /[\p{Cc}]/u.test(name))) {
    throw new Error('Use up to eight alternative names of 40 characters each.');
  }
  return [...new Map(aliases.map((name) => [name.toLocaleLowerCase(), name])).values()].join('\n');
}

export function requiresAddress(replyMode, people) {
  return replyMode === 'addressed' || (replyMode === 'group' && people !== 1);
}

// Clear invitations to the whole group need not wait for a second model decision.
export function isGroupInvitation(transcript) {
  const text = transcript.trim();
  if (/,\s*(?!(?:everyone|everybody|folks|guys|friends)\b)[\p{L}\p{N}][\p{L}\p{N}.'’ -]{0,39}[?!…]*$/iu.test(text)) return false;
  return /^(?:(?:hey|hi)[,!]?\s+)?(?:(?:does|do|can|could|would)\s+(?:anyone|anybody)\s+(?:know|explain|suggest|recommend|think|remember)|(?:anyone|anybody)\s+(?:know|have\s+(?:any\s+)?(?:ideas|suggestions))|who\s+(?:knows|has\s+(?:an?\s+)?idea|can\s+(?:suggest|recommend))|what\s+do\s+(?:you\s+all|y['’]?all|everyone|everybody)\s+think)\b/iu.test(text);
}

const requestStart = /^(?:(?:can|could|will|would|do|did|are|have)\s+(?:you|we)|what|why|when|where|who|which|how|please|tell|give|explain|say|show|help|stop|wait|hold on|pause)\b/iu;

function namePatterns(aliases) {
  const escaped = normalizeAliases(aliases).split('\n').filter(Boolean).map((name) =>
    name.split(/[\s-]+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+'));
  const name = `(?:disco[\\s-]*buddy${escaped.length ? `|${escaped.sort((a, b) => b.length - a.length).join('|')}` : ''})`;
  return {
    leading: new RegExp(`^(?:(hey|hi|hello|yo|ok(?:ay)?)[,\\s]+)?${name}(?=$|[\\s,:.!?–—-])`, 'iu'),
    trailing: new RegExp(`,\\s*${name}[.?!…]*$`, 'iu'),
  };
}

// A vocative at the edge of a turn counts. A mention in ordinary conversation does not.
// Return null for a turn addressed elsewhere, or an empty string for a name on its own.
export function addressedRequest(transcript, aliases = '') {
  const text = transcript.trim().replace(/^[“"]|[”"]$/gu, '');
  const { leading, trailing } = namePatterns(aliases);
  const call = leading.exec(text);
  if (call) {
    const rest = text.slice(call[0].length).trimStart();
    const request = rest.replace(/^[\s,:.!?…–—-]+/u, '').trim();
    if (!request || call[1] || /^[,:–—-]/u.test(rest) || requestStart.test(request)) return request;
    return null;
  }
  const suffix = trailing.exec(text);
  return suffix ? text.slice(0, suffix.index).trim() : null;
}

export function isStopRequest(text) {
  return /^(?:please\s+)?(?:stop(?:\s+(?:talking|speaking))?|wait(?:\s+a\s+(?:sec(?:ond)?|minute|moment))?|hold on|pause)(?:,?\s+please)?[.?!…]*$/iu.test(text);
}
