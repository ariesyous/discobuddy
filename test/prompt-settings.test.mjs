import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleInstructions, countPromptTokens } from '../discord-control/audio.mjs';
import { systemInstructions } from '../local-chat/realtime.mjs';

test('prompt counts use the same assembled instructions as voice replies', async () => {
  const draft = { persona: 'A bright friend.', guidelines: 'Answer briefly.' };
  let sent;
  const count = await countPromptTokens(8765, draft, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8765/tokenize');
    sent = JSON.parse(options.body);
    return Response.json({ tokens: [1, 2, 3, 4] });
  });
  assert.equal(count, 4);
  assert.deepEqual(sent, {
    content: systemInstructions(assembleInstructions(draft)), add_special: false, parse_special: false,
  });
  assert.match(sent.content, /^Respond with interleaved text and audio\./);
  assert.match(sent.content, /Speaking style and role: A bright friend\./);
  assert.match(sent.content, /Conversation guidelines.*Answer briefly\./);
  assert.match(assembleInstructions(draft, { name: 'Alex', username: 'alex' }), /The person asking is "Alex"/);
});
