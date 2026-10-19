import { Download, Plus } from 'lucide-react';
import { HOME, dmChannels, guildMentions, guildUnread, openModal, selectGuild, useStore } from '../store';
import { native } from '../native';
import { cx } from '../utils';
import { GuildIcon } from './common';

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return <span className="badge rail-badge">{count > 99 ? '99+' : count}</span>;
}

function GuildButton({ guildId }: { guildId: string }) {
  const active = useStore((s) => s.view.guildId === guildId);
  const unread = useStore((s) => guildUnread(s, guildId));
  const mentions = useStore((s) => guildMentions(s, guildId));
  const name = useStore((s) => s.guilds[guildId]?.name);
  return (
    <div className={cx('rail-item', active && 'active', unread && 'unread')}>
      <span className="rail-pill" />
      <button className="rail-button" onClick={() => selectGuild(guildId)} title={name}>
        <GuildIcon guildId={guildId} />
      </button>
      <Badge count={mentions} />
    </div>
  );
}

export function ServerRail() {
  const guildOrder = useStore((s) => s.guildOrder);
  const homeActive = useStore((s) => s.view.guildId === HOME);
  const dmMentions = useStore((s) => dmChannels(s).reduce((n, c) => n + (s.mentionCounts[c.id] ?? 0), 0));
  const pending = useStore((s) => Object.values(s.relationships).filter((t) => t === 'pending_in').length);

  return (
    <nav className="rail" aria-label="Servidores">
      <div className={cx('rail-item', homeActive && 'active')}>
        <span className="rail-pill" />
        <button className="rail-button home" onClick={() => selectGuild(HOME)} title="Mensagens diretas">
          <span className="brand-mark">C</span>
        </button>
        <Badge count={dmMentions + pending} />
      </div>
      <div className="rail-separator" />
      {guildOrder.map((id) => (
        <GuildButton key={id} guildId={id} />
      ))}
      <div className="rail-item">
        <button className="rail-button add" onClick={() => openModal({ type: 'createGuild' })} title="Adicionar um servidor">
          <Plus size={24} />
        </button>
      </div>
      {!native && (
        <div className="rail-item">
          <a className="rail-button download" href="/download" target="_blank" rel="noreferrer" title="Baixar o app para desktop">
            <Download size={22} />
          </a>
        </div>
      )}
    </nav>
  );
}
