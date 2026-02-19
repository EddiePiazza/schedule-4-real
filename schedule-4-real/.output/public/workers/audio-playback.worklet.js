// AudioWorklet processor for relay audio playback
// Ring buffer design handles network jitter smoothly without clicks.
// Receives Int16 PCM chunks from main thread, outputs Float32 to speakers.

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Ring buffer: 1 second capacity at 48kHz
    // Handles up to 1s of jitter before underrunning
    this._ringSize = 48000
    this._ring = new Float32Array(this._ringSize)
    this._writeIdx = 0
    this._readIdx = 0
    this._buffered = 0

    // Pre-buffer: accumulate this many samples before starting playback
    // ~100ms at 48kHz = 4800 samples, gives the jitter buffer time to fill
    this._preBufferThreshold = 4800
    this._started = false

    this.port.onmessage = (e) => {
      const data = e.data
      if (data instanceof ArrayBuffer) {
        const pcm16 = new Int16Array(data)
        for (let i = 0; i < pcm16.length; i++) {
          this._ring[this._writeIdx] = pcm16[i] / 32768.0
          this._writeIdx = (this._writeIdx + 1) % this._ringSize
          this._buffered = Math.min(this._buffered + 1, this._ringSize)
        }
        // Start playback once we have enough buffered
        if (!this._started && this._buffered >= this._preBufferThreshold) {
          this._started = true
        }
      } else if (data && data.type === 'reset') {
        // Reset ring buffer (e.g., when peer leaves)
        this._ring.fill(0)
        this._writeIdx = 0
        this._readIdx = 0
        this._buffered = 0
        this._started = false
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || !output[0]) return true

    const channel = output[0]

    if (!this._started) {
      // Still pre-buffering — output silence
      channel.fill(0)
      return true
    }

    for (let i = 0; i < channel.length; i++) {
      if (this._buffered > 0) {
        channel[i] = this._ring[this._readIdx]
        this._readIdx = (this._readIdx + 1) % this._ringSize
        this._buffered--
      } else {
        channel[i] = 0 // underrun — silence
      }
    }

    // If buffer ran dry, reset to pre-buffer state for next burst
    if (this._buffered === 0 && this._started) {
      this._started = false
    }

    return true
  }
}

registerProcessor('audio-playback-processor', AudioPlaybackProcessor)
