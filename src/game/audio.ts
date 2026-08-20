export class RideAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private wind?: GainNode;
  private chain?: GainNode;
  private timer = 0;

  start(): void {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = 0.45;
    this.master.connect(this.context.destination);

    const noiseBuffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = this.context.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 850;
    this.wind = this.context.createGain();
    this.wind.gain.value = 0;
    noise.connect(filter).connect(this.wind).connect(this.master);
    noise.start();

    const oscillator = this.context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 54;
    this.chain = this.context.createGain();
    this.chain.gain.value = 0;
    oscillator.connect(this.chain).connect(this.master);
    oscillator.start();
  }

  update(speed: number, pedal: number, dt: number): void {
    if (!this.context || !this.wind || !this.chain) return;
    const time = this.context.currentTime;
    this.wind.gain.setTargetAtTime(Math.min(speed / 15, 1) * 0.19, time, 0.12);
    this.chain.gain.setTargetAtTime(pedal * Math.min(speed / 5, 1) * 0.035, time, 0.05);
    this.timer += dt;
    if (pedal > 0 && speed > 1 && this.timer > Math.max(0.24, 0.62 - speed * 0.025)) {
      this.timer = 0;
      this.tick();
    }
  }

  setVolume(value: number): void {
    if (this.master && this.context) this.master.gain.setTargetAtTime(value * 0.55, this.context.currentTime, 0.05);
  }

  milestone(): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(520, this.context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(780, this.context.currentTime + 0.7);
    gain.gain.setValueAtTime(0, this.context.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, this.context.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 1.2);
    oscillator.connect(gain).connect(this.master);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 1.25);
  }

  private tick(): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = 98;
    gain.gain.setValueAtTime(0.018, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.035);
    oscillator.connect(gain).connect(this.master);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.04);
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
