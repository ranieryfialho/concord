// Patch notes shown in the "Novidades" window. Newest first. Add an entry per release; its `id`
// decides who sees the window again (everyone who hasn't opened that id yet).

export interface Release {
  id: string;
  date: string;
  title: string;
  items: { tag: 'novo' | 'melhoria' | 'removido'; text: string }[];
}

export const RELEASES: Release[] = [
  {
    id: '2026-11-10',
    date: '10/11/2026',
    title: 'Áudio no Linux, chat da sala e mais leveza',
    items: [
      { tag: 'novo', text: 'App para Linux: agora dá para transmitir a tela com o som do computador (requer atualizar o app desktop). As vozes da chamada não voltam como eco.' },
      { tag: 'novo', text: 'Notificações para mensagens novas no chat dos canais de voz e nas conversas privadas.' },
      { tag: 'melhoria', text: 'O chat de texto da sala de voz agora começa fechado; abra pelo botão de mensagem no topo.' },
      { tag: 'removido', text: 'A transcrição de chamadas foi removida para deixar o servidor mais leve. As transcrições antigas foram apagadas.' },
    ],
  },
];

export const LATEST_RELEASE = RELEASES[0].id;

const KEY = 'concord.seenReleaseNotes';

export function hasUnseenRelease(): boolean {
  try {
    return localStorage.getItem(KEY) !== LATEST_RELEASE;
  } catch {
    return false;
  }
}

export function markReleaseSeen() {
  try {
    localStorage.setItem(KEY, LATEST_RELEASE);
  } catch {
    /* storage blocked */
  }
}
