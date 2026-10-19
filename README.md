# Concord

Chat em tempo real no estilo Discord: servidores com cargos e permissões, canais de texto e de voz, threads, DMs e grupos, chamadas de voz e vídeo com compartilhamento de tela, prévias de links e app desktop.

A arquitetura segue o que a análise do cliente Discord (via [REA](https://github.com/morluto/rea)) mostrou: um **shell Electron fino** (splash, janela sem moldura, bandeja, notificações, estado da janela persistido, ponte nativa via `contextBridge`) que carrega um **web app** servido por um backend com **REST + gateway WebSocket**. Todo o código é original.

## Estrutura

```
server/   Node + Express 5 + ws + SQLite nativo (node:sqlite). REST em /api, gateway em /gateway, uploads em /uploads
client/   React 19 + Vite + Zustand. Web app completo (roda no navegador ou dentro do desktop)
desktop/  Electron: main.js (janela, bandeja, IPC), preload.js (window.ConcordNative), splash.html
deploy/   docker-compose para produção: Concord + Caddy (HTTPS) + coturn (TURN) + LiveKit (opcional)
```

## Rodando localmente

Requer Node 22.5+ (usa `node:sqlite`).

```bash
npm install
# Se o npm 11 bloquear o download do Electron (aviso de "install-scripts"):
node node_modules/electron/install.js

# Desktop: compila o cliente, sobe o servidor e abre o app (Ctrl+C no terminal encerra o servidor)
npm run desktop

# Desenvolvimento com hot reload (servidor :3001 + Vite :5173)
npm run dev            # abra http://localhost:5173

# Partes separadas
npm run build          # compila o cliente em client/dist
npm start              # servidor em http://localhost:3001 (já serve o cliente)
npm run desktop:shell  # só o app desktop, para um servidor já rodando (ou CONCORD_URL=...)
```

> No terminal do VS Code a variável `ELECTRON_RUN_AS_NODE` pode estar definida, e aí o Electron roda como Node puro. Se o desktop falhar com "Cannot find module 'electron'", rode sem ela: `env -u ELECTRON_RUN_AS_NODE npm run desktop`.

Bancos criados pela versão anterior são migrados automaticamente na primeira inicialização (`PRAGMA user_version`); quem era "admin" vira o cargo **Admin**.

## Funcionalidades

**Contas e perfil:** registro e login (senha com scrypt, sessão por token), nome de exibição, avatar, status (disponível, ausente, não perturbe, invisível), status personalizado, perfil com cargos e servidores em comum.

**Servidores:** criar, renomear, ícone, excluir, transferir posse; convites com código (expiração e limite de usos); categorias recolhíveis; canais de texto e de voz; tópico do canal.

**Cargos e permissões:** cargos ilimitados (até 50) com nome, cor, exibição separada na lista de membros e ordem; 16 permissões (ver canais, enviar mensagens, anexar, reagir, criar threads, gerenciar mensagens/canais/cargos/servidor, expulsar, convidar, apelidos, conectar, falar, transmitir, administrador); hierarquia (só se gerencia quem está abaixo); permissões por canal com permitir/herdar/negar por cargo e sincronização com a categoria. O servidor só envia a cada membro os canais e mensagens que ele pode ver.

**Mensagens:** tempo real; histórico com scroll infinito; markdown (negrito, itálico, sublinhado, tachado, código, citação, spoiler, links); menções `@usuário` com autocomplete; responder, editar, excluir, reagir, fixar; anexos até 25 MB por botão, colar ou arrastar; indicador de digitação; busca; **prévias de links** (título, descrição, imagem; `<link>` suprime a prévia).

**Threads:** criadas a partir de uma mensagem ou avulsas, listadas embaixo do canal, arquivar e reabrir, contador de mensagens.

**Amigos, DMs e grupos:** pedidos de amizade; DMs 1:1; **grupos** de até 10 amigos com nome editável, adicionar e remover pessoas, sair do grupo e mensagens de sistema.

**Voz e vídeo:** canais de voz e **chamadas em DMs e grupos** (com toque, atender e recusar); silenciar e ensurdecer; indicador de quem fala; câmera; compartilhamento de tela **com o áudio do PC sem as vozes da chamada** (o som do próprio Concord é excluído da captura, então ninguém se ouve de volta) e seletor de fontes no desktop; grade e modo destaque; troca de microfone e saída; reconexão automática.
Dois modos de transporte, escolhidos pelo servidor:
- **P2P (padrão):** WebRTC em malha, sem servidor de mídia. Ideal até ~6–8 pessoas por canal. Com `TURN_*` configurado, funciona mesmo em redes restritivas.
- **LiveKit (opcional):** um servidor de mídia (SFU) para canais grandes. Liga sozinho quando `LIVEKIT_*` está definido; o cliente baixa a biblioteca só nesse caso.

**Moderação e controles na voz:** clique com o botão direito em alguém na sala (ou use o botão ⋮ no vídeo) para ajustar o volume dessa pessoa de 0 a 200% e silenciá-la só para você (fica salvo neste aparelho). Quem tem as permissões **Silenciar membros** / **Mover membros** / **Expulsar membros** também pode silenciar para todos, mover para outra sala de voz, desconectar da voz ou expulsar do servidor. Cada canal de voz tem um chat de texto próprio, no painel ao lado da sala.

**Dispositivos:** escolha de microfone, saída de áudio e câmera nas configurações (com prévia da câmera) e direto na chamada, pela setinha ao lado dos botões de microfone e câmera. A troca acontece sem cair da ligação.

**Transcrição de chamadas:** qualquer participante liga a transcrição pelo botão de legendas. Todos veem o aviso "Transcrevendo", as legendas aparecem ao vivo sobre o vídeo e o painel lista cada fala com nome e horário, com download em `.txt`. Cada pessoa envia só o próprio microfone, então o texto já sai identificado. Por padrão roda o **Whisper "small" no próprio servidor** (gratuito, o áudio não sai da sua máquina; o modelo de ~250 MB é baixado na primeira vez). Cada fala é **salva no banco** assim que é transcrita: o botão de transcrições no topo do canal de voz (ou da DM) tem as abas "Ao vivo" e "Salvas", com o histórico para ler, baixar em `.txt` ou excluir. Quem pode ver o canal pode ler; excluir, só quem iniciou ou quem tem "Gerenciar mensagens". Sessões em que ninguém falou não são guardadas.

**Aparência:** tema claro (padrão), escuro ou seguindo o sistema, em Configurações → Aparência ou no menu do seu avatar.

**Segurança:** limite de requisições (login, cadastro, mensagens, uploads, convites e gateway); prévias de links protegidas contra SSRF (bloqueia IPs internos em cada DNS e redirecionamento); TURN não retransmite para redes privadas; CSP no app; uploads que não são mídia são servidos como download.

**Recuperação de senha:** sem e-mail, a conta usa um código de recuperação (`XXXXX-XXXXX-XXXXX-XXXXX`, 100 bits) mostrado uma vez no cadastro e guardado só como hash. Na tela de login, "Esqueceu a senha?" pede usuário + código + nova senha; o reset encerra todas as sessões e troca o código. Em Configurações > Minha conta dá para trocar a senha (pede a atual) e gerar um novo código (contas antigas ganham o primeiro por aí). Tentativas de reset: 5/hora por conta e 10/hora por IP.

**Desktop:** splash, janela sem moldura, minimizar para a bandeja, iniciar minimizado, posição e tamanho lembrados, instância única, notificações nativas, contador na barra de tarefas, piscar ao receber mensagem ou chamada.

## Colocar no ar (para os amigos usarem)

Microfone, câmera e tela só funcionam em `localhost` ou **HTTPS**, então para outras pessoas usarem você precisa de um domínio. Receita para uma VPS Linux comum (2 GB de RAM bastam; com a transcrição local, prefira 4 GB, porque o Whisper usa ~300 MB e bastante CPU enquanto transcreve):

1. Aponte um registro DNS `A` (ex.: `chat.seudominio.com`) para o IP da VPS.
2. Libere no firewall: `80/tcp`, `443/tcp`, `443/udp`, `3478/tcp+udp` e `49160-49200/udp` (TURN). Com LiveKit, também `7881/tcp` e `50000-50100/udp`.
3. Na VPS, com Docker instalado:
   ```bash
   git clone <seu-repo> concord && cd concord/deploy
   cp .env.example .env      # preencha CONCORD_DOMAIN e TURN_SECRET (openssl rand -hex 32)
   docker compose up -d --build
   ```
4. Acesse `https://chat.seudominio.com`. O Caddy emite o certificado sozinho.
5. Para o app desktop dos amigos, rode com `CONCORD_URL=https://chat.seudominio.com`.

**VPS que já tem Nginx Proxy Manager (portas 80/443 ocupadas):** use `deploy/docker-compose.npm.yml`. Ele não sobe o Caddy nem publica porta HTTP: o Concord entra na rede Docker do NPM (`NPM_NETWORK` no `.env`) com limite de CPU e memória. Suba com `docker compose -f docker-compose.npm.yml up -d --build` e, no NPM, crie um Proxy Host `CONCORD_DOMAIN` → `http://concord:3001` com "Websockets Support" e SSL do Let's Encrypt. Se o DNS estiver na Cloudflare, `TURN_HOST` precisa ser um registro **sem proxy** (nuvem cinza), porque o TURN usa UDP.

**LiveKit (canais com muita gente):** crie um segundo DNS (ex.: `livekit.seudominio.com`), preencha as variáveis `LIVEKIT_*` no `.env` e suba com `docker compose --profile livekit up -d --build`.

### Variáveis do servidor

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `PORT` | porta HTTP | `3001` |
| `CONCORD_DATA_DIR` | banco + uploads | `server/data` |
| `TRUST_PROXY` | atrás de proxy (Caddy/nginx), para os limites verem o IP real | — |
| `STUN_URLS` | servidores STUN (vírgula) | STUN público do Google |
| `TURN_URLS` | servidores TURN (vírgula) | — |
| `TURN_SECRET` | segredo do coturn (credenciais temporárias por usuário) | — |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | credenciais fixas (TURN gerenciado: Cloudflare, Metered…) | — |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ativa o modo LiveKit | — |
| `CONCORD_EMBEDS` | `0` desliga as prévias de links | ligado |
| `TRANSCRIBE` | `0` desliga a transcrição | ligado |
| `TRANSCRIBE_MODEL` | modelo Whisper local (`onnx-community/whisper-base` é ~2× mais rápido, mas erra palavras curtas como "entendi") | `onnx-community/whisper-small` |
| `TRANSCRIBE_LANGUAGE` | idioma das chamadas (código ISO) | `pt` |
| `TRANSCRIBE_API_URL` / `TRANSCRIBE_API_KEY` / `TRANSCRIBE_API_MODEL` | usa uma API compatível com OpenAI no lugar do Whisper local (ex.: `https://api.groq.com/openai/v1` + `whisper-large-v3`) | — |
| `TRANSCRIBE_DEBUG_DIR` | salva cada trecho de áudio recebido como `.wav` (só para depurar) | — |

Cliente e desktop: `CONCORD_URL` (desktop), `CONCORD_SERVER` (proxy do Vite), `VITE_API_URL` (API em outra origem).

## Limites conhecidos

- SQLite atende um servidor único; para escalar horizontalmente, migre para Postgres e use pub/sub (Redis) no gateway.
- Sem emojis customizados, stickers, eventos, cargos por membro em canais (só por cargo), edição de senha/username nem 2FA.
- O desktop ainda não tem instalador nem autoatualização (dá para empacotar com electron-builder).
