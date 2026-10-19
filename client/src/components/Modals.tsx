import { ArrowDown, ArrowUp, Camera, Check, Copy, Crown, ExternalLink, Minus, MonitorCog, Moon, Plus, Sun, Trash2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type ThemePref, setThemePref, useTheme } from '../theme';
import { useMediaDevices } from './DeviceMenu';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { RecoveryCodeBox } from './AuthScreen';
import { type ScreenSource, native } from '../native';
import { CHANNEL_PERMISSION_KEYS, P, PERMISSION_GROUPS, type PermissionKey, colorHex, has } from '../permissions';
import { logout } from '../session';
import {
  HOME,
  type ModalState,
  addGuild,
  canGuild,
  closeModal,
  copyText,
  highestPosition,
  memberRoles,
  nameOf,
  openDM,
  openModal,
  presenceOf,
  selectChannel,
  selectGuild,
  setState,
  sortedRoles,
  toast,
  upsertChannel,
  useStore,
} from '../store';
import type { ApiChannel, ApiGuild, Me, Role, User } from '../types';
import { PRESENCE_LABEL, colorFor, cx, dayLabel } from '../utils';
import { useVoice, voice } from '../voice';
import { type InputProfile, NOISE_LABELS, type NoiseMode, PROFILE_LABELS } from '../mic';
import { keyLabel } from './PushToTalk';
import { MicMeter, useMicReader, useMicTest } from './MicMeter';
import { inviteLink } from '../invite';
import { Avatar, GuildIcon, Modal, Spinner } from './common';

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

// ---------- Servers ----------

function CreateGuildModal({ initialCode }: { initialCode?: string }) {
  const me = useStore((s) => s.me);
  const [step, setStep] = useState<'choose' | 'create' | 'join'>(initialCode ? 'join' : 'choose');
  const [name, setName] = useState(`Servidor de ${me?.display_name || me?.username}`);
  const [code, setCode] = useState(initialCode ?? '');
  const [preview, setPreview] = useState<{ guild: { id: string; name: string }; member_count: number } | null>(null);
  const { busy, error, run } = useBusy();
  const inviteCode = () => encodeURIComponent(code.trim().replace(/\/+$/, '').split('/').pop() ?? '');
  const alreadyIn = useStore((s) => !!preview && !!s.guilds[preview.guild.id]);

  // Opened from an invite link: look the invite up right away.
  useEffect(() => {
    if (initialCode) void run(async () => setPreview(await api(`/invites/${encodeURIComponent(initialCode)}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const g = await api<ApiGuild>('/guilds', { body: { name } });
      addGuild(g);
      closeModal();
      selectGuild(g.id);
    });
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!preview) {
        setPreview(await api(`/invites/${inviteCode()}`));
        return;
      }
      if (alreadyIn) {
        closeModal();
        selectGuild(preview.guild.id);
        return;
      }
      const g = await api<ApiGuild>(`/invites/${inviteCode()}`, { method: 'POST' });
      addGuild(g);
      closeModal();
      selectGuild(g.id);
    });
  };

  if (step === 'choose') {
    return (
      <Modal title="Adicione um servidor" subtitle="Crie seu próprio espaço ou entre em um com um convite." onClose={closeModal}>
        <button className="choice-card" onClick={() => setStep('create')}>
          <span className="choice-emoji">🏠</span>
          <span>Criar meu próprio servidor</span>
        </button>
        <button className="choice-card" onClick={() => setStep('join')}>
          <span className="choice-emoji">✉️</span>
          <span>Entrar com um convite</span>
        </button>
      </Modal>
    );
  }

  if (step === 'create') {
    return (
      <Modal title="Personalize seu servidor" subtitle="Dê uma personalidade ao seu servidor com um nome. Dá para mudar depois." onClose={closeModal}>
        <form onSubmit={create}>
          <label className="field">
            <span>Nome do servidor</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="link" onClick={() => setStep('choose')}>
              Voltar
            </button>
            <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>
              Criar
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Entrar em um servidor" subtitle="Insira um convite abaixo para entrar em um servidor existente." onClose={closeModal}>
      <form onSubmit={join}>
        <label className="field">
          <span>Código ou link do convite</span>
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setPreview(null);
            }}
            placeholder={`ex.: ${location.origin}/invite/hTKzmak`}
            autoFocus
          />
        </label>
        {preview && (
          <div className="invite-preview">
            {alreadyIn ? 'Você já está em' : 'Você foi convidado para'} <strong>{preview.guild.name}</strong> · {preview.member_count} membro
            {preview.member_count === 1 ? '' : 's'}
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={() => setStep('choose')}>
            Voltar
          </button>
          <button className="btn btn-primary" disabled={busy || !code.trim()}>
            {!preview ? 'Verificar convite' : alreadyIn ? 'Abrir servidor' : 'Aceitar convite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InviteModal({ guildId }: { guildId: string }) {
  const guildName = useStore((s) => s.guilds[guildId]?.name);
  const [never, setNever] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    setCode(null);
    api<{ code: string }>(`/guilds/${guildId}/invites`, { body: never ? {} : { max_age: 7 * 86400 } })
      .then((r) => setCode(r.code))
      .catch((e: Error) => toast(e.message));
  }, [guildId, never]);

  const link = code ? inviteLink(code) : null;
  return (
    <Modal title={`Convide amigos para ${guildName}`} onClose={closeModal}>
      <label className="field">
        <span>Envie este link de convite</span>
        <div className="copy-row">
          <input readOnly value={link ?? 'Gerando…'} onFocus={(e) => e.target.select()} />
          <button className="btn btn-primary" disabled={!link} onClick={() => link && copyText(link, 'Link copiado!')}>
            <Copy size={16} /> Copiar
          </button>
        </div>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
        <span>Convite nunca expira (padrão: 7 dias)</span>
      </label>
      <p className="muted small">
        Quem abrir o link entra (ou cria a conta) e cai direto no convite. No app, também dá para colar o link ou só o código <strong>{code}</strong> em
        “Adicionar um servidor → Entrar com um convite”.
      </p>
    </Modal>
  );
}

function CreateChannelModal({ guildId, parentId, channelType }: { guildId: string; parentId: string | null; channelType: 'text' | 'voice' | 'category' }) {
  const [type, setType] = useState(channelType);
  const [name, setName] = useState('');
  const parentName = useStore((s) => (parentId ? s.channels[parentId]?.name : null));
  const { busy, error, run } = useBusy();
  const isCategory = type === 'category';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const c = await api<{ id: string }>(`/guilds/${guildId}/channels`, { body: { name, type, parent_id: parentId } });
      closeModal();
      if (type === 'text') setTimeout(() => selectChannel(guildId, c.id), 100);
    });
  };

  return (
    <Modal title={isCategory ? 'Criar categoria' : 'Criar canal'} subtitle={parentName ? `em ${parentName}` : undefined} onClose={closeModal}>
      <form onSubmit={submit}>
        {!isCategory && (
          <div className="field">
            <span>Tipo de canal</span>
            {(['text', 'voice'] as const).map((t) => (
              <label key={t} className={cx('radio-card', type === t && 'active')}>
                <input type="radio" checked={type === t} onChange={() => setType(t)} />
                <span>
                  <strong>{t === 'text' ? '# Texto' : '🔊 Voz'}</strong>
                  <span className="muted small">
                    {t === 'text' ? 'Envie mensagens, imagens, GIFs, emojis e opiniões.' : 'Converse por voz, vídeo e compartilhe a tela.'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="field">
          <span>{isCategory ? 'Nome da categoria' : 'Nome do canal'}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={isCategory ? 'Nova categoria' : 'novo-canal'} autoFocus maxLength={100} />
        </label>
        <p className="muted small">Depois de criar, ajuste quem pode ver e usar o canal em “Editar canal → Permissões”.</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            Criar
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Channel settings & permission overwrites ----------

interface Overwrite {
  channel_id: string;
  role_id: string;
  allow: number;
  deny: number;
}

function TriState({ value, onChange }: { value: 'allow' | 'deny' | 'inherit'; onChange: (v: 'allow' | 'deny' | 'inherit') => void }) {
  return (
    <div className="tristate">
      <button type="button" className={cx('deny', value === 'deny' && 'on')} title="Negar" onClick={() => onChange('deny')}>
        <X size={14} />
      </button>
      <button type="button" className={cx('inherit', value === 'inherit' && 'on')} title="Herdar" onClick={() => onChange('inherit')}>
        <Minus size={14} />
      </button>
      <button type="button" className={cx('allow', value === 'allow' && 'on')} title="Permitir" onClick={() => onChange('allow')}>
        <Check size={14} />
      </button>
    </div>
  );
}

function ChannelPermissions({ channelId, guildId }: { channelId: string; guildId: string }) {
  const roles = useStore(useShallow((s) => sortedRoles(s, guildId)));
  const channelType = useStore((s) => s.channels[channelId]?.type);
  const [data, setData] = useState<{ synced: boolean; overwrites: Overwrite[] } | null>(null);
  const [selected, setSelected] = useState(guildId);

  const load = () =>
    api<{ synced: boolean; overwrites: Overwrite[] }>(`/channels/${channelId}/permissions`)
      .then(setData)
      .catch((e: Error) => toast(e.message));
  useEffect(() => {
    void load();
  }, [channelId]);

  if (!data) return <Spinner />;
  const ow = data.overwrites.find((o) => o.role_id === selected) ?? { allow: 0, deny: 0 };
  const listed = roles.filter((r) => r.id === guildId || data.overwrites.some((o) => o.role_id === r.id) || r.id === selected);
  const addable = roles.filter((r) => !listed.includes(r));
  const keys = CHANNEL_PERMISSION_KEYS.filter((k) =>
    channelType === 'voice'
      ? !['SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'CREATE_THREADS', 'MANAGE_MESSAGES'].includes(k)
      : channelType === 'text'
        ? !['CONNECT', 'SPEAK', 'STREAM'].includes(k)
        : true,
  );

  async function set(key: PermissionKey, value: 'allow' | 'deny' | 'inherit') {
    const bit = P[key];
    let allow = ow.allow & ~bit;
    let deny = ow.deny & ~bit;
    if (value === 'allow') allow |= bit;
    if (value === 'deny') deny |= bit;
    try {
      if (!allow && !deny) await api(`/channels/${channelId}/permissions/${selected}`, { method: 'DELETE' });
      else await api(`/channels/${channelId}/permissions/${selected}`, { method: 'PUT', body: { allow, deny } });
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="perm-editor">
      {data.synced && <p className="info-box small">Este canal está sincronizado com a categoria. Alterar algo aqui cria permissões próprias para ele.</p>}
      <div className="perm-layout">
        <div className="perm-roles">
          {listed.map((r) => (
            <button key={r.id} className={cx('perm-role', selected === r.id && 'active')} onClick={() => setSelected(r.id)}>
              <span className="role-dot" style={{ background: colorHex(r.color) ?? '#99aab5' }} />
              <span className="truncate">{r.name}</span>
            </button>
          ))}
          {addable.length > 0 && (
            <select className="perm-add" value="" onChange={(e) => e.target.value && setSelected(e.target.value)}>
              <option value="">+ Adicionar cargo</option>
              {addable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="perm-list">
          {keys.map((key) => {
            const bit = P[key];
            const value = ow.allow & bit ? 'allow' : ow.deny & bit ? 'deny' : 'inherit';
            const info = PERMISSION_GROUPS.flatMap((g) => g.items).find((i) => i.key === key)!;
            return (
              <div key={key} className="perm-row">
                <div>
                  <strong>{info.label}</strong>
                  <p className="small muted">{info.description}</p>
                </div>
                <TriState value={value} onChange={(v) => void set(key, v)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ChannelSettingsModal({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const canPerms = useStore((s) => canGuild(s, channel?.guild_id, P.MANAGE_ROLES));
  const [tab, setTab] = useState<'overview' | 'perms'>('overview');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const { busy, error, run } = useBusy();
  if (!channel || !channel.guild_id) return null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/channels/${channelId}`, { method: 'PATCH', body: channel.type === 'text' ? { name, topic } : { name } });
      toast('Canal atualizado');
    });
  };

  const remove = () =>
    openModal({
      type: 'confirm',
      title: `Excluir ${channel.type === 'category' ? 'categoria' : channel.type === 'thread' ? 'thread' : 'canal'}`,
      body: `Tem certeza de que deseja excluir ${channel.type === 'text' ? '#' : ''}${channel.name}? Isso não pode ser desfeito.`,
      confirmLabel: 'Excluir',
      onConfirm: async () => {
        await api(`/channels/${channelId}`, { method: 'DELETE' });
        closeModal();
      },
    });

  const showPerms = canPerms && channel.type !== 'thread';

  return (
    <Modal wide title={channel.type === 'category' ? 'Editar categoria' : 'Editar canal'} onClose={closeModal}>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={cx(tab === 'overview' && 'active')} onClick={() => setTab('overview')}>
            Visão geral
          </button>
          {showPerms && (
            <button className={cx(tab === 'perms' && 'active')} onClick={() => setTab('perms')}>
              Permissões
            </button>
          )}
          <button className="danger" onClick={remove}>
            Excluir
          </button>
        </nav>
        <div className="settings-content">
          {tab === 'overview' ? (
            <form onSubmit={save}>
              <label className="field">
                <span>Nome</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
              </label>
              {channel.type === 'text' && (
                <label className="field">
                  <span>Tópico do canal</span>
                  <textarea value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} rows={3} placeholder="Diga a todos como usar este canal!" />
                </label>
              )}
              {error && <p className="form-error">{error}</p>}
              <div className="modal-actions">
                <span />
                <button className="btn btn-primary" disabled={busy || !name.trim()}>
                  Salvar alterações
                </button>
              </div>
            </form>
          ) : (
            <ChannelPermissions channelId={channelId} guildId={channel.guild_id} />
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------- Guild settings: overview, roles, members ----------

function RolesEditor({ guildId }: { guildId: string }) {
  const roles = useStore(useShallow((s) => sortedRoles(s, guildId)));
  const myTop = useStore((s) => (s.me ? highestPosition(s, guildId, s.me.id) : 0));
  const myPerms = useStore((s) => s.guilds[guildId]?.permissions ?? 0);
  const [selected, setSelected] = useState(roles[0]?.id ?? guildId);
  const role = roles.find((r) => r.id === selected) ?? roles[roles.length - 1];
  const [draft, setDraft] = useState<Role | null>(role ?? null);
  const { busy, error, run } = useBusy();

  useEffect(() => {
    setDraft(role ?? null);
  }, [role?.id, role?.position, role?.permissions, role?.name, role?.color, role?.hoist]);

  if (!draft || !role) return <Spinner />;
  const isEveryone = role.id === guildId;
  const editable = isEveryone || role.position < myTop;
  const dirty = JSON.stringify(draft) !== JSON.stringify(role);

  const create = () =>
    void run(async () => {
      const r = await api<{ id: string }>(`/guilds/${guildId}/roles`, { body: { name: 'novo cargo' } });
      setSelected(r.id);
    });
  const move = (direction: 'up' | 'down') => void run(() => api(`/guilds/${guildId}/roles/${role.id}/move`, { body: { direction } }));
  const save = () =>
    void run(async () => {
      await api(`/guilds/${guildId}/roles/${role.id}`, {
        method: 'PATCH',
        body: { name: draft.name, color: draft.color, hoist: draft.hoist, permissions: draft.permissions },
      });
      toast('Cargo salvo');
    });
  const remove = () =>
    openModal({
      type: 'confirm',
      title: `Excluir o cargo '${role.name}'`,
      body: 'Quem tem esse cargo perde as permissões dele.',
      confirmLabel: 'Excluir cargo',
      onConfirm: async () => {
        await api(`/guilds/${guildId}/roles/${role.id}`, { method: 'DELETE' });
        openModal({ type: 'guildSettings', guildId });
      },
    });

  const togglePerm = (bit: number) => setDraft({ ...draft, permissions: draft.permissions ^ bit });

  return (
    <div className="roles-editor">
      <div className="roles-list">
        <button className="btn btn-primary small" onClick={create} disabled={busy}>
          <Plus size={14} /> Criar cargo
        </button>
        {roles.map((r) => (
          <button key={r.id} className={cx('perm-role', selected === r.id && 'active')} onClick={() => setSelected(r.id)}>
            <span className="role-dot" style={{ background: colorHex(r.color) ?? '#99aab5' }} />
            <span className="truncate">{r.name}</span>
          </button>
        ))}
      </div>
      <div className="role-detail">
        {!editable && <p className="info-box small">Você só pode editar cargos abaixo do seu cargo mais alto.</p>}
        <fieldset disabled={!editable || busy}>
          <div className="row gap-8 role-detail-head">
            <label className="field grow">
              <span>Nome do cargo</span>
              <input value={draft.name} disabled={isEveryone} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} />
            </label>
            {!isEveryone && (
              <>
                <label className="field">
                  <span>Cor</span>
                  <div className="row gap-8">
                    <input
                      type="color"
                      className="color-input"
                      value={colorHex(draft.color) ?? '#99aab5'}
                      onChange={(e) => setDraft({ ...draft, color: parseInt(e.target.value.slice(1), 16) })}
                    />
                    {draft.color != null && (
                      <button type="button" className="link small" onClick={() => setDraft({ ...draft, color: null })}>
                        sem cor
                      </button>
                    )}
                  </div>
                </label>
                <div className="field">
                  <span>Ordem</span>
                  <div className="row gap-8">
                    <button type="button" className="icon-btn" title="Subir" onClick={() => move('up')}>
                      <ArrowUp size={16} />
                    </button>
                    <button type="button" className="icon-btn" title="Descer" onClick={() => move('down')}>
                      <ArrowDown size={16} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {!isEveryone && (
            <label className="check-row">
              <input type="checkbox" checked={draft.hoist} onChange={(e) => setDraft({ ...draft, hoist: e.target.checked })} />
              <span>
                <strong>Exibir separadamente na lista de membros</strong>
              </span>
            </label>
          )}
          {isEveryone && <p className="muted small">@everyone define as permissões padrão de todos os membros do servidor.</p>}
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.title} className="perm-group">
              <h4 className="member-section">{group.title}</h4>
              {group.items.map((item) => {
                const bit = P[item.key];
                const grantable = myPerms === (P.ADMINISTRATOR << 1) - 1 || has(myPerms, bit);
                return (
                  <label key={item.key} className="perm-row">
                    <div>
                      <strong>{item.label}</strong>
                      <p className="small muted">{item.description}</p>
                    </div>
                    <input type="checkbox" className="switch" checked={has(draft.permissions, bit)} disabled={!grantable} onChange={() => togglePerm(bit)} />
                  </label>
                );
              })}
            </div>
          ))}
        </fieldset>
        {error && <p className="form-error">{error}</p>}
        {editable && (
          <div className="modal-actions sticky-actions">
            {!isEveryone ? (
              <button className="btn btn-danger-outline" onClick={remove}>
                <Trash2 size={16} /> Excluir cargo
              </button>
            ) : (
              <span />
            )}
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
              Salvar alterações
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MemberAdminRow({ guildId, userId }: { guildId: string; userId: string }) {
  const name = useStore((s) => nameOf(s, userId, guildId));
  const username = useStore((s) => s.users[userId]?.username);
  const roles = useStore(useShallow((s) => memberRoles(s, guildId, userId)));
  const allRoles = useStore(useShallow((s) => sortedRoles(s, guildId).filter((r) => r.id !== guildId)));
  const meId = useStore((s) => s.me?.id);
  const ownerId = useStore((s) => s.guilds[guildId]?.owner_id);
  const myTop = useStore((s) => (s.me ? highestPosition(s, guildId, s.me.id) : 0));
  const theirTop = useStore((s) => highestPosition(s, guildId, userId));
  const canRoles = useStore((s) => canGuild(s, guildId, P.MANAGE_ROLES));
  const canKickPerm = useStore((s) => canGuild(s, guildId, P.KICK_MEMBERS));
  const [adding, setAdding] = useState(false);

  const isOwner = userId === ownerId;
  const canKick = canKickPerm && userId !== meId && !isOwner && theirTop < myTop;
  const assignable = allRoles.filter((r) => r.position < myTop && !roles.some((x) => x.id === r.id));

  const setRole = (roleId: string, add: boolean) =>
    api(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: add ? 'PUT' : 'DELETE' }).catch((e: Error) => toast(e.message));

  return (
    <div className="member-admin-row">
      <Avatar userId={userId} size={32} guildId={guildId} />
      <div className="member-text">
        <strong className="truncate">
          {name} {isOwner && <Crown size={13} className="role-icon owner" />}
        </strong>
        <span className="small muted">{username}</span>
        <div className="role-chips">
          {roles.map((r) => (
            <span key={r.id} className="role-chip" style={{ borderColor: colorHex(r.color) }}>
              <span className="role-dot" style={{ background: colorHex(r.color) ?? '#99aab5' }} />
              {r.name}
              {canRoles && r.position < myTop && (
                <button className="role-chip-x" title="Remover cargo" onClick={() => void setRole(r.id, false)}>
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
          {canRoles && assignable.length > 0 && (
            <span className="role-add">
              {adding ? (
                <select
                  autoFocus
                  value=""
                  onBlur={() => setAdding(false)}
                  onChange={(e) => {
                    setAdding(false);
                    if (e.target.value) void setRole(e.target.value, true);
                  }}
                >
                  <option value="">Escolher cargo…</option>
                  {assignable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="role-chip add" onClick={() => setAdding(true)}>
                  <Plus size={11} /> cargo
                </button>
              )}
            </span>
          )}
        </div>
      </div>
      {meId === ownerId && userId !== meId && (
        <button
          className="btn btn-secondary small"
          onClick={() =>
            openModal({
              type: 'confirm',
              title: `Transferir posse para ${name}`,
              body: `${name} passará a ser dono do servidor, e você perde os poderes de dono. Isso não pode ser desfeito por você.`,
              confirmLabel: 'Transferir',
              onConfirm: async () => {
                await api(`/guilds/${guildId}/transfer`, { body: { user_id: userId } });
                closeModal();
              },
            })
          }
        >
          Tornar dono
        </button>
      )}
      {canKick && (
        <button
          className="btn btn-danger-outline small"
          onClick={() =>
            openModal({
              type: 'confirm',
              title: `Expulsar ${name}`,
              body: `${name} poderá voltar com um novo convite.`,
              confirmLabel: 'Expulsar',
              onConfirm: async () => {
                await api(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
                openModal({ type: 'guildSettings', guildId });
              },
            })
          }
        >
          Expulsar
        </button>
      )}
    </div>
  );
}

function GuildSettingsModal({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const isOwner = useStore((s) => s.guilds[guildId]?.owner_id === s.me?.id);
  const canGuildEdit = useStore((s) => canGuild(s, guildId, P.MANAGE_GUILD));
  const canRoles = useStore((s) => canGuild(s, guildId, P.MANAGE_ROLES));
  const memberIds = useStore(useShallow((s) => Object.keys(s.members[guildId] ?? {})));
  const [tab, setTab] = useState<'overview' | 'roles' | 'members'>(canGuildEdit ? 'overview' : canRoles ? 'roles' : 'members');
  const [name, setName] = useState(guild?.name ?? '');
  const [filter, setFilter] = useState('');
  const { busy, error, run } = useBusy();
  const filtered = useStore(
    useShallow((s) => memberIds.filter((id) => !filter || nameOf(s, id, guildId).toLowerCase().includes(filter.toLowerCase()))),
  );
  if (!guild) return null;

  const uploadIcon = (file: File) =>
    void run(async () => {
      const form = new FormData();
      form.append('file', file);
      await api(`/guilds/${guildId}/icon`, { form });
    });

  const deleteGuild = () =>
    openModal({
      type: 'confirm',
      title: `Excluir '${guild.name}'`,
      body: 'Tem certeza? Todos os canais e mensagens serão apagados para sempre.',
      confirmLabel: 'Excluir servidor',
      onConfirm: async () => {
        await api(`/guilds/${guildId}`, { method: 'DELETE' });
        closeModal();
      },
    });

  return (
    <Modal wide title="Configurações do servidor" onClose={closeModal}>
      <div className="settings-layout">
        <nav className="settings-nav">
          {canGuildEdit && (
            <button className={cx(tab === 'overview' && 'active')} onClick={() => setTab('overview')}>
              Visão geral
            </button>
          )}
          {canRoles && (
            <button className={cx(tab === 'roles' && 'active')} onClick={() => setTab('roles')}>
              Cargos
            </button>
          )}
          <button className={cx(tab === 'members' && 'active')} onClick={() => setTab('members')}>
            Membros
          </button>
          {isOwner && (
            <button className="danger" onClick={deleteGuild}>
              Excluir servidor
            </button>
          )}
        </nav>
        <div className="settings-content">
          {tab === 'overview' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api(`/guilds/${guildId}`, { method: 'PATCH', body: { name } }).then(() => toast('Servidor atualizado')));
              }}
            >
              <div className="icon-upload">
                <label className="icon-upload-preview" title="Alterar ícone">
                  <GuildIcon guildId={guildId} size={96} />
                  <span className="icon-upload-overlay">
                    <Camera size={20} />
                  </span>
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => e.target.files?.[0] && uploadIcon(e.target.files[0])} />
                </label>
                <p className="muted small">Recomendamos uma imagem de pelo menos 512×512.</p>
              </div>
              <label className="field">
                <span>Nome do servidor</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </label>
              {error && <p className="form-error">{error}</p>}
              <div className="modal-actions">
                <span />
                <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>
                  Salvar alterações
                </button>
              </div>
            </form>
          )}
          {tab === 'roles' && <RolesEditor guildId={guildId} />}
          {tab === 'members' && (
            <div className="member-admin">
              <input className="filter-input" placeholder="Buscar membros" value={filter} onChange={(e) => setFilter(e.target.value)} />
              {filtered.map((id) => (
                <MemberAdminRow key={id} guildId={guildId} userId={id} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------- Groups & threads ----------

function CreateGroupModal({ channelId }: { channelId: string | null }) {
  const existing = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  const friends = useStore(
    useShallow((s) =>
      Object.entries(s.relationships)
        .filter(([, t]) => t === 'friend')
        .map(([id]) => id)
        .sort((a, b) => nameOf(s, a).localeCompare(nameOf(s, b), 'pt-BR')),
    ),
  );
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useBusy();
  const names = useStore(useShallow((s) => friends.map((id) => nameOf(s, id))));

  const alreadyIn = new Set(existing?.recipient_ids ?? []);
  const options = friends.filter((id, i) => !alreadyIn.has(id) || existing?.type === 'dm').filter((_, i) => names[i]?.toLowerCase().includes(filter.toLowerCase()));
  const baseCount = existing?.type === 'group_dm' ? (existing.recipient_ids?.length ?? 1) : existing?.type === 'dm' ? 2 : 1;
  const remaining = 10 - baseCount - picked.length;

  const submit = () =>
    void run(async () => {
      if (existing?.type === 'group_dm') {
        for (const id of picked) await api(`/channels/${existing.id}/recipients/${id}`, { method: 'PUT' });
        closeModal();
        return;
      }
      const others = existing?.type === 'dm' ? [...new Set([...(existing.recipient_ids ?? []).filter((id) => id !== useStore.getState().me?.id), ...picked])] : picked;
      const channel = await api<ApiChannel>('/users/@me/channels', { body: others.length > 1 ? { recipient_ids: others } : { recipient_id: others[0] } });
      upsertChannel(channel);
      closeModal();
      selectChannel(HOME, channel.id);
    });

  return (
    <Modal
      title={existing?.type === 'group_dm' ? 'Adicionar amigos ao grupo' : 'Selecionar amigos'}
      subtitle={remaining >= 0 ? `Você pode adicionar mais ${remaining} amigo${remaining === 1 ? '' : 's'}.` : 'Grupos têm no máximo 10 pessoas.'}
      onClose={closeModal}
      footer={
        <button className="btn btn-primary btn-block" disabled={busy || !picked.length || remaining < 0} onClick={submit}>
          {existing?.type === 'group_dm' ? 'Adicionar' : 'Criar grupo'}
        </button>
      }
    >
      <input className="filter-input" placeholder="Digite o nome de usuário de um amigo" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      <div className="friend-picker scroll">
        {options.map((id) => (
          <label key={id} className="friend-pick">
            <Avatar userId={id} size={32} status />
            <PickName userId={id} />
            <input
              type="checkbox"
              checked={picked.includes(id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, id] : picked.filter((x) => x !== id))}
            />
          </label>
        ))}
        {!options.length && <p className="muted small pad">Nenhum amigo para adicionar. Grupos só podem ter amigos.</p>}
      </div>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function PickName({ userId }: { userId: string }) {
  const name = useStore((s) => nameOf(s, userId));
  const username = useStore((s) => s.users[userId]?.username);
  return (
    <span className="friend-pick-name">
      <strong className="truncate">{name}</strong>
      <span className="small muted truncate">{username}</span>
    </span>
  );
}

function CreateThreadModal({ channelId, messageId, initialName }: { channelId: string; messageId: string | null; initialName: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const [name, setName] = useState(initialName);
  const { busy, error, run } = useBusy();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const t = await api<{ id: string }>(`/channels/${channelId}/threads`, { body: { name, message_id: messageId } });
      closeModal();
      setTimeout(() => selectChannel(channel!.guild_id!, t.id), 100);
    });
  };

  return (
    <Modal title="Criar thread" subtitle={channel ? `em #${channel.name}` : undefined} onClose={closeModal}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Nome da thread</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder="Sobre o que é a conversa?" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            Criar thread
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Users ----------

function ProfileModal({ userId, guildId }: { userId: string; guildId: string | null }) {
  const user = useStore((s) => s.users[userId]);
  const name = useStore((s) => nameOf(s, userId, guildId));
  const presence = useStore((s) => presenceOf(s, userId));
  const relationship = useStore((s) => s.relationships[userId]);
  const isMe = useStore((s) => s.me?.id === userId);
  const isOwner = useStore((s) => !!guildId && s.guilds[guildId]?.owner_id === userId);
  const roles = useStore(useShallow((s) => (guildId ? memberRoles(s, guildId, userId) : [])));
  const canKick = useStore(
    (s) => !!guildId && !isMe && !isOwner && canGuild(s, guildId, P.KICK_MEMBERS) && !!s.me && highestPosition(s, guildId, userId) < highestPosition(s, guildId, s.me.id),
  );
  const isMember = useStore((s) => !!guildId && !!s.members[guildId]?.[userId]);
  const [profile, setProfile] = useState<(User & { created_at: number; mutual_guild_ids: string[] }) | null>(null);
  const mutualNames = useStore(useShallow((s) => (profile?.mutual_guild_ids ?? []).map((id) => s.guilds[id]?.name).filter(Boolean)));

  useEffect(() => {
    api<User & { created_at: number; mutual_guild_ids: string[] }>(`/users/${userId}`)
      .then(setProfile)
      .catch(() => {});
  }, [userId]);

  const friendAction = async () => {
    try {
      if (relationship === 'pending_in') await api(`/users/@me/relationships/${userId}`, { method: 'PUT' });
      else await api('/users/@me/relationships', { body: { username: user?.username } });
      toast(relationship === 'pending_in' ? 'Pedido aceito!' : 'Pedido de amizade enviado');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <Modal onClose={closeModal}>
      <div className="profile">
        <div className="profile-banner" style={{ background: colorFor(userId) }} />
        <div className="profile-avatar">
          <Avatar userId={userId} size={88} status guildId={guildId} />
        </div>
        <div className="profile-card">
          <h2>
            {name} {isOwner && <Crown size={16} className="role-icon owner" />}
          </h2>
          <p className="muted">{user?.username}</p>
          {user?.custom_status && <p className="profile-custom">{user.custom_status}</p>}
          <div className="profile-section">
            <h4>Status</h4>
            <p>{PRESENCE_LABEL[presence]}</p>
          </div>
          {profile && (
            <div className="profile-section">
              <h4>Membro do Concord desde</h4>
              <p>{dayLabel(profile.created_at)}</p>
            </div>
          )}
          {isMember && (
            <div className="profile-section">
              <h4>Cargos</h4>
              <div className="role-chips">
                {roles.length ? (
                  roles.map((r) => (
                    <span key={r.id} className="role-chip" style={{ borderColor: colorHex(r.color) }}>
                      <span className="role-dot" style={{ background: colorHex(r.color) ?? '#99aab5' }} />
                      {r.name}
                    </span>
                  ))
                ) : (
                  <span className="muted small">Nenhum cargo</span>
                )}
              </div>
            </div>
          )}
          {!isMe && mutualNames.length > 0 && (
            <div className="profile-section">
              <h4>Servidores em comum</h4>
              <p>{mutualNames.join(', ')}</p>
            </div>
          )}
          {!isMe && (
            <div className="profile-actions">
              <button className="btn btn-primary" onClick={() => void openDM(userId)}>
                Enviar mensagem
              </button>
              {relationship !== 'friend' && relationship !== 'pending_out' && (
                <button className="btn btn-secondary" onClick={() => void friendAction()}>
                  {relationship === 'pending_in' ? 'Aceitar amizade' : 'Adicionar amigo'}
                </button>
              )}
              {relationship === 'pending_out' && (
                <button className="btn btn-secondary" disabled>
                  Pedido enviado
                </button>
              )}
              {canKick && (
                <button
                  className="btn btn-danger-outline"
                  onClick={() =>
                    openModal({
                      type: 'confirm',
                      title: `Expulsar ${name}`,
                      body: `${name} poderá voltar com um novo convite.`,
                      confirmLabel: 'Expulsar',
                      onConfirm: async () => {
                        await api(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
                        closeModal();
                      },
                    })
                  }
                >
                  Expulsar
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function UserSettingsModal({ initialTab }: { initialTab?: 'account' | 'appearance' | 'voice' | 'app' }) {
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<'account' | 'appearance' | 'voice' | 'app'>(initialTab ?? 'account');
  return (
    <Modal wide title="Configurações de usuário" onClose={closeModal}>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={cx(tab === 'account' && 'active')} onClick={() => setTab('account')}>
            Minha conta
          </button>
          <button className={cx(tab === 'appearance' && 'active')} onClick={() => setTab('appearance')}>
            Aparência
          </button>
          <button className={cx(tab === 'voice' && 'active')} onClick={() => setTab('voice')}>
            Voz e vídeo
          </button>
          <button className={cx(tab === 'app' && 'active')} onClick={() => setTab('app')}>
            Aplicativo
          </button>
          <button
            className="danger"
            onClick={() => {
              closeModal();
              logout();
            }}
          >
            Sair
          </button>
        </nav>
        <div className="settings-content">
          {tab === 'account' && <AccountSettings me={me} />}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'voice' && <VoiceSettings />}
          {tab === 'app' && <AppSettings />}
        </div>
      </div>
    </Modal>
  );
}

function AccountSettings({ me }: { me: Me }) {
  const [displayName, setDisplayName] = useState(me.display_name ?? '');
  const [customStatus, setCustomStatus] = useState(me.custom_status ?? '');
  const { busy, error, run } = useBusy();

  const avatar = (file: File | null) =>
    void run(async () => {
      let next: Me;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        next = await api<Me>('/users/@me/avatar', { form });
      } else {
        next = await api<Me>('/users/@me/avatar', { method: 'DELETE' });
      }
      setState({ me: next });
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const next = await api<Me>('/users/@me', { method: 'PATCH', body: { display_name: displayName, custom_status: customStatus } });
      setState({ me: next });
      toast('Perfil atualizado');
    });
  };

  return (
    <form onSubmit={save}>
      <div className="icon-upload">
        <label className="icon-upload-preview round" title="Alterar avatar">
          <Avatar userId={me.id} size={96} />
          <span className="icon-upload-overlay">
            <Camera size={20} />
          </span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => e.target.files?.[0] && avatar(e.target.files[0])} />
        </label>
        <div>
          <strong>{me.username}</strong>
          {me.avatar_url && (
            <p>
              <button type="button" className="link small" onClick={() => avatar(null)}>
                Remover avatar
              </button>
            </p>
          )}
        </div>
      </div>
      <label className="field">
        <span>Nome de exibição</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} placeholder={me.username} />
      </label>
      <label className="field">
        <span>Status personalizado</span>
        <input value={customStatus} onChange={(e) => setCustomStatus(e.target.value)} maxLength={128} placeholder="O que você está fazendo?" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <span />
        <button className="btn btn-primary" disabled={busy}>
          Salvar alterações
        </button>
      </div>
      <SecuritySettings me={me} />
    </form>
  );
}

function SecuritySettings({ me }: { me: Me }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const change = useBusy();
  const regen = useBusy();

  const changePassword = () =>
    void change.run(async () => {
      await api('/users/@me/password', { body: { current_password: current, new_password: next } });
      setCurrent('');
      setNext('');
      toast('Senha alterada. As outras sessões foram encerradas.');
    });

  const newCode = () =>
    void regen.run(async () => {
      const res = await api<{ recovery_code: string }>('/users/@me/recovery-code', { body: { password: recoveryPassword } });
      setRecoveryPassword('');
      setCode(res.recovery_code);
      setState({ me: { ...me, has_recovery_code: true } });
    });

  // Rendered inside the profile <form>, so every button here is type="button".
  return (
    <div className="security-settings">
      <h3 className="settings-title">Senha</h3>
      <label className="field">
        <span>Senha atual</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>Nova senha</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={6} />
      </label>
      {change.error && <p className="form-error">{change.error}</p>}
      <div className="modal-actions">
        <span />
        <button type="button" className="btn btn-primary" disabled={change.busy || !current || next.length < 6} onClick={changePassword}>
          Alterar senha
        </button>
      </div>

      <h3 className="settings-title">Código de recuperação</h3>
      <p className="muted small">
        {me.has_recovery_code
          ? 'Use o código para redefinir a senha pela tela de login, caso esqueça. Gerar um novo invalida o anterior.'
          : 'Você ainda não tem um código de recuperação. Gere um e guarde em lugar seguro.'}
      </p>
      {code ? (
        <>
          <RecoveryCodeBox code={code} />
          <p className="muted small">Anote agora: este código não será mostrado de novo.</p>
        </>
      ) : (
        <>
          <label className="field">
            <span>Confirme sua senha</span>
            <input type="password" value={recoveryPassword} onChange={(e) => setRecoveryPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {regen.error && <p className="form-error">{regen.error}</p>}
          <div className="modal-actions">
            <span />
            <button type="button" className="btn btn-secondary" disabled={regen.busy || !recoveryPassword} onClick={newCode}>
              {me.has_recovery_code ? 'Gerar novo código' : 'Gerar código'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 640, height: 360 } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => setError('Não foi possível acessar essa câmera.'));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on, deviceId]);

  return (
    <div className="camera-preview">
      {on ? <video ref={ref} autoPlay playsInline muted className="mirror" /> : <div className="camera-preview-off">Prévia desligada</div>}
      {error && <p className="form-error">{error}</p>}
      <button type="button" className="btn btn-secondary small" onClick={() => setOn(!on)}>
        {on ? 'Desligar prévia' : 'Testar câmera'}
      </button>
    </div>
  );
}

function Toggle({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="perm-row">
      <div>
        <strong>{label}</strong>
        {description && <p className="small muted">{description}</p>}
      </div>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function PttKeyButton() {
  const pttKey = useVoice((s) => s.pttKey);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') voice.setPushToTalk({ pttKey: e.code });
      setListening(false);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button < 3) return; // left/middle/right stay usable
      e.preventDefault();
      voice.setPushToTalk({ pttKey: `Mouse${e.button}` });
      setListening(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [listening]);
  return (
    <button className={cx('btn btn-secondary keybind', listening && 'listening')} onClick={() => setListening(!listening)}>
      {listening ? 'Pressione uma tecla… (Esc cancela)' : pttKey ? keyLabel(pttKey) : 'Definir tecla'}
    </button>
  );
}

function VoiceSettings() {
  const ui = useVoice(
    useShallow((s) => ({
      inputDeviceId: s.inputDeviceId,
      outputDeviceId: s.outputDeviceId,
      videoDeviceId: s.videoDeviceId,
      mode: s.mode,
      inputProfile: s.inputProfile,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      sensitivityAuto: s.sensitivityAuto,
      inputThreshold: s.inputThreshold,
      inputVolume: s.inputVolume,
      outputVolume: s.outputVolume,
      pttEnabled: s.pttEnabled,
      pttDelay: s.pttDelay,
      inCall: !!s.channelId,
    })),
  );
  const devices = useMediaDevices();
  const test = useMicTest();
  const read = useMicReader(test.pipe);

  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const unlabeled = devices.length > 0 && devices.every((d) => !d.label);
  const custom = ui.inputProfile === 'custom';

  return (
    <div>
      <h3 className="settings-title">Voz</h3>
      <div className="settings-grid">
        <label className="field">
          <span>Microfone</span>
          <select value={ui.inputDeviceId} onChange={(e) => void voice.setInputDevice(e.target.value)}>
            <option value="">Padrão do sistema</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microfone'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Alto-falante</span>
          <select value={ui.outputDeviceId} onChange={(e) => voice.setOutputDevice(e.target.value)}>
            <option value="">Padrão do sistema</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Alto-falante'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            Volume do microfone <em className="muted">{ui.inputVolume}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={ui.inputVolume}
            onChange={(e) => void voice.setMicPrefs({ inputVolume: Number(e.target.value) })}
            onDoubleClick={() => void voice.setMicPrefs({ inputVolume: 100 })}
          />
        </label>
        <label className="field">
          <span>
            Volume do alto-falante <em className="muted">{ui.outputVolume}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={ui.outputVolume}
            onChange={(e) => voice.setOutputVolume(Number(e.target.value))}
            onDoubleClick={() => voice.setOutputVolume(100)}
          />
        </label>
      </div>

      <div className="mic-test-row">
        {ui.inCall ? (
          <span className="small muted mic-test-note">Na chamada: o medidor mostra o seu microfone ao vivo.</span>
        ) : (
          <button className={cx('btn', test.running ? 'btn-secondary' : 'btn-primary')} onClick={test.toggle}>
            {test.running ? 'Parar teste' : 'Teste do microfone'}
          </button>
        )}
        <MicMeter read={read} />
      </div>
      {test.running && <p className="small muted">Fale algo: você vai se ouvir como os outros te ouvem. Use fones para não dar eco.</p>}

      <div className="settings-divider" />

      <h4 className="settings-subtitle">Perfil de entrada</h4>
      {(Object.keys(PROFILE_LABELS) as InputProfile[]).map((p) => (
        <label key={p} className={cx('radio-card', ui.inputProfile === p && 'active')}>
          <input type="radio" checked={ui.inputProfile === p} onChange={() => void voice.setMicPrefs({ inputProfile: p })} />
          <span>
            <strong>{PROFILE_LABELS[p].title}</strong>
            <span className="muted small">{PROFILE_LABELS[p].description}</span>
          </span>
        </label>
      ))}

      {custom && (
        <div className="custom-profile">
          <div className="field">
            <span>Supressão de ruído</span>
            <div className="segmented wide">
              {(Object.keys(NOISE_LABELS) as NoiseMode[]).map((m) => (
                <button key={m} className={cx(ui.noiseSuppression === m && 'active')} title={NOISE_LABELS[m].description} onClick={() => void voice.setMicPrefs({ noiseSuppression: m })}>
                  {NOISE_LABELS[m].title}
                </button>
              ))}
            </div>
            <p className="small muted">{NOISE_LABELS[ui.noiseSuppression].description}</p>
          </div>
          <Toggle
            label="Cancelamento de eco"
            description="Evita que quem fala com você se ouça de volta pelo seu microfone."
            checked={ui.echoCancellation}
            onChange={(v) => void voice.setMicPrefs({ echoCancellation: v })}
          />
          <Toggle
            label="Controle automático de ganho"
            description="Ajusta sozinho o volume da sua voz quando você se afasta ou se aproxima do microfone."
            checked={ui.autoGainControl}
            onChange={(v) => void voice.setMicPrefs({ autoGainControl: v })}
          />
          <Toggle
            label="Determinar a sensibilidade automaticamente"
            description="Só transmite quando o som passa do ruído de fundo."
            checked={ui.sensitivityAuto}
            onChange={(v) => void voice.setMicPrefs({ sensitivityAuto: v })}
          />
          {!ui.sensitivityAuto && (
            <div className="field">
              <span>
                Sensibilidade de entrada <em className="muted">{ui.inputThreshold} dB</em>
              </span>
              <MicMeter read={read} threshold={ui.inputThreshold} onThreshold={(db) => void voice.setMicPrefs({ inputThreshold: db })} />
              <p className="small muted">Arraste: abaixo da marca o microfone fica fechado. A barra fica verde quando você está sendo transmitido.</p>
            </div>
          )}
        </div>
      )}

      <div className="settings-divider" />

      <Toggle
        label="Apertar para falar"
        description="Seu microfone só transmite enquanto a tecla estiver pressionada (com o Concord em primeiro plano)."
        checked={ui.pttEnabled}
        onChange={(v) => voice.setPushToTalk({ pttEnabled: v })}
      />
      {ui.pttEnabled && (
        <div className="settings-grid">
          <div className="field">
            <span>Atalho</span>
            <PttKeyButton />
          </div>
          <label className="field">
            <span>
              Atraso ao soltar <em className="muted">{ui.pttDelay} ms</em>
            </span>
            <input type="range" min={0} max={1000} step={20} value={ui.pttDelay} onChange={(e) => voice.setPushToTalk({ pttDelay: Number(e.target.value) })} />
          </label>
        </div>
      )}

      <div className="settings-divider" />

      <h3 className="settings-title">Câmera</h3>
      <label className="field">
        <span>Câmera</span>
        <select value={ui.videoDeviceId} onChange={(e) => void voice.setVideoDevice(e.target.value)}>
          <option value="">Padrão</option>
          {cameras.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Câmera ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <CameraPreview deviceId={ui.videoDeviceId} />
      {unlabeled && <p className="muted small">Os nomes dos dispositivos aparecem depois que você permitir o microfone e a câmera.</p>}
      <p className="muted small">
        Transporte de voz: {ui.mode === 'livekit' ? 'servidor de mídia (LiveKit)' : 'ponto a ponto (WebRTC)'}, definido pelo servidor.
      </p>
    </div>
  );
}

function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const options: { value: ThemePref; label: string; icon: ReactNode }[] = [
    { value: 'light', label: 'Claro', icon: <Sun size={20} /> },
    { value: 'dark', label: 'Escuro', icon: <Moon size={20} /> },
    { value: 'system', label: 'Sistema', icon: <MonitorCog size={20} /> },
  ];
  return (
    <div>
      <h3 className="settings-title">Tema</h3>
      <div className="theme-options">
        {options.map((o) => (
          <button key={o.value} className={cx('theme-option', `preview-${o.value}`, pref === o.value && 'active')} onClick={() => setThemePref(o.value)}>
            <span className="theme-swatch">
              <span />
              <span />
              <span />
            </span>
            <span className="row gap-8">
              {o.icon} {o.label}
            </span>
          </button>
        ))}
      </div>
      <p className="muted small">“Sistema” acompanha o modo claro/escuro do Windows.</p>
    </div>
  );
}

function AppSettings() {
  const [tray, setTray] = useState(true);
  const [startMin, setStartMin] = useState(false);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  useEffect(() => {
    if (!native) return;
    void native.settings.get<boolean>('MINIMIZE_TO_TRAY').then((v) => setTray(v !== false));
    void native.settings.get<boolean>('START_MINIMIZED').then((v) => setStartMin(!!v));
  }, []);

  if (!native) {
    return (
      <div>
        <h3>Notificações</h3>
        <p className="muted">Estado: {perm === 'granted' ? 'permitidas' : perm === 'denied' ? 'bloqueadas pelo navegador' : 'não definido'}</p>
        {perm === 'default' && (
          <button className="btn btn-primary" onClick={() => void Notification.requestPermission().then(setPerm)}>
            Ativar notificações
          </button>
        )}
        <p className="muted small">Para bandeja do sistema, ícone com contador e seletor de tela, use o app desktop (pasta desktop/).</p>
      </div>
    );
  }

  return (
    <div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={tray}
          onChange={(e) => {
            setTray(e.target.checked);
            void native!.settings.set('MINIMIZE_TO_TRAY', e.target.checked);
          }}
        />
        <span>
          <strong>Minimizar para a bandeja</strong>
          <span className="muted small"> Fechar a janela mantém o Concord rodando na bandeja do sistema.</span>
        </span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={startMin}
          onChange={(e) => {
            setStartMin(e.target.checked);
            void native!.settings.set('START_MINIMIZED', e.target.checked);
          }}
        />
        <span>
          <strong>Iniciar minimizado</strong>
          <span className="muted small"> O Concord abre direto na bandeja.</span>
        </span>
      </label>
    </div>
  );
}

// ---------- Misc ----------

function ScreenPickerModal({ replace }: { replace: boolean }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  useEffect(() => {
    native?.screen
      .getSources()
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  function pick(id: string) {
    native?.screen.select(id);
    closeModal();
    void (replace ? voice.replaceScreenShare() : voice.startScreenShare());
  }

  return (
    <Modal wide title={replace ? 'Alterar a transmissão' : 'Compartilhar tela'} subtitle="Escolha uma tela ou janela para transmitir." onClose={closeModal}>
      {!sources && <Spinner />}
      <div className="source-grid">
        {sources?.map((s) => (
          <button key={s.id} className="source-card" onClick={() => pick(s.id)}>
            <img src={s.thumbnail} alt="" />
            <span className="truncate small">{s.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function NicknameModal({ guildId, userId }: { guildId: string; userId: string }) {
  const isMe = useStore((s) => s.me?.id === userId);
  const current = useStore((s) => s.members[guildId]?.[userId]?.nickname ?? '');
  const fallback = useStore((s) => s.users[userId]?.display_name || s.users[userId]?.username || '');
  const guildName = useStore((s) => s.guilds[guildId]?.name ?? '');
  const [nick, setNick] = useState(current);
  const { busy, error, run } = useBusy();
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/guilds/${guildId}/members/${isMe ? '@me' : userId}`, { method: 'PATCH', body: { nickname: nick.trim() || null } });
      closeModal();
      toast('Apelido atualizado');
    });
  };
  return (
    <Modal
      title={isMe ? 'Editar perfil por servidor' : 'Alterar apelido'}
      subtitle={isMe ? `Como você aparece em ${guildName}. Só vale para este servidor.` : `O apelido aparece em ${guildName}.`}
      onClose={closeModal}
    >
      <form onSubmit={save}>
        <label className="field">
          <span>Apelido</span>
          <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder={fallback} maxLength={32} autoFocus />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {current && (
            <button type="button" className="link" onClick={() => setNick('')}>
              Remover apelido
            </button>
          )}
          <button className="btn btn-primary" disabled={busy}>
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmModal({ title, body, confirmLabel, onConfirm }: { title: string; body: string; confirmLabel: string; onConfirm: () => void | Promise<void> }) {
  const { busy, error, run } = useBusy();
  return (
    <Modal
      title={title}
      onClose={closeModal}
      footer={
        <>
          <button className="link" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => onConfirm())} autoFocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{body}</p>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function ImageModal({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="modal-backdrop image-backdrop" onMouseDown={closeModal}>
      <div className="image-viewer" onMouseDown={(e) => e.stopPropagation()}>
        <img src={url} alt={filename} referrerPolicy="no-referrer" />
        <a href={url} target="_blank" rel="noreferrer" className="link small">
          Abrir original <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  const threadName = useMemo(() => {
    if (modal?.type !== 'createThread' || !modal.message) return '';
    return modal.message.content.replace(/<@\d+>/g, '').replace(/[*_~`|>]/g, '').trim().slice(0, 60);
  }, [modal]);
  if (!modal) return null;
  return renderModal(modal, threadName);
}

function renderModal(modal: ModalState, threadName: string): ReactNode {
  switch (modal.type) {
    case 'createGuild':
      return <CreateGuildModal key={modal.inviteCode ?? ''} initialCode={modal.inviteCode} />;
    case 'invite':
      return <InviteModal guildId={modal.guildId} />;
    case 'createChannel':
      return <CreateChannelModal guildId={modal.guildId} parentId={modal.parentId} channelType={modal.channelType} />;
    case 'channelSettings':
      return <ChannelSettingsModal channelId={modal.channelId} />;
    case 'guildSettings':
      return <GuildSettingsModal key={modal.guildId} guildId={modal.guildId} />;
    case 'userSettings':
      return <UserSettingsModal initialTab={modal.tab} />;
    case 'profile':
      return <ProfileModal key={modal.userId} userId={modal.userId} guildId={modal.guildId} />;
    case 'screenPicker':
      return <ScreenPickerModal replace={!!modal.replace} />;
    case 'nickname':
      return <NicknameModal guildId={modal.guildId} userId={modal.userId} />;
    case 'image':
      return <ImageModal url={modal.url} filename={modal.filename} />;
    case 'createGroup':
      return <CreateGroupModal channelId={modal.channelId} />;
    case 'createThread':
      return <CreateThreadModal channelId={modal.channelId} messageId={modal.message?.id ?? null} initialName={threadName} />;
    case 'confirm':
      return <ConfirmModal key={modal.title} {...modal} />;
  }
}
