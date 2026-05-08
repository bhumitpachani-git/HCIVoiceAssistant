const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const AUDIO_CHUNK_SIZE = 1024;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function downsampleTo16k(samples: Float32Array, sourceRate: number) {
  if (sourceRate === INPUT_SAMPLE_RATE) {
    return samples;
  }

  const ratio = sourceRate / INPUT_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const result = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;

    for (let j = start; j < end; j += 1) {
      sum += samples[j];
    }

    result[i] = sum / Math.max(1, end - start);
  }

  return result;
}

function floatTo16BitPcm(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm;
}

const workletSource = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.frameSize = ${AUDIO_CHUNK_SIZE};
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (this.pending.length === 0) return;
    const chunk = new Float32Array(this.pending);
    this.pending = [];
    this.port.postMessage({ type: "chunk", chunk }, [chunk.buffer]);
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    for (let i = 0; i < input.length; i += 1) {
      this.pending.push(input[i]);
    }

    while (this.pending.length >= this.frameSize) {
      const chunk = new Float32Array(this.pending.splice(0, this.frameSize));
      this.port.postMessage({ type: "chunk", chunk }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

export class MicrophoneStreamer {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private sink?: GainNode;
  private flushResolver?: () => void;
  private isRunning = false;

  async start(onChunk: (base64Pcm16k: string) => void, onLevel?: (level: number) => void) {
    if (this.isRunning) {
      return;
    }

    this.context = new AudioContext({
      latencyHint: "interactive",
      sampleRate: INPUT_SAMPLE_RATE
    });
    await this.resumeContext();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));

      try {
        await this.context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }

      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, "pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;

      this.node.port.onmessage = (event: MessageEvent<{ type: string; chunk?: Float32Array }>) => {
        if (event.data?.type === "flushed") {
          this.flushResolver?.();
          this.flushResolver = undefined;
          return;
        }

        if (event.data?.type !== "chunk" || !event.data.chunk) {
          return;
        }

        if (onLevel) {
          let sum = 0;
          for (let i = 0; i < event.data.chunk.length; i += 1) {
            const sample = event.data.chunk[i];
            sum += sample * sample;
          }
          onLevel(Math.sqrt(sum / Math.max(1, event.data.chunk.length)));
        }

        const downsampled = downsampleTo16k(event.data.chunk, this.context?.sampleRate ?? INPUT_SAMPLE_RATE);
        const pcm = floatTo16BitPcm(downsampled);
        onChunk(arrayBufferToBase64(pcm.buffer));
      };

      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(this.context.destination);
      await this.resumeContext();
      this.isRunning = true;
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    await this.flushPendingAudio();
    await this.release();
    this.isRunning = false;
  }

  async flush() {
    if (!this.isRunning) {
      return;
    }

    await this.flushPendingAudio();
  }

  private async release() {
    this.node?.disconnect();
    this.sink?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }

    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.node = undefined;
    this.sink = undefined;
  }

  private async resumeContext() {
    if (this.context?.state === "suspended") {
      await this.context.resume().catch(() => undefined);
    }
  }

  private flushPendingAudio() {
    if (!this.node) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        this.flushResolver = undefined;
        resolve();
      }, 120);

      this.flushResolver = () => {
        window.clearTimeout(timeout);
        resolve();
      };

      this.node?.port.postMessage({ type: "flush" });
    });
  }
}

export class PcmPlayer {
  private context?: AudioContext;
  private nextStartAt = 0;
  private idleTimer?: number;
  private onIdle?: () => void;
  private activeSources = new Set<AudioBufferSourceNode>();

  setOnIdle(onIdle?: () => void) {
    this.onIdle = onIdle;
  }

  async resume() {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  async playBase64Pcm(base64Pcm24k: string) {
    const context = this.ensureContext();
    await this.resume();

    const buffer = base64ToArrayBuffer(base64Pcm24k);
    const pcm = new Int16Array(buffer);
    const audioBuffer = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);

    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      source.disconnect();
    };

    const startAt = Math.max(context.currentTime + 0.02, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + audioBuffer.duration;
    this.scheduleIdleCallback(context);
  }

  interrupt() {
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    this.nextStartAt = 0;

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Source may already be ended by the time we interrupt.
      }

      source.disconnect();
    }

    this.activeSources.clear();
  }

  async stop() {
    this.interrupt();
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
    this.context = undefined;
  }

  hasPendingPlayback() {
    if (this.activeSources.size > 0) {
      return true;
    }

    if (!this.context) {
      return false;
    }

    return this.nextStartAt > this.context.currentTime + 0.05;
  }

  private ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }

    return this.context;
  }

  private scheduleIdleCallback(context: AudioContext) {
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    if (!this.onIdle) {
      return;
    }

    const delayMs = Math.max(0, this.nextStartAt - context.currentTime) * 1000 + 40;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = undefined;

      if (!this.context || !this.onIdle) {
        return;
      }

      if (this.nextStartAt > this.context.currentTime + 0.05) {
        this.scheduleIdleCallback(this.context);
        return;
      }

      this.nextStartAt = 0;
      this.onIdle();
    }, delayMs);
  }
}
