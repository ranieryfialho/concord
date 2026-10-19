import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useVoice, voice } from '../voice';

export function useMediaDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  return devices;
}

function Section({
  title,
  devices,
  selected,
  fallback,
  onPick,
}: {
  title: string;
  devices: MediaDeviceInfo[];
  selected: string;
  fallback: string;
  onPick: (id: string) => void;
}) {
  const options = [{ deviceId: '', label: 'Padrão do sistema' }, ...devices.filter((d) => d.deviceId !== 'default')];
  return (
    <div className="device-section">
      <div className="device-section-title">{title}</div>
      {options.map((d, i) => (
        <button key={d.deviceId || 'default'} className="device-item" onClick={() => onPick(d.deviceId)}>
          <span className="truncate">{d.label || `${fallback} ${i}`}</span>
          {selected === d.deviceId && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}

/** Popover listing input/output devices; anchored above its parent (position: relative). */
export function DeviceMenu({ kind, onClose }: { kind: 'audio' | 'video'; onClose: () => void }) {
  const devices = useMediaDevices();
  const inputDeviceId = useVoice((s) => s.inputDeviceId);
  const outputDeviceId = useVoice((s) => s.outputDeviceId);
  const videoDeviceId = useVoice((s) => s.videoDeviceId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDown));
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const pick = (fn: () => void) => {
    fn();
    onClose();
  };
  const unlabeled = devices.length > 0 && devices.every((d) => !d.label);

  return (
    <div className="device-menu" ref={ref}>
      {kind === 'audio' ? (
        <>
          <Section
            title="Microfone"
            devices={devices.filter((d) => d.kind === 'audioinput')}
            selected={inputDeviceId}
            fallback="Microfone"
            onPick={(id) => pick(() => void voice.setInputDevice(id))}
          />
          <Section
            title="Saída de áudio"
            devices={devices.filter((d) => d.kind === 'audiooutput')}
            selected={outputDeviceId}
            fallback="Alto-falante"
            onPick={(id) => pick(() => voice.setOutputDevice(id))}
          />
        </>
      ) : (
        <Section
          title="Câmera"
          devices={devices.filter((d) => d.kind === 'videoinput')}
          selected={videoDeviceId}
          fallback="Câmera"
          onPick={(id) => pick(() => void voice.setVideoDevice(id))}
        />
      )}
      {unlabeled && <p className="small muted device-hint">Permita o acesso ao dispositivo para ver os nomes.</p>}
    </div>
  );
}
