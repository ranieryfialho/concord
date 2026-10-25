import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACTIVITY_VERB } from '../activity';
import { native, type CustomGame, type RunningProgram } from '../native';
import { useStore } from '../store';
import { useActivities } from './Activity';

/** Configurações → Atividade (desktop): sharing, the overlay, and registered games. */
export function ActivitySettings() {
  const meId = useStore((s) => s.me!.id);
  const now = useActivities(meId);
  const [share, setShare] = useState(true);
  const [overlay, setOverlay] = useState(true);
  const [games, setGames] = useState<CustomGame[]>([]);
  const [running, setRunning] = useState<RunningProgram[] | null>(null);
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    void native!.settings.get<boolean>('SHARE_ACTIVITY').then((v) => setShare(v !== false));
    void native!.settings.get<boolean>('OVERLAY').then((v) => setOverlay(v !== false));
    void native!.activity!.games.list().then(setGames);
  }, []);

  async function loadRunning() {
    setRunning(null);
    const list = await native!.activity!.runningPrograms();
    setRunning(list);
    setPick('');
    setName('');
  }

  async function add() {
    const program = running?.find((p) => p.exe === pick);
    if (!program || !name.trim()) return;
    await native!.activity!.games.add({ exe: program.exe, name: name.trim() });
    setGames(await native!.activity!.games.list());
    setPick('');
    setName('');
  }

  async function remove(exe: string) {
    await native!.activity!.games.remove(exe);
    setGames(await native!.activity!.games.list());
  }

  return (
    <div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={share}
          onChange={(e) => {
            setShare(e.target.checked);
            void native!.settings.set('SHARE_ACTIVITY', e.target.checked);
          }}
        />
        <span>
          <strong>Compartilhar minha atividade</strong>
          <span className="muted small"> Mostra para os outros o jogo aberto e o que apps com Rich Presence (como o VS Code) informam.</span>
        </span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={overlay}
          onChange={(e) => {
            setOverlay(e.target.checked);
            void native!.settings.set('OVERLAY', e.target.checked);
          }}
        />
        <span>
          <strong>Overlay de voz nos jogos</strong>
          <span className="muted small"> Mostra quem está na sala e quem está falando no canto da tela enquanto um jogo está aberto (modo janela ou tela cheia sem bordas).</span>
        </span>
      </label>

      <h3>Agora</h3>
      {now.length ? (
        now.map((a, i) => (
          <p key={i}>
            {ACTIVITY_VERB[a.type] ?? 'Jogando'} <strong>{a.name}</strong>
            {a.details && <span className="muted"> · {a.details}</span>}
          </p>
        ))
      ) : (
        <p className="muted">{share ? 'Nenhum jogo ou app detectado.' : 'Compartilhamento desligado.'}</p>
      )}

      <h3>Jogos adicionados</h3>
      {games.length ? (
        <div className="game-list">
          {games.map((g) => (
            <div key={g.exe} className="game-row">
              <span>
                <strong>{g.name}</strong> <span className="muted small">{g.exe}</span>
              </span>
              <button className="icon-btn danger" title="Remover" onClick={() => void remove(g.exe)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">O Concord já reconhece os jogos mais populares. Se o seu não aparecer, adicione-o abaixo com ele aberto.</p>
      )}

      <div className="game-add">
        {running === null ? (
          <button className="btn" onClick={() => void loadRunning()}>
            Adicionar jogo…
          </button>
        ) : (
          <>
            <select
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                const p = running.find((r) => r.exe === e.target.value);
                setName(p?.known ?? p?.name ?? '');
              }}
            >
              <option value="">Escolha um programa aberto…</option>
              {running.map((p) => (
                <option key={p.exe} value={p.exe}>
                  {p.name} ({p.exe})
                </option>
              ))}
            </select>
            <input value={name} maxLength={128} placeholder="Nome que os outros vão ver" onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={!pick || !name.trim()} onClick={() => void add()}>
              Adicionar
            </button>
            <button className="btn" onClick={() => void loadRunning()}>
              Atualizar lista
            </button>
          </>
        )}
      </div>
    </div>
  );
}
