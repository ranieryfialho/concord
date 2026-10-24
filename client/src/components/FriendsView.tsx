import { Check, MessageCircle, UserMinus, Users, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { closeModal, nameOf, openDM, openModal, presenceOf, toast, useStore } from '../store';
import type { RelationshipType } from '../types';
import { PRESENCE_LABEL, cx } from '../utils';
import { Avatar, MobileBack } from './common';

type Tab = 'online' | 'all' | 'pending' | 'add';

function FriendRow({ userId, type }: { userId: string; type: RelationshipType }) {
  const name = useStore((s) => nameOf(s, userId));
  const user = useStore((s) => s.users[userId]);
  const presence = useStore((s) => presenceOf(s, userId));

  const act = (p: Promise<unknown>) => p.catch((e: Error) => toast(e.message));
  const subtitle =
    type === 'pending_in' ? 'Pedido de amizade recebido' : type === 'pending_out' ? 'Pedido de amizade enviado' : user?.custom_status || PRESENCE_LABEL[presence];

  return (
    <div className="friend-row" onClick={() => type === 'friend' && void openDM(userId)}>
      <Avatar userId={userId} size={36} status={type === 'friend'} />
      <div className="friend-text">
        <span>
          <strong>{name}</strong> <span className="muted small friend-username">{user?.username}</span>
        </span>
        <span className="small muted">{subtitle}</span>
      </div>
      <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
        {type === 'friend' && (
          <>
            <button className="round-btn" title="Mensagem" onClick={() => void openDM(userId)}>
              <MessageCircle size={18} />
            </button>
            <button
              className="round-btn danger"
              title="Remover amizade"
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: `Remover '${name}'`,
                  body: `Tem certeza de que deseja remover ${name} dos seus amigos?`,
                  confirmLabel: 'Remover amizade',
                  onConfirm: async () => {
                    await api(`/users/@me/relationships/${userId}`, { method: 'DELETE' });
                    closeModal();
                  },
                })
              }
            >
              <UserMinus size={18} />
            </button>
          </>
        )}
        {type === 'pending_in' && (
          <button className="round-btn success" title="Aceitar" onClick={() => void act(api(`/users/@me/relationships/${userId}`, { method: 'PUT' }))}>
            <Check size={18} />
          </button>
        )}
        {type !== 'friend' && (
          <button
            className="round-btn danger"
            title={type === 'pending_in' ? 'Recusar' : 'Cancelar'}
            onClick={() => void act(api(`/users/@me/relationships/${userId}`, { method: 'DELETE' }))}
          >
            <X size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/users/@me/relationships', { body: { username: username.trim() } });
      setResult({ ok: true, text: `Pedido de amizade enviado para ${username.trim()}!` });
      setUsername('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <div className="add-friend">
      <h3>Adicionar amigo</h3>
      <p className="muted">Você pode adicionar amigos com o nome de usuário deles.</p>
      <form className={cx('add-friend-form', result && (result.ok ? 'ok' : 'error'))} onSubmit={submit}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Digite um nome de usuário" autoFocus />
        <button className="btn btn-primary" disabled={!username.trim()}>
          Enviar pedido de amizade
        </button>
      </form>
      {result && <p className={result.ok ? 'form-ok' : 'form-error'}>{result.text}</p>}
    </div>
  );
}

export function FriendsView() {
  const [tab, setTab] = useState<Tab>('online');
  const entries = useStore(
    useShallow((s) => Object.entries(s.relationships).map(([id, type]) => `${id}|${type}|${presenceOf(s, id)}`)),
  ).map((e) => {
    const [id, type, presence] = e.split('|');
    return { id, type: type as RelationshipType, presence };
  });
  const pendingCount = entries.filter((e) => e.type === 'pending_in').length;

  const list =
    tab === 'online'
      ? entries.filter((e) => e.type === 'friend' && e.presence !== 'offline')
      : tab === 'all'
        ? entries.filter((e) => e.type === 'friend')
        : entries.filter((e) => e.type !== 'friend');

  const title = tab === 'online' ? 'Disponível' : tab === 'all' ? 'Todos os amigos' : 'Pendente';

  return (
    <div className="friends">
      <header className="chat-header">
        <MobileBack />
        <Users size={22} className="muted" />
        <h3>Amigos</h3>
        <span className="header-divider" />
        {(['online', 'all', 'pending'] as Tab[]).map((t) => (
          <button key={t} className={cx('tab-btn', tab === t && 'active')} onClick={() => setTab(t)}>
            {t === 'online' ? 'Disponível' : t === 'all' ? 'Todos' : 'Pendente'}
            {t === 'pending' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
        ))}
        <button className={cx('tab-btn add', tab === 'add' && 'active')} onClick={() => setTab('add')}>
          Adicionar amigo
        </button>
      </header>
      <div className="friends-body scroll">
        {tab === 'add' ? (
          <AddFriend />
        ) : (
          <>
            <h4 className="member-section">
              {title} — {list.length}
            </h4>
            {list.map((e) => (
              <FriendRow key={e.id} userId={e.id} type={e.type} />
            ))}
            {!list.length && (
              <div className="empty-state">
                <p className="muted">
                  {tab === 'pending' ? 'Não há pedidos de amizade pendentes.' : 'Ninguém por aqui ainda. Que tal adicionar um amigo?'}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
