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
    id: '2026-11-13',
    date: '13/11/2026',
    title: 'Transmissão mais leve',
    items: [
      { tag: 'melhoria', text: 'Em todos os sistemas (Windows, Linux, macOS e navegador): chamadas e transmissões agora passam por um servidor de mídia. Quem transmite envia a tela uma vez só, não uma vez para cada pessoa assistindo. Gasta bem menos processador e internet, mantendo a qualidade em 1080p.' },
      { tag: 'melhoria', text: 'App para Linux: o som do computador agora vai junto também ao transmitir a tela inteira, não só uma janela.' },
      { tag: 'melhoria', text: 'App para Linux (.deb): o áudio da transmissão passa a funcionar em versões mais antigas do Ubuntu, Debian e Mint.' },
      { tag: 'novo', text: 'Quando sair uma versão nova do app desktop, esta janela já mostra o botão para baixar e instalar.' },
    ],
  },
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
