import { fileUrl } from './api';
import { gateway } from './gateway';
import { native } from './native';
import { getState, nameOf, useStore } from './store';
import { colorFor } from './utils';
import { useVoice } from './voice';

// Desktop only: forwards what the shell detects (game, Rich Presence apps) to the server, and keeps the
// shell's voice overlay fed with the people in your voice channel. READY re-sends the activity after a
// reconnect (gateway.ts).

export const ACTIVITY_VERB: Record<number, string> = { 0: 'Jogando', 2: 'Ouvindo', 3: 'Assistindo', 5: 'Competindo em' };

export function initActivity(): () => void {
  if (!native?.activity) return () => {};
  const offActivity = native.activity.onChange((activities) => gateway.send('activity_update', { activities }));
  if (!native.overlay) return offActivity;

  let last = '';
  const feed = () => {
    const s = getState();
    const v = useVoice.getState();
    const members = v.channelId
      ? Object.values(s.voiceStates)
          .filter((st) => st.channel_id === v.channelId)
          .map((st) => {
            const user = s.users[st.user_id];
            const avatar = fileUrl(user?.avatar_url);
            return {
              name: nameOf(s, st.user_id, st.guild_id),
              avatar: avatar ? new URL(avatar, location.href).href : '',
              color: colorFor(st.user_id),
              speaking: !!v.speaking[st.user_id],
              mute: st.self_mute || st.suppress || st.server_mute,
              deaf: st.self_deaf || st.server_deaf,
            };
          })
      : [];
    const json = JSON.stringify(members);
    if (json === last) return;
    last = json;
    native!.overlay!.update(members);
  };
  const offStore = useStore.subscribe(feed);
  const offVoice = useVoice.subscribe(feed);
  feed();
  return () => {
    offActivity();
    offStore();
    offVoice();
    native?.overlay?.update([]);
  };
}
