import { useEffect, useRef, useState } from 'react';
import { MicPipeline, micSettings } from '../mic';
import { toast } from '../store';
import { cx } from '../utils';
import { useVoice, voice } from '../voice';

const MIN_DB = -100;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100));

export interface MicReading {
  level: number;
  threshold: number | null;
  open: boolean;
}

/**
 * Live input level as a bar of segments: green while the sensitivity gate is open (you are being
 * transmitted), grey below it. With `onThreshold`, the bar doubles as the manual sensitivity slider.
 */
export function MicMeter({ read, onThreshold, threshold }: { read: () => MicReading | null; onThreshold?: (db: number) => void; threshold?: number }) {
  const [r, setR] = useState<MicReading | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 33) {
        last = t;
        setR(read());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read]);

  const level = r ? pct(r.level) : 0;
  const marker = onThreshold && threshold !== undefined ? threshold : r?.threshold ?? null;
  return (
    <div className={cx('mic-meter', !r && 'idle', onThreshold && 'adjustable')}>
      <div className="mic-meter-track">
        <div className={cx('mic-meter-fill', r?.open && 'open')} style={{ width: `${level}%` }} />
        {marker !== null && <div className="mic-meter-marker" style={{ left: `${pct(marker)}%` }} />}
      </div>
      {onThreshold && (
        <input
          type="range"
          min={MIN_DB}
          max={0}
          step={1}
          value={threshold ?? -50}
          onChange={(e) => onThreshold(Number(e.target.value))}
          aria-label="Sensibilidade de entrada"
          title={`${threshold} dB`}
        />
      )}
    </div>
  );
}

/** Microphone test outside a call: opens the mic with the current settings and plays it back. */
export function useMicTest() {
  const [pipe, setPipe] = useState<MicPipeline | null>(null);
  const stopMonitor = useRef<(() => void) | null>(null);
  const prefs = useVoice();
  const settings = micSettings(prefs);
  const reopenKey = `${prefs.inputDeviceId}|${settings.echoCancellation}|${settings.noiseSuppression}|${settings.autoGainControl}`;
  const [running, setRunning] = useState(false);

  const inCall = !!prefs.channelId;

  // In a call the microphone is already open: listen to it instead of opening a second capture.
  useEffect(() => {
    if (!running || !inCall) return;
    const stop = voice.monitorMic();
    if (!stop) {
      toast('Seu microfone não está aberto nesta chamada');
      setRunning(false);
    }
    return () => stop?.();
  }, [running, inCall, reopenKey]);

  // (Re)open when started or when a setting that needs a new capture changes.
  useEffect(() => {
    if (!running || inCall) return;
    let cancelled = false;
    let opened: MicPipeline | null = null;
    MicPipeline.open(prefs.inputDeviceId, micSettings(useVoice.getState()))
      .then((p) => {
        if (cancelled) return p.stop();
        opened = p;
        setPipe(p);
        stopMonitor.current = p.monitor(useVoice.getState().outputDeviceId);
      })
      .catch(() => {
        toast('Não foi possível acessar o microfone');
        setRunning(false);
      });
    return () => {
      cancelled = true;
      stopMonitor.current?.();
      stopMonitor.current = null;
      opened?.stop();
      setPipe(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, inCall, reopenKey]);

  // Volume and sensitivity apply live.
  useEffect(() => {
    pipe?.setVolume(settings.volume);
    pipe?.setGate(settings.gate);
  }, [pipe, settings.volume, settings.gate]);

  return { running, toggle: () => setRunning((r) => !r), pipe };
}

/** Reads the call's microphone when connected, otherwise the test pipeline (if any). */
export function useMicReader(test: MicPipeline | null): () => MicReading | null {
  const testRef = useRef(test);
  testRef.current = test;
  const [read] = useState(() => () => {
    const t = testRef.current;
    if (t) return { level: t.level, threshold: t.threshold(), open: t.open };
    return voice.micLevel();
  });
  return read;
}
