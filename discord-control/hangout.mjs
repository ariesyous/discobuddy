// A hangout lasts while the mode is enabled in one occupied channel. Pausing
// listening keeps the used lines, but an empty channel or a channel change ends it.
export function createHangout({
  getStatus, getLines, playLine, stopLine, onError,
  delay = 90_000, now = Date.now, random = Math.random, schedule = setTimeout, unschedule = clearTimeout,
}) {
  let enabled = false;
  let channelId = null;
  let wasPresent = false;
  let wasEligible = false;
  let quietSince = now();
  let waitingForSpeech = false;
  let timer;
  let pending;
  const speaking = new Set();
  const used = new Set();

  function cancel() {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    const task = pending;
    pending = undefined;
    task?.controller.abort();
  }

  function eligible(status) {
    return enabled && status.voice === 'ready' && status.listening && status.people > 0 && status.channelId;
  }

  function changed() {
    const status = getStatus();
    const present = Boolean(status.channelId && status.people > 0);
    const reset = status.channelId !== channelId || (wasPresent && !present);
    channelId = status.channelId;
    wasPresent = present;
    if (reset) {
      wasEligible = false;
      cancel();
      used.clear();
      waitingForSpeech = false;
      speaking.clear();
      stopLine();
    }
    if (!eligible(status)) {
      wasEligible = false;
      quietSince = now();
      speaking.clear();
      cancel();
      stopLine();
      return;
    }
    if (!wasEligible) quietSince = now();
    wasEligible = true;
    if (speaking.size || waitingForSpeech || pending || timer !== undefined ||
        status.busy || status.playing || status.capturing || !getLines().some((line) => !used.has(line))) return;
    timer = schedule(() => { timer = undefined; void speak(); }, Math.max(0, delay - (now() - quietSince)));
  }

  async function speak() {
    const status = getStatus();
    if (!eligible(status) || speaking.size || waitingForSpeech || status.busy || status.playing || status.capturing) {
      changed();
      return;
    }
    const remaining = getLines().filter((line) => !used.has(line));
    if (!remaining.length) return;
    const line = remaining[Math.floor(random() * remaining.length)];
    const task = { controller: new AbortController() };
    pending = task;
    try {
      if (await playLine(line, task.controller)) {
        if (pending === task) {
          used.add(line);
          waitingForSpeech = true;
        }
      }
    } catch (error) {
      if (pending === task && !task.controller.signal.aborted) {
        // Do not retry a failed synthesis repeatedly during the same lull.
        waitingForSpeech = true;
        onError(error);
      }
    } finally {
      if (pending === task) {
        pending = undefined;
        changed();
      }
    }
  }

  return {
    get enabled() { return enabled; },
    changed,
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      cancel();
      stopLine();
      used.clear();
      speaking.clear();
      waitingForSpeech = false;
      wasEligible = false;
      changed();
    },
    speechStarted(userId) {
      if (!eligible(getStatus())) return;
      speaking.add(userId);
      quietSince = now();
      cancel();
    },
    speechConfirmed(userId) {
      if (!speaking.has(userId) || !eligible(getStatus())) return;
      waitingForSpeech = false;
      quietSince = now();
      stopLine();
    },
    speechEnded(userId) {
      if (!speaking.delete(userId)) return;
      quietSince = now();
      changed();
    },
    bankChanged() {
      cancel();
      quietSince = now();
      changed();
    },
    close() { enabled = false; cancel(); stopLine(); },
  };
}
