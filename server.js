const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: ['https://SEU-DOMINIO.com','https://www.SEU-DOMINIO.com'], // ajuste (ou remova) se precisar
    methods: ['GET','POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));

// ---------- util ----------
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
"CANTINATURAL","ANA CECILIA","SILVIA","RENATO FILO","TATI","RONALDO","D7","DECK","MASTERGOLD","CHANCELER"

  ].sort(() => Math.random() - 0.5).slice(0, 25);

  const roles = [];
  for (let i = 0; i < 9; i++) roles.push('blue');
  for (let i = 0; i < 8; i++) roles.push('red');
  for (let i = 0; i < 7; i++) roles.push('neutral');
  roles.push('assassin');

  const shuffledRoles = roles.sort(() => Math.random() - 0.5);
  return {
    gameData: words.map((w, i) => ({ word: w, role: shuffledRoles[i], revealed: false, clickedBy: null })),
    blueScore: 9,
    redScore: 8,
    currentTurn: 'blue',
    winner: null,
    clue: null // {team, clue, count, guessesLeft}
  };
}

// rooms[code] = { players:[{id,nickname,team,role,locked}], game:{...} }
const rooms = {};

function broadcastGame(code){ const r = rooms[code]; if (r) io.to(code).emit('gameData', r.game); }
function sendPlayers(code){
  const r = rooms[code]; if (!r) return;
  io.to(code).emit('playersUpdate', r.players.map(p => ({ id:p.id, nickname:p.nickname, team:p.team, role:p.role })));
}
function log(code, text){ io.to(code).emit('gameEvent', { text, at: Date.now() }); }
function clearClue(code){ const r = rooms[code]; if (!r) return; r.game.clue = null; io.to(code).emit('clueCleared'); }
function endGame(code, winner){ const r = rooms[code]; if (!r) return; r.game.winner = winner; clearClue(code); io.to(code).emit('gameOver',{winner}); log(code, `Fim de jogo — ${winner==='blue'?'AZUL':'VERMELHO'} venceu.`); }
function swapTurn(code){ const g = rooms[code].game; g.currentTurn = g.currentTurn==='blue'?'red':'blue'; clearClue(code); broadcastGame(code); log(code, `Vez do time ${g.currentTurn==='blue'?'AZUL':'VERMELHO'}.`); }

io.on('connection', (socket) => {
  socket.on('createRoom', (nickname) => {
    const code = generateRoomCode();
    rooms[code] = { players:[{ id:socket.id, nickname, team:null, role:null, locked:false }], game:createGameBoard() };
    socket.join(code);
    socket.emit('roomCreated', code);
    broadcastGame(code); sendPlayers(code);
    log(code, `${nickname} criou a sala ${code}.`);
  });

  socket.on('joinRoom', ({ roomCode, nickname }) => {
    const r = rooms[roomCode]; if (!r) return socket.emit('joinError','Código de sala inválido.');
    r.players.push({ id:socket.id, nickname, team:null, role:null, locked:false });
    socket.join(roomCode);
    socket.emit('roomJoined', roomCode);
    broadcastGame(roomCode); sendPlayers(roomCode);
    log(roomCode, `${nickname} entrou na sala.`);
  });

  // Seleção de papel: TRAVADA após a primeira escolha
  socket.on('selectRole', ({ roomCode, team, role }) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id===socket.id); if (!me) return;

    if (me.locked) return socket.emit('roleError','Seu time e função estão travados nesta partida.');

    if (!['blue','red'].includes(team) || !['spymaster','operative'].includes(role))
      return socket.emit('roleError','Time ou função inválidos.');

    if (role==='spymaster') {
      const taken = r.players.find(p => p.id!==socket.id && p.team===team && p.role==='spymaster');
      if (taken) return socket.emit('roleError',`Já existe um espião-mestre no time ${team==='blue'?'AZUL':'VERMELHO'}.`);
    }

    me.team = team; me.role = role; me.locked = true; // trava
    sendPlayers(roomCode);
    log(roomCode, `${me.nickname} virou ${role==='spymaster'?'espião-mestre':'agente de campo'} do time ${team==='blue'?'AZUL':'VERMELHO'}.`);
  });

  // Dica: só 1 ativa por turno; não pode mudar depois
  socket.on('sendClue', ({ roomCode, clue, count }) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id===socket.id); if (!me) return;
    const g = r.game;

    if (g.clue) return socket.emit('roleError','Já existe uma dica ativa. Aguarde o fim do turno.');
    if (!(me.role==='spymaster' && me.team===g.currentTurn))
      return socket.emit('roleError','Apenas o espião-mestre do time do turno pode dar dica.');

    const n = Number(count);
    if (!clue || !Number.isInteger(n) || n<1 || n>9) return socket.emit('roleError','Informe uma dica válida com número entre 1 e 9.');

    g.clue = { team: me.team, clue: String(clue).trim(), count: n, guessesLeft: n };
    io.to(roomCode).emit('clueUpdate', g.clue);
  });

  // Parar de adivinhar
  socket.on('endTurn', (roomCode) => {
    const r = rooms[roomCode]; if (!r) return;
    const me = r.players.find(p => p.id===socket.id); if (!me) return;
    const g = r.game;
    if (!(me.team===g.currentTurn && (me.role==='operative' || me.role==='spymaster'))) return;
    swapTurn(roomCode);
  });

  // Clique em carta (consome 1 palpite, aplica clickedBy para estilizar)
  socket.on('cardClicked', ({ roomCode, cardIndex }) => {
    const r = rooms[roomCode]; if (!r) return;
    const g = r.game; const c = g.gameData[cardIndex]; if (!c || c.revealed || g.winner) return;

    const me = r.players.find(p => p.id===socket.id); if (!me) return;
    if (!(g.clue && g.clue.guessesLeft>0 && me.team===g.currentTurn && me.role==='operative')) return;

    c.revealed = true;
    c.clickedBy = me.team; // <<< para o traçado colorido no cliente

    if (c.role === 'assassin') {
      const loser = g.currentTurn; const winner = loser==='blue'?'red':'blue';
      endGame(roomCode, winner); return;
    }

    if (c.role === 'blue') { g.blueScore--; if (g.blueScore===0) { endGame(roomCode,'blue'); return; } }
    else if (c.role === 'red') { g.redScore--; if (g.redScore===0) { endGame(roomCode,'red'); return; } }

    // consome 1 palpite sempre
    g.clue.guessesLeft = Math.max(0, g.clue.guessesLeft - 1);
    io.to(roomCode).emit('clueUpdate', g.clue);

    // troca se neutra ou cor errada, ou se acabou palpites
    if (c.role === 'neutral' || c.role !== g.currentTurn || g.clue.guessesLeft===0) { swapTurn(roomCode); return; }

    broadcastGame(roomCode);
  });

  socket.on('requestRestart', (roomCode) => {
    const r = rooms[roomCode]; if (!r) return;
    r.game = createGameBoard();
    r.players.forEach(p => { p.team=null; p.role=null; p.locked=false; });
    io.to(roomCode).emit('gameRestarted');
    clearClue(roomCode); broadcastGame(roomCode); sendPlayers(roomCode);
    log(roomCode,'Partida reiniciada.');
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const r = rooms[code];
      const i = r.players.findIndex(p => p.id===socket.id);
      if (i!==-1) {
        const [out] = r.players.splice(i,1);
        sendPlayers(code); log(code, `${out.nickname||'Jogador'} saiu da sala.`);
        if (r.players.length===0) delete rooms[code];
      }
    }
  });
});

server.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));


