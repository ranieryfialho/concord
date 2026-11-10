import { useEffect } from 'react';
import { initActivity } from '../activity';
import { openChannel } from '../gateway';
import { native } from '../native';
import { HOME, ackChannel, getState, openModal, totalMentions, useStore } from '../store';
import { hasUnseenRelease } from '../changelog';
import { initDesktopUpdates } from '../update';
import { ChatView } from './ChatView';
import { ContextMenuHost } from './ContextMenu';
import { PushToTalkListener } from './PushToTalk';
import { UpdateBanner } from './UpdateBanner';
import { FriendsView } from './FriendsView';
import { GuildSidebar } from './GuildSidebar';
import { HomeSidebar } from './HomeSidebar';
import { IncomingCall } from './IncomingCall';
import { Modals } from './Modals';
import { ServerRail } from './ServerRail';
import { UserPanel } from './UserPanel';
import { VoiceView } from './VoiceView';
import { ResizablePanel, useIsMobile } from './common';

export function Layout() {
  const view = useStore((s) => s.view);
  const mobilePane = useStore((s) => s.mobilePane);
  const mobile = useIsMobile();
  const channel = useStore((s) => (s.view.channelId ? s.channels[s.view.channelId] : undefined));
  const mentions = useStore(totalMentions);
  const toastMessage = useStore((s) => s.toast);
  const guildName = useStore((s) => (s.view.guildId !== HOME ? s.guilds[s.view.guildId]?.name : undefined));

  useEffect(() => {
    native?.setBadge(mentions);
    const label = channel?.type === 'text' ? `#${channel.name}` : channel?.name ?? guildName ?? 'Concord';
    document.title = `${mentions ? `(${mentions}) ` : ''}${label} · Concord`;
  }, [mentions, channel, guildName]);

  useEffect(() => native?.onNotificationClick((id) => openChannel(id)), []);
  useEffect(initDesktopUpdates, []);
  useEffect(initActivity, []);
  // Patch notes once per release, unless something else is already on screen.
  useEffect(() => {
    if (hasUnseenRelease() && !getState().modal) openModal({ type: 'patchNotes' });
  }, []);

  useEffect(() => {
    const onFocus = () => {
      const id = getState().view.channelId;
      if (id) ackChannel(id);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const sidebar = (
    <aside className="sidebar">
      {view.guildId === HOME ? <HomeSidebar /> : <GuildSidebar key={view.guildId} guildId={view.guildId} />}
      <UserPanel />
    </aside>
  );

  let main;
  if (channel?.type === 'voice') main = <VoiceView channel={channel} />;
  else if (channel && channel.type !== 'category') main = <ChatView key={channel.id} channel={channel} />;
  else if (view.guildId === HOME) main = <FriendsView />;
  else
    main = (
      <div className="empty-state">
        <h2>Nenhum canal de texto</h2>
        <p className="muted">Crie um canal para começar a conversar.</p>
      </div>
    );

  return (
    <div className={`layout pane-${mobilePane}`}>
      <ServerRail />
      {mobile ? (
        sidebar
      ) : (
        <ResizablePanel side="left" storageKey="concord.sidebarWidth" initial={248} min={200} max={440}>
          {sidebar}
        </ResizablePanel>
      )}
      {/* Phone: mount the channel only once it is shown, so the composer sizes and focuses against a visible layout. */}
      <main className="main">{mobile && mobilePane === 'nav' ? null : main}</main>
      <Modals />
      <IncomingCall />
      <ContextMenuHost />
      <PushToTalkListener />
      <UpdateBanner />
      {toastMessage && <div className="toast">{toastMessage}</div>}
    </div>
  );
}
