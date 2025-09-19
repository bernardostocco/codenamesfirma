const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));

// ===== Util =====
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createGameBoard() {
  const words = [
    "MOISÉS","BAKOWSKI","DRY","BANHADO","CAPOEIRA","GUTA","BERTUZZO","MACHADO","JOTA","BERNARDO",
"VASCO","JAO","MATI","BIEL SAM","NANDES","PEKET","ABABA","ENZINHO","BERNARDES","COLOMBIA",
"PRENSADO","ICE","HAXIXE","GIN DE 10","MEOW","COPAO","PIT STOP","YURINEI","SINUCA","LUISINHO",
"KALIL","MATH PESSOA","TUTY","VALORANT","FRIKAS","PARQUINHO","JONAI","XANDÃO","FABIO LINHARES","XELAS127",
"RAIO","CANAL GOAT","FUVEST","CAVEIRO","RAFA BRUM","NATY KUMAGAI","JULIA PULGA","FAGÁ","LIVINHA","GRAZI",
"RAFA MOTTA","THAINA MINI","POLIEDRO","ANGLO","TIO ED","NEGUIN","SEGRETO","GK","FIRMA","ÁRVORE",
"ALEXANDRE","TORTIN","TOLEDO","BEN 10","JUH VIEIRA","DEU ROCK","OREIA","ESFIRRA","MEGA STACKER","BUNDA",
"CIGARRO","MACONHA","PICASSO","FOFOCA","COMUNICA CHURRAS","CHICO GRILO","ROCK N RIBS","APG CLAN","CSGO","MINECRAFT",
"ROCKET LEAGUE","FALLEN","TABATINGA","JURITI","NENAS","MURILO","MILHARAL","LADEIRA","PAULET","OXXO",
"URBANOVA","MR HOPPY","REPUBLIC","COLINAS","SOMBRA","CORSA","COPA COPAO","LAS BIRITAS","CENTO E ONZE","ARIANE",
"CANTINATURAL","ANA CECILIA","SILVIA","RENATO FILO","TATI","RONALDO","D7","DECK","MASTERGOLD","CHANCELER",
"LH","APRESUNTADO","CERVEJA","SANTOS","MADRUGADAO","CARECA","NICOLÁS","GANSO","TAZ 24H","BLOONS",
"LOL","GREGATE","FUTEBOL","BASQUETE","PAK","KALVALA","SANTORO","ARAKINHO","MALOI","ZENO",
"BOLT","CHICO","TUTINHO","HELENA","RISCALA","PPP","DIMITRI","CADAVAL","FERRÃO","IAGO BALÃO",
"MIRACY","LUCIANA MAY","GABIGOL","FLORINDO","SATURNINO","FLECHA","PAULO H S","DAMATTA","RUBEN","MELECA",
"JACAPAL","NARGUILE","DHE","CAMPINAS","NINO","OBECO","SANTONOFRE"

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
    clue: null // {team, clue, count}
  };
}

// rooms[code] = { players: [{id,nickname,team,role}], game:{...} }
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
function log(roomCode, text) {
  io.to(roomCode).emit('gameEvent', { text, at: Date.now() });
}
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

io.on('connection', (socket) => {
  socket.on('createRoom', (nickname) => {
    const code = generateRoomCode();
    rooms[code] = { players: [{ id: socket.id, nickname, team: null, role: null }], game: createGameBoard() };
    socket.join(code);
    socket.emit('roomCreated', code);
    broadcastGame(code);
    sendPlayers(code);
    log(code, `${nickname} criou a sala ${code}.`);
  });

  socket.on('joinRoom', ({ roomCode, nickname }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('joinError', 'Código de sala inválido.');
    room.players.push({ id: socket.id, nickname, team: null, role: null });
    socket.join(roomCode);
    socket.emit('roomJoined', roomCode);
    broadcastGame(roomCode);
    sendPlayers(roomCode);
    log(roomCode, `${nickname} entrou na sala.`);
  });

  // trocar time/função (1 spymaster por time)
  socket.on('selectRole', ({ roomCode, team, role }) => {
    const room = rooms[roomCode]; if (!room) return;
    const validTeam = team === 'blue' || team === 'red';
    const validRole = role === 'spymaster' || role === 'operative';
    if (!validTeam || !validRole) return socket.emit('roleError', 'Time ou função inválidos.');

    const me = room.players.find(p => p.id === socket.id); if (!me) return;

    if (role === 'spymaster') {
      const already = room.players.find(p => p.id !== socket.id && p.team === team && p.role === 'spymaster');
      if (already) return socket.emit('roleError', `Já existe um espião-mestre no time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
    }
    me.team = team;
    me.role = role;
    sendPlayers(roomCode);
    log(roomCode, `${me.nickname} agora é ${role === 'spymaster' ? 'espião-mestre' : 'agente de campo'} do time ${team === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
  });

  // dica do spymaster (sem log no registro)
  socket.on('sendClue', ({ roomCode, clue, count }) => {
    const room = rooms[roomCode]; if (!room) return;
    const me = room.players.find(p => p.id === socket.id); if (!me) return;
    if (me.role !== 'spymaster' || me.team !== room.game.currentTurn) {
      return socket.emit('roleError', 'Apenas o espião-mestre do time do turno pode dar dica.');
    }
    const n = Number(count);
    if (!clue || !Number.isInteger(n) || n < 1 || n > 9) {
      return socket.emit('roleError', 'Dica inválida. Informe a palavra e um número de 1 a 9.');
    }
    room.game.clue = { team: me.team, clue: String(clue).trim(), count: n };
    io.to(roomCode).emit('clueUpdate', room.game.clue);
  });

  socket.on('endTurn', (roomCode) => {
    const room = rooms[roomCode]; if (!room) return;
    room.game.currentTurn = room.game.currentTurn === 'blue' ? 'red' : 'blue';
    clearClue(roomCode);
    broadcastGame(roomCode);
    log(roomCode, `Vez passada para o time ${room.game.currentTurn === 'blue' ? 'AZUL' : 'VERMELHO'}.`);
  });

  // clique em carta (apenas agente do time do turno)
  socket.on('cardClicked', ({ roomCode, cardIndex }) => {
    const room = rooms[roomCode]; if (!room) return;
    const g = room.game; const c = g.gameData[cardIndex];
    if (!c || c.revealed || g.winner) return;

    const me = room.players.find(p => p.id === socket.id); if (!me) return;
    if (!(me.team === g.currentTurn && me.role === 'operative')) return;

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

    // troca de turno se neutra ou da cor errada
    if (c.role === 'neutral' || c.role !== g.currentTurn) {
      g.currentTurn = g.currentTurn === 'blue' ? 'red' : 'blue';
      clearClue(roomCode);
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
    io.to(roomCode).emit('gameRestarted');
    clearClue(roomCode);
    broadcastGame(roomCode);
    log(roomCode, `Partida reiniciada.`);
  });
});

server.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
