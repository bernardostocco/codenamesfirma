const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS: ajuste os domínios do seu site aqui se necessário
const io = socketIo(server, {
  cors: {
    origin: ['https://SEU-DOMINIO.com', 'https://www.SEU-DOMINIO.com'], // opcional
    methods: ['GET','POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));

// ===== Util =====
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
    gameData: words.map((w, i) => ({ word: w, role: shuffledRoles[i], revealed: false })),
    blueScore: 9,
    redScore: 8,
    currentTurn: 'blue',
    winner: null,
    // clue: {team, clue, count, guessesLeft}
    clue: null
  };
}

// rooms[code] = { players: [{id,nickname,team,role,locked}], game:{...} }
const rooms = {};

function broadcastGame(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  io.to(roomCode).emit('gameData', room.game);
}
function sendPlayers(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  io.to(roomCode).emit('playersUpdate', room.players.map(p => ({
    id: p.id, nickname: p.nickname, team: p.team, role: p.role
  })));
}
function log(roomCode, text) { io.to(roomCode).emit('gameEvent', { text, at: Date.now() }); }
function clearClue(roomCode) {
  const room = rooms[roomCode]; if (!room) return;
  room.game.clue = null;
  io.to(roomCode).emit('clueCleared');
}
function endGame(roomCode, winner) {
  const room = rooms[roomCode]; if (!room) return;
  room.game.winner = winner;
  clearClue(roomCode);
  io.to(roomCode).emit('gameOver', { winner });
  log(roomCode, `Fim de jogo — ${winner === 'blue' ? 'AZUL' : 'VERMELHO'} venceu.`);
}
function swapTurn(roomCode) {
  const g = rooms[roomCode].game;
  g.currentTurn = g.currentTurn === 'blue' ? 'red' : 'blue';
  clearClue(roomCode);
  broadcastGame(roomCode);
  log(roomCode, `Vez passada para o time ${g.currentTurn === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (nickname) => {
    const code = generateRoomCode();
    rooms[code] = { players: [{ id: socket.id, nickname, team: null, role: null, locked: false }], game: createGameBoard() };
    socket.join(code);
    socket.emit('roomCreated', code);
    broadcastGame(code);
    sendPlayers(code);
    log(code, `${nickname} criou a sala ${code}.`);
  });

  socket.on('joinRoom', ({ roomCode, nickname }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('joinError', 'Código de sala inválido.');
    room.players.push({ id: socket.id, nickname, team: null, role: null, locked: false });
    socket.join(roomCode);
    socket.emit('roomJoined', roomCode);
    broadcastGame(roomCode);
    sendPlayers(roomCode);
    log(roomCode, `${nickname} entrou na sala.`);
  });

  // Seleção de time/função — agora TRAVADA após escolher a primeira vez
  socket.on('selectRole', ({ roomCode, team, role }) => {
    const room = rooms[roomCode]; if (!room) return;
    const me = room.players.find(p => p.id === socket.id); if (!me) return;

    if (me.locked) return socket.emit('roleError', 'Seu time e função estão travados nesta partida.');

    const validTeam = team === 'blue' || team === 'red';
    const validRole = role === 'spymaster' || role === 'operative';
    if (!validTeam || !validRole) return socket.emit('roleError', 'Time ou função inválidos.');

    if (role === 'spymaster') {
      const already = room.players.find(p => p.id !== socket.id && p.team === team && p.role === 'spymaster');
      if (already) return socket.emit('roleError', `Já existe um espião-mestre no time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
    }

    me.team = team;
    me.role = role;
    me.locked = true; // <<< trava troca
    sendPlayers(roomCode);
    log(roomCode, `${me.nickname} agora é ${role === 'spymaster' ? 'espião-mestre' : 'agente de campo'} do time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
  });

  // Dica do spymaster — cria contador de palpites
  socket.on('sendClue', ({ roomCode, clue, count }) => {
    const room = rooms[roomCode]; if (!room) return;
    const me = room.players.find(p => p.id === socket.id); if (!me) return;
    const g = room.game;

    if (me.role !== 'spymaster' || me.team !== g.currentTurn) {
      return socket.emit('roleError', 'Apenas o espião-mestre do time do turno pode dar dica.');
    }
    const n = Number(count);
    if (!clue || !Number.isInteger(n) || n < 1 || n > 9) {
      return socket.emit('roleError', 'Dica inválida. Informe a palavra e um número de 1 a 9.');
    }

    g.clue = { team: me.team, clue: String(clue).trim(), count: n, guessesLeft: n };
    io.to(roomCode).emit('clueUpdate', g.clue);
  });

  // Parar de adivinhar — só time do turno pode
  socket.on('endTurn', (roomCode) => {
    const room = rooms[roomCode]; if (!room) return;
    const me = room.players.find(p => p.id === socket.id); if (!me) return;
    const g = room.game;
    if (!(me.team === g.currentTurn && (me.role === 'operative' || me.role === 'spymaster'))) {
      return socket.emit('roleError', 'Apenas o time do turno pode encerrar a rodada.');
    }
    swapTurn(roomCode);
  });

  // Clique em carta — apenas agente do time do turno, e com limite de palpites ativos
  socket.on('cardClicked', ({ roomCode, cardIndex }) => {
    const room = rooms[roomCode]; if (!room) return;
    const g = room.game; const c = g.gameData[cardIndex];
    if (!c || c.revealed || g.winner) return;

    const me = room.players.find(p => p.id === socket.id); if (!me) return;
    // precisa ter dica ativa e ser agente do time do turno
    if (!(g.clue && g.clue.guessesLeft > 0 && me.team === g.currentTurn && me.role === 'operative')) return;

    c.revealed = true;

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

    // Consome 1 palpite SEMPRE que clicar
    if (g.clue) {
      g.clue.guessesLeft = Math.max(0, g.clue.guessesLeft - 1);
      io.to(roomCode).emit('clueUpdate', g.clue);
    }

    // Troca de turno se neutra ou da cor errada; caso contrário, troca quando acabar guessesLeft
    if (c.role === 'neutral' || c.role !== g.currentTurn) {
      swapTurn(roomCode);
      return;
    } else if (g.clue && g.clue.guessesLeft === 0) {
      swapTurn(roomCode);
      return;
    }

    broadcastGame(roomCode);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const [out] = room.players.splice(idx, 1);
        sendPlayers(code);
        log(code, `${out.nickname || 'Jogador'} saiu da sala.`);
        if (room.players.length === 0) delete rooms[code];
      }
    }
  });

  socket.on('requestRestart', (roomCode) => {
    const room = rooms[roomCode]; if (!room) return;
    room.game = createGameBoard();
    // desbloqueia papéis numa nova partida
    room.players.forEach(p => { p.team = null; p.role = null; p.locked = false; });
    io.to(roomCode).emit('gameRestarted');
    clearClue(roomCode);
    broadcastGame(roomCode);
    sendPlayers(roomCode);
    log(roomCode, `Partida reiniciada.`);
  });
});

server.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
