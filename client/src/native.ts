// Bridge exposed by the desktop shell's preload (desktop/preload.js). Absent in the browser.

import type { Activity } from './types';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface ConcordNative {
  platform: string;
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  };
  notify(opts: { title: string; body: string; id: string }): void;
  onNotificationClick(cb: (id: string) => void): () => void;
  setBadge(count: number): void;
  flashFrame(): void;
  screen: {
    getSources(): Promise<ScreenSource[]>;
    select(id: string): void;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** Detected game + Rich Presence apps (desktop 0.1.2+). */
  activity?: {
    get(): Promise<Activity[]>;
    onChange(cb: (activities: Activity[]) => void): () => void;
    runningPrograms(): Promise<RunningProgram[]>;
    games: {
      list(): Promise<CustomGame[]>;
      add(game: CustomGame): Promise<void>;
      remove(exe: string): Promise<void>;
    };
  };
  overlay?: {
    update(members: OverlayMember[]): void;
  };
  /** Self-update (desktop 0.1.2+). Older shells lack it and are pointed at /download instead. */
  updates?: {
    getState(): Promise<DesktopUpdateState | null>;
    onState(cb: (state: DesktopUpdateState) => void): () => void;
    install(): void;
    /** Desktop 0.1.5+. */
    check?(): void;
  };
}

export interface CustomGame {
  exe: string;
  name: string;
}

export interface RunningProgram extends CustomGame {
  /** Name in the built-in game list, when it is one. */
  known: string | null;
}

export interface OverlayMember {
  name: string;
  avatar: string;
  color: string;
  speaking: boolean;
  mute: boolean;
  deaf: boolean;
}

export interface DesktopUpdateState {
  status: 'idle' | 'downloading' | 'ready' | 'manual';
  current: string;
  version: string | null;
  percent: number;
}

declare global {
  interface Window {
    ConcordNative?: ConcordNative;
  }
}

export const native: ConcordNative | undefined = window.ConcordNative;
