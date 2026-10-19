// Tiny synthesized UI sounds, so the app ships no audio assets.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tones(notes: [freq: number, start: number, duration: number][], volume = 0.08) {
  try {
    const ac = audio();
    for (const [freq, start, duration] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ac.currentTime + start;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }
  } catch {
    /* audio unavailable */
  }
}

export const sounds = {
  message: () => tones([[880, 0, 0.12], [1320, 0.08, 0.18]]),
  join: () => tones([[523, 0, 0.12], [784, 0.1, 0.2]]),
  leave: () => tones([[784, 0, 0.12], [523, 0.1, 0.2]]),
  mute: () => tones([[440, 0, 0.08]], 0.06),
  unmute: () => tones([[660, 0, 0.08]], 0.06),
  ring: () => tones([[660, 0, 0.18], [880, 0.2, 0.18], [660, 0.6, 0.18], [880, 0.8, 0.18]], 0.07),
};
