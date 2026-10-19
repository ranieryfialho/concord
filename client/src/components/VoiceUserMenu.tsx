import { ChevronDown, ChevronRight, LogOut, MicOff, Move, UserX, Volume2, VolumeX } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P } from '../permissions';
import { canGuild, highestPosition, nameOf, openModal, sortedGuildChannels, toast, useStore } from '../store';
import { useVoice, voice } from '../voice';
import { closeMenu, openMenu } from './ContextMenu';

/** Right-click (or the tile's ⋮ button) on someone in a voice channel. */
export function openVoiceUserMenu(e: MouseEvent, userId: string, guildId: string | null) {
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, <VoiceUserMenu userId={userId} guildId={guildId} />);
}

function run(promise: Promise<unknown>) {
  closeMenu();
  promise.catch((err: Error) => toast(err.message));
}

function VoiceUserMenu({ userId, guildId }: { userId: string; guildId: string | null }) {
  const meId = useStore((s) => s.me?.id);
  const isMe = userId === meId;
  const name = useStore((s) => nameOf(s, userId, guildId));
  const state = useStore((s) => s.voiceStates[userId]);
  const volume = useVoice((s) => s.userVolumes[userId] ?? 100);
  const mutedForMe = useVoice((s) => !!s.localMuted[userId]);
  const [moving, setMoving] = useState(false);

  const canMute = useStore((s) => !!guildId && canGuild(s, guildId, P.MUTE_MEMBERS));
  const canMove = useStore((s) => !!guildId && canGuild(s, guildId, P.MOVE_MEMBERS));
  const canKick = useStore(
    (s) =>
      !!guildId &&
      !isMe &&
      s.guilds[guildId]?.owner_id !== userId &&
      canGuild(s, guildId, P.KICK_MEMBERS) &&
      !!s.me &&
      highestPosition(s, guildId, userId) < highestPosition(s, guildId, s.me.id),
  );
  const voiceChannels = useStore(
    useShallow((s) => (guildId ? sortedGuildChannels(s, guildId).filter((c) => c.type === 'voice' && c.id !== state?.channel_id) : [])),
  );

  const patch = (body: object) => run(api(`/guilds/${guildId}/voice-states/${userId}`, { method: 'PATCH', body }));

  return (
    <>
      <div className="context-menu-title">{name}</div>

      {!isMe && (
        <div className="context-menu-volume">
          <label>
            <Volume2 size={15} /> Volume do usuário
            <span className="small muted">{mutedForMe ? 'mudo' : `${volume}%`}</span>
          </label>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={mutedForMe ? 0 : volume}
            onChange={(e) => {
              if (mutedForMe) voice.toggleLocalMute(userId);
              voice.setUserVolume(userId, Number(e.target.value));
            }}
            onDoubleClick={() => voice.setUserVolume(userId, 100)}
          />
        </div>
      )}
      {!isMe && (
        <button className="context-menu-item" onClick={() => voice.toggleLocalMute(userId)}>
          <VolumeX size={15} /> {mutedForMe ? 'Reativar o som para mim' : 'Silenciar para mim'}
        </button>
      )}

      {guildId && (canMute || canMove || canKick) && <div className="context-menu-sep" />}

      {canMute && state && (
        <button className="context-menu-item" onClick={() => patch({ mute: !state.server_mute })}>
          <MicOff size={15} /> {state.server_mute ? 'Remover silêncio no servidor' : 'Silenciar no servidor'}
        </button>
      )}
      {canMove && state && (
        <>
          <button className="context-menu-item" onClick={() => setMoving(!moving)} disabled={!voiceChannels.length}>
            <Move size={15} /> Mover para
            {moving ? <ChevronDown size={14} className="push-right" /> : <ChevronRight size={14} className="push-right" />}
          </button>
          {moving &&
            voiceChannels.map((c) => (
              <button key={c.id} className="context-menu-item nested" onClick={() => patch({ channel_id: c.id })}>
                <Volume2 size={14} /> {c.name}
              </button>
            ))}
          <button className="context-menu-item" onClick={() => patch({ channel_id: null })}>
            <LogOut size={15} /> Desconectar da voz
          </button>
        </>
      )}
      {canKick && (
        <button
          className="context-menu-item danger"
          onClick={() => {
            closeMenu();
            openModal({
              type: 'confirm',
              title: `Expulsar ${name}`,
              body: `${name} será removido do servidor e poderá voltar com um novo convite.`,
              confirmLabel: 'Expulsar',
              onConfirm: async () => {
                await api(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
                toast(`${name} foi expulso`);
              },
            });
          }}
        >
          <UserX size={15} /> Expulsar do servidor
        </button>
      )}
    </>
  );
}
