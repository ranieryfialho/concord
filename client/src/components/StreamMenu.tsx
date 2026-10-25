import { Check, MonitorUp, MonitorX, Plus } from 'lucide-react';
import type { MouseEvent } from 'react';
import { native } from '../native';
import { openModal } from '../store';
import { MAX_SCREENS, STREAM_QUALITIES, type StreamQuality, useVoice, voice } from '../voice';
import { CheckItem, MenuItem, MenuSep, SubMenu, closeMenu, openMenuAt } from './ContextMenu';

/**
 * Starts a screen share, adds another one, or (replace) swaps screen `index` for a new source: our own
 * source picker on desktop, the browser's elsewhere.
 */
export function pickScreen(replace = false, index = 0) {
  if (native) openModal({ type: 'screenPicker', replace, index });
  else void (replace ? voice.replaceScreenShare(useVoice.getState().localScreens[index]) : voice.startScreenShare());
}

/** The screen-share button: starts sharing, or opens the stream options while live. */
export function onScreenShareClick(e: MouseEvent<HTMLElement>) {
  if (!useVoice.getState().selfStream) return pickScreen();
  openMenuAt(e.currentTarget, <StreamMenu />, 'above');
}

function StreamMenu() {
  const quality = useVoice((s) => s.streamQuality);
  const audio = useVoice((s) => s.streamAudio);
  const screens = useVoice((s) => s.localScreens);
  const hasAudio = screens.some((x) => x.getAudioTracks().length > 0);
  const act = (fn: () => void) => () => {
    closeMenu();
    fn();
  };
  return (
    <>
      {screens.length < MAX_SCREENS && (
        <MenuItem onClick={act(() => pickScreen())}>
          <Plus size={15} /> Transmitir outra tela
        </MenuItem>
      )}
      {screens.length > 1 ? (
        <>
          {screens.map((s, i) => (
            <MenuItem key={s.id} onClick={act(() => pickScreen(true, i))}>
              <MonitorUp size={15} /> Trocar a tela {i + 1}
            </MenuItem>
          ))}
          {screens.map((s, i) => (
            <MenuItem key={s.id} danger onClick={act(() => voice.stopScreenShare(s))}>
              <MonitorX size={15} /> Parar a tela {i + 1}
            </MenuItem>
          ))}
          <MenuItem danger onClick={act(() => voice.stopScreenShare())}>
            <MonitorX size={15} /> Parar todas
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={act(() => pickScreen(true))}>
            <MonitorUp size={15} /> Alterar a transmissão
          </MenuItem>
          <MenuItem danger onClick={act(() => voice.stopScreenShare())}>
            <MonitorX size={15} /> Parar de transmitir
          </MenuItem>
        </>
      )}
      <MenuSep />
      <SubMenu label={screens.length > 1 ? 'Qualidade da tela 1' : 'Qualidade da transmissão'}>
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
