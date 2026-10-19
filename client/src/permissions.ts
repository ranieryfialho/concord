// Mirrors server/src/permissions.ts.
export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2,
  ATTACH_FILES: 1 << 3,
  ADD_REACTIONS: 1 << 4,
  CONNECT: 1 << 5,
  SPEAK: 1 << 6,
  STREAM: 1 << 7,
  MANAGE_CHANNELS: 1 << 8,
  MANAGE_ROLES: 1 << 9,
  MANAGE_GUILD: 1 << 10,
  KICK_MEMBERS: 1 << 11,
  CREATE_INVITE: 1 << 12,
  MANAGE_NICKNAMES: 1 << 13,
  CREATE_THREADS: 1 << 14,
  ADMINISTRATOR: 1 << 15,
} as const;

export type PermissionKey = keyof typeof P;

export function has(perms: number | undefined, bit: number): boolean {
  return ((perms ?? 0) & bit) === bit;
}

export interface PermissionInfo {
  key: PermissionKey;
  label: string;
  description: string;
}

export const PERMISSION_GROUPS: { title: string; items: PermissionInfo[] }[] = [
  {
    title: 'Gerais do servidor',
    items: [
      { key: 'VIEW_CHANNEL', label: 'Ver canais', description: 'Permite ver os canais e ler o histórico de mensagens.' },
      { key: 'MANAGE_CHANNELS', label: 'Gerenciar canais', description: 'Criar, editar e excluir canais e threads.' },
      { key: 'MANAGE_ROLES', label: 'Gerenciar cargos', description: 'Criar e editar cargos abaixo do seu e alterar permissões de canais.' },
      { key: 'MANAGE_GUILD', label: 'Gerenciar servidor', description: 'Alterar o nome e o ícone do servidor.' },
      { key: 'CREATE_INVITE', label: 'Criar convite', description: 'Convidar novas pessoas para o servidor.' },
      { key: 'KICK_MEMBERS', label: 'Expulsar membros', description: 'Remover membros com cargo inferior ao seu.' },
      { key: 'MANAGE_NICKNAMES', label: 'Gerenciar apelidos', description: 'Alterar o apelido de outros membros.' },
    ],
  },
  {
    title: 'Texto',
    items: [
      { key: 'SEND_MESSAGES', label: 'Enviar mensagens', description: 'Enviar mensagens em canais de texto e threads.' },
      { key: 'ATTACH_FILES', label: 'Anexar arquivos', description: 'Enviar imagens, vídeos e outros arquivos.' },
      { key: 'ADD_REACTIONS', label: 'Adicionar reações', description: 'Adicionar novas reações às mensagens.' },
      { key: 'CREATE_THREADS', label: 'Criar threads', description: 'Abrir threads a partir de mensagens ou canais.' },
      { key: 'MANAGE_MESSAGES', label: 'Gerenciar mensagens', description: 'Excluir mensagens de outras pessoas e fixar mensagens.' },
    ],
  },
  {
    title: 'Voz',
    items: [
      { key: 'CONNECT', label: 'Conectar', description: 'Entrar nos canais de voz.' },
      { key: 'SPEAK', label: 'Falar', description: 'Falar nos canais de voz. Sem isso a pessoa entra silenciada.' },
      { key: 'STREAM', label: 'Vídeo e transmissão', description: 'Ligar a câmera e compartilhar a tela.' },
    ],
  },
  {
    title: 'Avançado',
    items: [
      {
        key: 'ADMINISTRATOR',
        label: 'Administrador',
        description: 'Concede todas as permissões e ignora as permissões de canais. Use com cuidado.',
      },
    ],
  },
];

/** Permissions that make sense as per-channel overwrites. */
export const CHANNEL_PERMISSION_KEYS: PermissionKey[] = [
  'VIEW_CHANNEL',
  'MANAGE_CHANNELS',
  'CREATE_INVITE',
  'SEND_MESSAGES',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'CREATE_THREADS',
  'MANAGE_MESSAGES',
  'CONNECT',
  'SPEAK',
  'STREAM',
];

export function colorHex(color: number | null): string | undefined {
  return color == null ? undefined : `#${color.toString(16).padStart(6, '0')}`;
}
