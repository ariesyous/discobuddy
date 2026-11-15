export const defaultConversation = Object.freeze({
  replyMode: 'group',
  interruptions: 'addressed',
  guidelines: 'Start with the answer. For a simple question, give exactly one short sentence that contains the answer, then end the turn. Give more detail when asked. Skip greetings, names, introductions, filler, and generic offers to help further. Ask for clarification only if you need it to answer.',
});

export const replyModes = ['group', 'addressed', 'open'];
export const interruptionModes = ['addressed', 'any', 'finish'];
export const MAX_GUIDELINES = 1600;

export function requiresAddress(replyMode, people) {
  return replyMode === 'addressed' || (replyMode === 'group' && people !== 1);
}

const name = 'disco[\\s-]*buddy';
const leadingName = new RegExp(`^(?:(hey|hi|hello|yo|ok(?:ay)?)[,\\s]+)?${name}(?=$|[\\s,:.!?–—-])`, 'iu');
const trailingName = new RegExp(`,\\s*${name}[.?!…]*$`, 'iu');
const requestStart = /^(?:(?:can|could|will|would|do|did|are|have)\s+you|what|why|when|where|who|which|how|please|tell|give|explain|say|show|help|stop|wait|hold on|pause)\b/iu;

// A vocative at the edge of a turn counts. A mention in ordinary conversation does not.
// Return null for a turn addressed elsewhere, or an empty string for a name on its own.
export function addressedRequest(transcript) {
  const text = transcript.trim().replace(/^[“"]|[”"]$/gu, '');
  const call = leadingName.exec(text);
  if (call) {
    const rest = text.slice(call[0].length).trimStart();
    const request = rest.replace(/^[\s,:.!?…–—-]+/u, '').trim();
    if (!request || call[1] || /^[,:–—-]/u.test(rest) || requestStart.test(request)) return request;
    return null;
  }
  const suffix = trailingName.exec(text);
  return suffix ? text.slice(0, suffix.index).trim() : null;
}

export function isStopRequest(text) {
  return /^(?:please\s+)?(?:stop(?:\s+(?:talking|speaking))?|wait(?:\s+a\s+(?:sec(?:ond)?|minute|moment))?|hold on|pause)(?:,?\s+please)?[.?!…]*$/iu.test(text);
}
