// Bridge exposed by the desktop shell's preload (desktop/preload.js). Absent in the browser.

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
}

declare global {
  interface Window {
    ConcordNative?: ConcordNative;
  }
}

export const native: ConcordNative | undefined = window.ConcordNative;
