import { Crown, UserMinus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { colorHex } from '../permissions';
import { closeModal, hoistedRole, memberColor, nameOf, openModal, presenceOf, toast, useStore } from '../store';
import type { Channel } from '../types';
import { cx } from '../utils';
import { ActivityLine } from './Activity';
import { Avatar } from './common';

function MemberRow({ userId, guildId, offline, isOwner }: { userId: string; guildId: string | null; offline: boolean; isOwner: boolean }) {
  const name = useStore((s) => nameOf(s, userId, guildId));
  const custom = useStore((s) => s.users[userId]?.custom_status);
  const activity = useStore((s) => !!s.activities[userId]?.length);
  const color = useStore((s) => memberColor(s, guildId, userId));
  return (
    <div className={cx('member-row', offline && 'offline')} onClick={() => openModal({ type: 'profile', userId, guildId })}>
      <Avatar userId={userId} size={32} status={!offline} guildId={guildId} />
      <div className="member-text">
        <span className="truncate member-name" style={{ color: colorHex(color) }}>
          {name}
          {isOwner && <Crown size={13} className="role-icon owner" />}
        </span>
        {!offline && (activity ? <ActivityLine userId={userId} /> : custom && <span className="truncate small muted">{custom}</span>)}
      </div>
    </div>
  );
}

export function MemberList({ guildId }: { guildId: string }) {
  const ownerId = useStore((s) => s.guilds[guildId]?.owner_id);
  // Serialized so the selector result stays stable across unrelated store updates.
  const rows = useStore(
    useShallow((s) =>
      Object.values(s.members[guildId] ?? {})
        .map((m) => {
          const role = hoistedRole(s, guildId, m.user_id);
          return { id: m.user_id, role: role?.id ?? '', pos: role?.position ?? -1, presence: presenceOf(s, m.user_id), name: nameOf(s, m.user_id, guildId) };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map((r) => `${r.id}|${r.role}|${r.pos}|${r.presence}`),
    ),
  ).map((r) => {
    const [id, role, pos, presence] = r.split('|');
    return { id, role, pos: Number(pos), presence };
  });
  const roles = useStore((s) => s.roles[guildId]);

  const online = rows.filter((r) => r.presence !== 'offline');
  const offline = rows.filter((r) => r.presence === 'offline');
  const hoisted = [...new Set(online.filter((r) => r.role).map((r) => r.role))]
    .map((id) => roles?.[id])
    .filter((r) => !!r)
    .sort((a, b) => b!.position - a!.position);

  const sections: [string, typeof rows][] = [
    ...hoisted.map((role) => [role!.name, online.filter((r) => r.role === role!.id)] as [string, typeof rows]),
    ['Disponível', online.filter((r) => !r.role)],
    ['Offline', offline],
  ];

  return (
    <aside className="member-list scroll">
      {sections.map(
        ([title, list]) =>
          list.length > 0 && (
            <div key={title}>
              <h4 className="member-section">
                {title} — {list.length}
              </h4>
              {list.map((r) => (
                <MemberRow key={r.id} userId={r.id} guildId={guildId} offline={r.presence === 'offline'} isOwner={r.id === ownerId} />
              ))}
            </div>
          ),
      )}
    </aside>
  );
}

export function GroupMemberList({ channel }: { channel: Channel }) {
  const meId = useStore((s) => s.me?.id);
  const ids = useStore(
    useShallow((s) => [...(channel.recipient_ids ?? [])].sort((a, b) => nameOf(s, a).localeCompare(nameOf(s, b), 'pt-BR'))),
  );
  const offline = useStore(useShallow((s) => ids.map((id) => presenceOf(s, id) === 'offline')));
  const isOwner = channel.owner_id === meId;

  function remove(userId: string) {
    openModal({
      type: 'confirm',
      title: 'Remover do grupo',
      body: 'Essa pessoa deixará de ver as mensagens do grupo.',
      confirmLabel: 'Remover',
      onConfirm: async () => {
        await api(`/channels/${channel.id}/recipients/${userId}`, { method: 'DELETE' });
        closeModal();
      },
    });
  }

  return (
    <aside className="member-list scroll">
      <h4 className="member-section">Membros — {ids.length}</h4>
      {ids.map((id, i) => (
        <div key={id} className="group-member">
          <MemberRow userId={id} guildId={null} offline={offline[i]} isOwner={id === channel.owner_id} />
          {isOwner && id !== meId && (
            <button className="icon-btn group-member-remove" title="Remover do grupo" onClick={() => remove(id)}>
              <UserMinus size={16} />
            </button>
          )}
        </div>
      ))}
    </aside>
  );
}

export function leaveGroup(channel: Channel) {
  openModal({
    type: 'confirm',
    title: `Sair do grupo`,
    body: 'Você não poderá voltar a menos que alguém adicione você de novo.',
    confirmLabel: 'Sair do grupo',
    onConfirm: async () => {
      try {
        await api(`/channels/${channel.id}/recipients/@me`, { method: 'DELETE' });
        closeModal();
      } catch (e) {
        toast((e as Error).message);
      }
    },
  });
}
