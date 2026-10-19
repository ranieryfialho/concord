import { Check, MonitorUp, MonitorX } from 'lucide-react';
import type { MouseEvent } from 'react';
import { native } from '../native';
import { openModal } from '../store';
import { STREAM_QUALITIES, type StreamQuality, useVoice, voice } from '../voice';
import { CheckItem, MenuItem, MenuSep, SubMenu, closeMenu, openMenuAt } from './ContextMenu';

/** Starts a screen share (or swaps the current one): our own source picker on desktop, the browser's elsewhere. */
export function pickScreen(replace = false) {
  if (native) openModal({ type: 'screenPicker', replace });
  else void (replace ? voice.replaceScreenShare() : voice.startScreenShare());
}

/** The screen-share button: starts sharing, or opens the stream options while live. */
export function onScreenShareClick(e: MouseEvent<HTMLElement>) {
  if (!useVoice.getState().selfStream) return pickScreen();
  openMenuAt(e.currentTarget, <StreamMenu />, 'above');
}

function StreamMenu() {
  const quality = useVoice((s) => s.streamQuality);
  const audio = useVoice((s) => s.streamAudio);
  const hasAudio = useVoice((s) => !!s.localScreen?.getAudioTracks().length);
  return (
    <>
      <MenuItem
        danger
        onClick={() => {
          closeMenu();
          voice.stopScreenShare();
        }}
      >
        <MonitorX size={15} /> Parar de transmitir
      </MenuItem>
      <MenuItem
        onClick={() => {
          closeMenu();
          pickScreen(true);
        }}
      >
        <MonitorUp size={15} /> Alterar a transmissão
      </MenuItem>
      <MenuSep />
      <SubMenu label="Qualidade da transmissão">
        {(Object.keys(STREAM_QUALITIES) as StreamQuality[]).map((q) => (
          <MenuItem key={q} onClick={() => void voice.setStreamQuality(q)}>
            {STREAM_QUALITIES[q].label}
            <span className={`menu-check push-right${quality === q ? ' on' : ''}`}>{quality === q && <Check size={12} strokeWidth={3} />}</span>
          </MenuItem>
        ))}
      </SubMenu>
      <CheckItem
        label="Compartilhar áudio da transmissão"
        checked={audio && hasAudio}
        onChange={() => voice.setStreamAudio(!(audio && hasAudio))}
      />
    </>
  );
}
