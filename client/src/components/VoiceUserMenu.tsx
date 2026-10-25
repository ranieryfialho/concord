import { Check, Monitor, Volume2 } from 'lucide-react';
import { type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P, colorHex } from '../permissions';
import { canGuild, copyText, highestPosition, nameOf, openModal, sortedGuildChannels, sortedRoles, toast, useStore } from '../store';
import { useVoice, voice } from '../voice';
import { mentionInComposer } from './Composer';
import { CheckItem, MenuItem, MenuSep, SubMenu, closeMenu, openMenu } from './ContextMenu';

/** Right-click (or the tile's ⋮ button) on someone, in a voice channel or its member list. */
export function openVoiceUserMenu(e: MouseEvent, userId: string, guildId: string | null) {
  e.preventDefault();
  e.stopPropagation();
  openVoiceUserMenuAt(e.clientX, e.clientY, userId, guildId);
}

/** Same menu at viewport coordinates, for a touch-and-hold. */
export function openVoiceUserMenuAt(x: number, y: number, userId: string, guildId: string | null) {
  openMenu(x, y, <VoiceUserMenu userId={userId} guildId={guildId} />);
}

function run(promise: Promise<unknown>, keepOpen = false) {
  if (!keepOpen) closeMenu();
  promise.catch((err: Error) => toast(err.message));
}

function VolumeSlider(props: { label: string; icon: ReactNode; value: number; muted: boolean; onChange: (v: number) => void }) {
  return (
    <div className="context-menu-volume">
      <label>
        {props.icon} {props.label}
        <span className="small muted">{props.muted ? 'mudo' : `${props.value}%`}</span>
      </label>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={props.muted ? 0 : props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => props.onChange(100)}
        title="Clique duas vezes para voltar a 100%"
      />
    </div>
  );
}

function RolesMenu({ guildId, userId }: { guildId: string; userId: string }) {
  const myTop = useStore((s) => (s.me ? highestPosition(s, guildId, s.me.id) : 0));
  const roles = useStore(useShallow((s) => sortedRoles(s, guildId).filter((r) => r.id !== guildId)));
  const has = useStore(useShallow((s) => s.members[guildId]?.[userId]?.role_ids ?? []));
  if (!roles.length) return <div className="context-menu-empty">Este servidor ainda não tem cargos.</div>;
  return (
    <>
      {roles.map((r) => {
        const checked = has.includes(r.id);
        return (
          <button
            key={r.id}
            className="context-menu-item"
            disabled={r.position >= myTop}
            title={r.position >= myTop ? 'Só dá para atribuir cargos abaixo do seu' : undefined}
            onClick={() => run(api(`/guilds/${guildId}/members/${userId}/roles/${r.id}`, { method: checked ? 'DELETE' : 'PUT' }), true)}
          >
            <span className="role-dot" style={{ background: colorHex(r.color) ?? 'var(--text-muted)' }} />
            <span className="truncate">{r.name}</span>
            <span className={`menu-check push-right${checked ? ' on' : ''}`}>{checked && <Check size={12} strokeWidth={3} />}</span>
          </button>
        );
      })}
    </>
  );
}

function VoiceUserMenu({ userId, guildId }: { userId: string; guildId: string | null }) {
  const meId = useStore((s) => s.me?.id);
  const isMe = userId === meId;
  const name = useStore((s) => nameOf(s, userId, guildId));
  const username = useStore((s) => s.users[userId]?.username ?? '');
  const state = useStore((s) => s.voiceStates[userId]);
  const inMyCall = useVoice((s) => !!s.channelId && s.channelId === state?.channel_id);
  const volume = useVoice((s) => s.userVolumes[userId] ?? 100);
  const mutedForMe = useVoice((s) => !!s.localMuted[userId]);
  const streamVolume = useVoice((s) => s.streamVolumes[userId] ?? 100);
  const streamMuted = useVoice((s) => !!s.streamMuted[userId]);
  const selfMute = useVoice((s) => s.selfMute);
  const selfDeaf = useVoice((s) => s.selfDeaf);
  const selfAfk = useVoice((s) => s.selfAfk);

  const isOwnerTarget = useStore((s) => !!guildId && s.guilds[guildId]?.owner_id === userId);
  const outranks = useStore((s) => !!guildId && !!s.me && highestPosition(s, guildId, userId) < highestPosition(s, guildId, s.me.id));
  const canMute = useStore((s) => !!guildId && canGuild(s, guildId, P.MUTE_MEMBERS));
  const canMove = useStore((s) => !!guildId && canGuild(s, guildId, P.MOVE_MEMBERS));
  const canKick = useStore((s) => !!guildId && !isMe && !isOwnerTarget && canGuild(s, guildId, P.KICK_MEMBERS) && outranks);
  const canRoles = useStore((s) => !!guildId && canGuild(s, guildId, P.MANAGE_ROLES));
  const canNick = useStore(
    (s) => !!guildId && (isMe || (canGuild(s, guildId, P.MANAGE_NICKNAMES) && !isOwnerTarget && outranks)),
  );
  const voiceChannels = useStore(
    useShallow((s) => (guildId ? sortedGuildChannels(s, guildId).filter((c) => c.type === 'voice' && c.id !== state?.channel_id) : [])),
  );

  const patchVoice = (body: object) => run(api(`/guilds/${guildId}/voice-states/${userId}`, { method: 'PATCH', body }));

  return (
    <>
      <div className="context-menu-title">{name}</div>
      <MenuItem
        onClick={() => {
          closeMenu();
          openModal({ type: 'profile', userId, guildId });
        }}
      >
        Perfil
      </MenuItem>
      <MenuItem
        onClick={() => {
          closeMenu();
          mentionInComposer(username);
        }}
      >
        Mencionar
      </MenuItem>

      {!isMe && inMyCall && (
        <>
          <MenuSep />
          <VolumeSlider label="Volume do usuário" icon={<Volume2 size={15} />} value={volume} muted={mutedForMe} onChange={(v) => voice.setUserVolume(userId, v)} />
          {state?.self_stream && (
            <VolumeSlider
              label="Volume da transmissão"
              icon={<Monitor size={15} />}
              value={streamVolume}
              muted={streamMuted}
              onChange={(v) => voice.setStreamVolume(userId, v)}
            />
          )}
        </>
      )}

      {(isMe ? !!state : inMyCall) && <MenuSep />}
      {isMe && state && (
        <>
          <CheckItem label="Silenciar" checked={selfMute} onChange={() => voice.setMute(!selfMute)} />
          <CheckItem label="Desativar áudio" checked={selfDeaf} onChange={() => voice.setDeaf(!selfDeaf)} />
          <CheckItem label="AFK" checked={selfAfk} onChange={() => voice.setAfk(!selfAfk)} />
        </>
      )}
      {!isMe && inMyCall && (
        <>
          <CheckItem label="Silenciar" checked={mutedForMe} onChange={() => voice.toggleLocalMute(userId)} />
          {state?.self_stream && <CheckItem label="Silenciar transmissão" checked={streamMuted} onChange={() => voice.toggleStreamMute(userId)} />}
        </>
      )}

      {guildId && (canNick || canRoles || (canMove && state)) && <MenuSep />}
      {guildId && canNick && (
        <MenuItem
          onClick={() => {
            closeMenu();
            openModal({ type: 'nickname', guildId, userId });
          }}
        >
          {isMe ? 'Editar perfil por servidor' : 'Alterar apelido'}
        </MenuItem>
      )}
      {guildId && canRoles && (
        <SubMenu label="Cargo">
          <RolesMenu guildId={guildId} userId={userId} />
        </SubMenu>
      )}
      {guildId && canMove && state && (
        <SubMenu label="Mover para" disabled={!voiceChannels.length}>
          {voiceChannels.map((c) => (
            <MenuItem key={c.id} onClick={() => patchVoice({ channel_id: c.id })}>
              <Volume2 size={14} /> <span className="truncate">{c.name}</span>
            </MenuItem>
          ))}
        </SubMenu>
      )}

      {guildId && state && (canMute || canMove) && <MenuSep />}
      {guildId && state && canMute && (
        <>
          <CheckItem danger label="Silenciar voz no servidor" checked={state.server_mute} onChange={() => patchVoice({ mute: !state.server_mute })} />
          <CheckItem danger label="Desativar áudio no servidor" checked={state.server_deaf} onChange={() => patchVoice({ deaf: !state.server_deaf })} />
        </>
      )}
      {guildId && state && canMove && (
        <MenuItem danger onClick={() => patchVoice({ channel_id: null })}>
          Desconectar da voz
        </MenuItem>
      )}
      {canKick && (
        <MenuItem
          danger
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
          Expulsar do servidor
        </MenuItem>
      )}

      <MenuSep />
      <MenuItem
        onClick={() => {
          closeMenu();
          copyText(userId, 'ID copiado!');
        }}
      >
        Copiar ID do usuário <span className="id-chip push-right">ID</span>
      </MenuItem>
    </>
  );
}
