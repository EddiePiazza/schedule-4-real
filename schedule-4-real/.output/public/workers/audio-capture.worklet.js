// AudioWorklet processor for microphone capture
// Runs on a dedicated audio thread — zero main thread blocking.
// Accumulates Float32 samples → converts to Int16 → posts to main thread.

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._bufferSize = 2048 // ~42ms at 48kHz — good latency/efficiency balance
    this._buffer = new Float32Array(this._bufferSize)
    this._written = 0
    this._muted = false

    this.port.onmessage = (e) => {
      if (e.data.type === 'mute') this._muted = !!e.data.value
    }
  }

  process(inputs) {
    if (this._muted) return true

    const input = inputs[0]
    if (!input || !input[0]) return true

    const channelData = input[0]

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._written++] = channelData[i]

      if (this._written >= this._bufferSize) {
        // Convert Float32 [-1.0, 1.0] → Int16 [-32768, 32767]
        // Int16 = half the size of Float32, ideal for network transfer
        const pcm16 = new Int16Array(this._bufferSize)
        for (let j = 0; j < this._bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this._buffer[j]))
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }

        // Transfer ownership (zero-copy) to main thread
        this.port.postMessage(pcm16.buffer, [pcm16.buffer])

        this._buffer = new Float32Array(this._bufferSize)
        this._written = 0
      }
    }

    return true
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor)
