// server.js
// Codenames - servidor Socket.IO para rodar no Render.com

const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS amplo para funcionar com HostGator + Render.
// Para maior segurança, troque '*' por ['https://SEU-DOMINIO.com', 'https://www.SEU-DOMINIO.com']
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  }
});

const PORT = process.env.PORT || 3000;

// Endpoint simples para health-check (Render)
app.get('/health', (_, res) => res.status(200).send('ok'));

// ======= UTIL =======
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createGameBoard() {
  const words = [
    "ALPES","SORVETE","FORMULÁRIO","SINO","VIKINGS","PILHA","RAIZ","VOLANTE","FESTA","JATO",
    "BALÃO","LÍNGUA","VERME","SAPO","CONTROLE","LANCHE","GARRA","SATÉLITE","LOBISOMEM","MARFIM",
    "OMBRO","MANICURE","ROBÔ","CORDÃO","MORTEIRO","CÉU","MAR","TERRA","FOGO","AR","SOL","LUA"
  ].sort(() => Math.random() - 0.5).slice(0, 25);

  const roles = [];
  for (let i = 0; i < 9; i++) roles.push('blue');
  for (let i = 0; i < 8; i++) roles.push('red');
  for (let i = 0; i < 7; i++) roles.push('neutral');
  roles.push('assassin');

  const shuffledRoles = roles.sort(() => Math.random() - 0.5);
  return {
    gameData: words.map((w, i) => ({
      word: w,
      role: shuffledRoles[i],   // blue | red | neutral | assassin
      revealed: false,
      clickedBy: null           // 'blue' | 'red' (time que clicou)
    })),
    blueScore: 9,
    redScore: 8,
    currentTurn: 'blue',        // 'blue' | 'red'
    winner: null,
    // clue: { team, clue, count, guessesLeft }
    clue: null
  };
}

// rooms[code] = { players: [{id,nickname,team,role,locked}], game:{...} }
const rooms = {};

function sendPlayers(roomCode) {
  const r = rooms[roomCode]; if (!r) return;
  io.to(roomCode).emit('playersUpdate',
    r.players.map(p => ({ id: p.id, nickname: p.nickname, team: p.team, role: p.role }))
  );
}
function broadcastGame(roomCode) {
  const r = rooms[roomCode]; if (!r) return;
  io.to(roomCode).emit('gameData', r.game);
}
function log(roomCode, text) {
  io.to(roomCode).emit('gameEvent', { text, at: Date.now() });
}
function clearClue(roomCode) {
  const r = rooms[roomCode]; if (!r) return;
  r.game.clue = null;
  io.to(roomCode).emit('clueCleared');
}
function endGame(roomCode, winner) {
  const r = rooms[roomCode]; if (!r) return;
  r.game.winner = winner;
  clearClue(roomCode);
  io.to(roomCode).emit('gameOver', { winner });
  log(roomCode, `Fim de jogo — ${winner === 'blue' ? 'AZUL' : 'VERMELHO'} venceu.`);
}
function swapTurn(roomCode) {
  const g = rooms[roomCode].game;
  g.currentTurn = g.currentTurn === 'blue' ? 'red' : 'blue';
  clearClue(roomCode);
  broadcastGame(roomCode);
  log(roomCode, `Vez do time ${g.currentTurn === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
}

// ======= SOCKET.IO =======
io.on('connection', (socket) => {
  // Criar sala
  socket.on('createRoom', (nickname) => {
    const code = generateRoomCode();
    rooms[code] = {
      players: [{ id: socket.id, nickname, team: null, role: null, locked: false }],
      game: createGameBoard()
    };
    socket.join(code);
    socket.emit('roomCreated', code);
    broadcastGame(code);
    sendPlayers(code);
    log(code, `${nickname} criou a sala ${code}.`);
  });

  // Entrar na sala
  socket.on('joinRoom', ({ roomCode, nickname }) => {
    const r = rooms[roomCode];
    if (!r) return socket.emit('joinError', 'Código de sala inválido.');
    r.players.push({ id: socket.id, nickname, team: null, role: null, locked: false });
    socket.join(roomCode);
    socket.emit('roomJoined', roomCode);
    broadcastGame(roomCode);
    sendPlayers(roomCode);
    log(roomCode, `${nickname} entrou na sala.`);
  });

  // Selecionar papel/time — TRAVADO após a primeira escolha
  socket.on('selectRole', ({ roomCode, team, role }) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id === socket.id); if (!me) return;

    if (me.locked) return socket.emit('roleError', 'Seu time e função estão travados nesta partida.');

    if (!['blue','red'].includes(team) || !['spymaster','operative'].includes(role)) {
      return socket.emit('roleError', 'Time ou função inválidos.');
    }

    if (role === 'spymaster') {
      const taken = r.players.find(p => p.id !== socket.id && p.team === team && p.role === 'spymaster');
      if (taken) return socket.emit('roleError', `Já existe um espião-mestre no time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
    }

    me.team = team;
    me.role = role;
    me.locked = true;
    sendPlayers(roomCode);
    log(roomCode, `${me.nickname} virou ${role === 'spymaster' ? 'espião-mestre' : 'agente de campo'} do time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
  });

  // Enviar dica — apenas spymaster do turno; 1 dica ativa por turno; não pode alterar depois
  socket.on('sendClue', ({ roomCode, clue, count }) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id === socket.id); if (!me) return;
    const g = r.game;

    if (g.clue) return socket.emit('roleError', 'Já existe uma dica ativa. Aguarde o fim do turno.');
    if (!(me.role === 'spymaster' && me.team === g.currentTurn)) {
      return socket.emit('roleError', 'Apenas o espião-mestre do time do turno pode dar dica.');
    }

    const n = Number(count);
    if (!clue || !Number.isInteger(n) || n < 1 || n > 9) {
      return socket.emit('roleError', 'Informe uma dica válida com número entre 1 e 9.');
    }

    g.clue = { team: me.team, clue: String(clue).trim(), count: n, guessesLeft: n };
    io.to(roomCode).emit('clueUpdate', g.clue);
  });

  // Parar de adivinhar — encerra o turno do time atual
  socket.on('endTurn', (roomCode) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id === socket.id); if (!me) return;
    const g = r.game;

    if (!(me.team === g.currentTurn && (me.role === 'operative' || me.role === 'spymaster'))) return;
    swapTurn(roomCode);
  });

  // Clique numa carta — apenas operativo do time do turno; consome 1 palpite; aplica clickedBy
  socket.on('cardClicked', ({ roomCode, cardIndex }) => {
    const r = rooms[roomCode]; if (!r) return;
    const g = r.game; const c = g.gameData[cardIndex];
    if (!c || c.revealed || g.winner) return;

    const me = r.players.find(p => p.id === socket.id); if (!me) return;

    // precisa de dica ativa + ser agente do time do turno + ainda ter palpites
    if (!(g.clue && g.clue.guessesLeft > 0 && me.team === g.currentTurn && me.role === 'operative')) return;

    c.revealed = true;
    c.clickedBy = me.team;

    if (c.role === 'assassin') {
      const loser = g.currentTurn;
      const winner = loser === 'blue' ? 'red' : 'blue';
      endGame(roomCode, winner);
      return;
    }

    if (c.role === 'blue') {
      g.blueScore -= 1;
      if (g.blueScore === 0) { endGame(roomCode, 'blue'); return; }
    } else if (c.role === 'red') {
      g.redScore -= 1;
      if (g.redScore === 0) { endGame(roomCode, 'red'); return; }
    }

    // consume 1 palpite sempre
    g.clue.guessesLeft = Math.max(0, g.clue.guessesLeft - 1);
    io.to(roomCode).emit('clueUpdate', g.clue);

    // troca de turno se: neutra, cor errada, ou acabou guessesLeft
    if (c.role === 'neutral' || c.role !== g.currentTurn || g.clue.guessesLeft === 0) {
      swapTurn(roomCode);
      return;
    }

    broadcastGame(roomCode);
  });

  // Reiniciar — novo board e papéis destravados
  socket.on('requestRestart', (roomCode) => {
    const r = rooms[roomCode]; if (!r) return;
    r.game = createGameBoard();
    r.players.forEach(p => { p.team = null; p.role = null; p.locked = false; });
    io.to(roomCode).emit('gameRestarted');
    clearClue(roomCode);
    broadcastGame(roomCode);
    sendPlayers(roomCode);
    log(roomCode, 'Partida reiniciada.');
  });

  // Sair
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const r = rooms[code];
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const [out] = r.players.splice(idx, 1);
        sendPlayers(code);
        log(code, `${out.nickname || 'Jogador'} saiu da sala.`);
        if (r.players.length === 0) delete rooms[code];
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Pronto para o Render em https://codenamesfirma.onrender.com`);
});
