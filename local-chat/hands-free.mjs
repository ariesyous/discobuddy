import { openMicrophone } from './audio.mjs';

const worklets = new WeakMap();

export async function openHandsFree(context, { signal, maxSeconds, playbackOutput, onEvent, onError }) {
  if (!worklets.has(context)) {
    worklets.set(context, context.audioWorklet.addModule(new URL('./mic-worklet.mjs', import.meta.url)).catch((error) => {
      worklets.delete(context);
      throw error;
    }));
  }
  await worklets.get(context);
  if (signal.aborted) return;

  const stream = await openMicrophone();
  const tracks = stream.getTracks();
  let source;
  let processor;
  let referenceConnected = false;
  const stop = () => {
    for (const track of tracks) track.stop();
    source?.disconnect();
    if (processor) {
      if (referenceConnected) playbackOutput.disconnect(processor);
      processor.disconnect();
      processor.port.close();
    }
  };
  if (signal.aborted) {
    stop();
    return;
  }

  try {
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, 'discobuddy-microphone', {
      numberOfInputs: 2,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions: { maxSeconds },
    });
    let listenId = 0;
    processor.port.onmessage = ({ data }) => {
      if (!signal.aborted && data.id === listenId) onEvent(data);
    };
    processor.addEventListener('processorerror', () => onError(new Error('The microphone audio processor stopped.')));
    for (const track of tracks) track.addEventListener('ended', () => onError(new Error('The microphone disconnected.')));
    source.connect(processor);
    playbackOutput.connect(processor, 0, 1);
    referenceConnected = true;
    // Keep the processor running without routing microphone audio to the speakers.
    processor.connect(context.destination);
    signal.addEventListener('abort', stop, { once: true });
    return (listening) => processor.port.postMessage({ listening, id: ++listenId });
  } catch (error) {
    stop();
    throw error;
  }
}
