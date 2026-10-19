import { create } from 'zustand';
import { voice } from './voice';

// "New version available": the server tells us which client build it serves (READY.client_build, and
// APP_UPDATE when a deploy swaps the files under a running server). If it differs from the build we are
// running, the app shows a banner whose button reloads into the new version. The desktop shell loads the
// app from the server, so a reload updates it too.

declare const __BUILD_ID__: string;

export const RUNNING_BUILD = __BUILD_ID__;

interface UpdateState {
  available: string | null;
  /** Hidden with "Depois" until this time. */
  snoozedUntil: number;
}

export const useUpdate = create<UpdateState>()(() => ({ available: null, snoozedUntil: 0 }));

const SNOOZE_MS = 30 * 60_000;

export function serverBuild(build: string | null | undefined) {
  if (!build || RUNNING_BUILD === 'dev' || build === RUNNING_BUILD) return;
  useUpdate.setState({ available: build });
}

export function snoozeUpdate() {
  useUpdate.setState({ snoozedUntil: Date.now() + SNOOZE_MS });
  setTimeout(() => useUpdate.setState({ snoozedUntil: 0 }), SNOOZE_MS);
}

export function restartToUpdate() {
  voice.leave();
  location.reload();
}
