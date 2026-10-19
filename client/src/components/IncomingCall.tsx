import { Phone, PhoneOff } from 'lucide-react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { gateway } from '../gateway';
import { native } from '../native';
import { sounds } from '../sounds';
import { HOME, channelLabel, dmRecipient, getState, selectChannel, useStore } from '../store';
import { useVoice, voice } from '../voice';
import { Avatar, GroupIcon } from './common';

/** Ringing overlay for incoming DM / group calls. */
export function IncomingCall() {
  const meId = useStore((s) => s.me?.id);
  const myVoice = useVoice((s) => s.channelId);
  const dnd = useStore((s) => s.me?.status === 'dnd');
  const ringingIds = useStore(
    useShallow((s) =>
      Object.values(s.calls)
        .filter((c) => meId && c.ringing.includes(meId) && s.channels[c.channel_id])
        .map((c) => c.channel_id),
    ),
  );
  const channelId = ringingIds.find((id) => id !== myVoice);
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  const label = useStore((s) => (channel ? channelLabel(s, channel) : ''));
  const caller = useStore((s) => {
    if (!channel) return undefined;
    if (channel.type === 'dm') return dmRecipient(s, channel);
    return Object.values(s.voiceStates).find((v) => v.channel_id === channel.id)?.user_id;
  });

  useEffect(() => {
    if (!channelId || dnd) return;
    sounds.ring();
    const timer = setInterval(sounds.ring, 2500);
    const s = getState();
    const c = s.channels[channelId];
    if (c) {
      native?.notify({ title: 'Chamada recebida', body: channelLabel(s, c), id: channelId });
      native?.flashFrame();
    }
    return () => clearInterval(timer);
  }, [channelId, dnd]);

  if (!channel) return null;

  const decline = () => gateway.send('call_decline', { channel_id: channel.id });
  const accept = () => {
    selectChannel(HOME, channel.id);
    void voice.join(null, channel.id);
  };

  return (
    <div className="incoming-call" role="alertdialog" aria-label="Chamada recebida">
      <div className="incoming-call-avatar">
        {caller && channel.type === 'dm' ? <Avatar userId={caller} size={80} /> : <GroupIcon channel={channel} size={80} />}
      </div>
      <strong className="truncate">{label}</strong>
      <span className="small muted">Chamada recebida…</span>
      <div className="incoming-call-actions">
        <button className="round-btn big hangup" title="Recusar" onClick={decline}>
          <PhoneOff size={22} />
        </button>
        <button className="round-btn big accept" title="Atender" onClick={accept}>
          <Phone size={22} />
        </button>
      </div>
    </div>
  );
}
