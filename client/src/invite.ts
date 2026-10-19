import { openModal } from './store';

// Invite links: https://<server>/invite/<code>. The server answers any path with the app, which picks the
// code up here (before or after logging in) and opens the "join server" dialog.

const PATH = /^\/invite\/([A-Za-z0-9_-]{2,32})\/?$/;
const PENDING_KEY = 'concord.pendingInvite';

export function inviteLink(code: string): string {
  return `${location.origin}/invite/${code}`;
}

/** The invite code in a link to this same server, or null. */
export function inviteCodeFromUrl(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    return u.host === location.host ? (PATH.exec(u.pathname)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

export function openInvite(code: string) {
  openModal({ type: 'createGuild', inviteCode: code });
}

/** Called once at startup: remembers an invite in the address bar and cleans the URL. */
export function captureInviteFromLocation() {
  const code = PATH.exec(location.pathname)?.[1];
  if (!code) return;
  try {
    sessionStorage.setItem(PENDING_KEY, code);
  } catch {
    /* ignore */
  }
  history.replaceState(null, '', '/');
}

/** Opens the invite captured at startup, once the user is logged in. */
export function consumePendingInvite() {
  let code: string | null = null;
  try {
    code = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
  if (code) openInvite(code);
}
