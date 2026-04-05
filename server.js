'use strict';

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CARD UTILITIES
// ============================================================
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankToValue(rank) {
  const idx = RANKS.indexOf(rank);
  return idx === -1 ? 14 : idx + 2; // 2-14, A=14
}

function handRank(hand) {
  // Returns { rank: 0-9 (higher better), value: tiebreaker value }
  const values = hand.map(c => rankToValue(c.rank)).sort((a, b) => a - b);
  const suits = hand.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(values);
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const sortedCounts = Object.values(counts).sort((a, b) => b - a);

  if (isFlush && isStraight && values[4] === 14) return { rank: 9, value: 14 }; // Royal Flush
  if (isFlush && isStraight) return { rank: 8, value: values[4] }; // Straight Flush
  if (sortedCounts[0] === 4) return { rank: 7, value: Object.keys(counts).find(k => counts[k] === 4) * 1 }; // Four of a Kind
  if (sortedCounts[0] === 3 && sortedCounts[1] === 2) return { rank: 6, value: Object.keys(counts).find(k => counts[k] === 3) * 1 }; // Full House
  if (isFlush) return { rank: 5, value: values[4] }; // Flush
  if (isStraight) return { rank: 4, value: values[4] }; // Straight
  if (sortedCounts[0] === 3) return { rank: 3, value: Object.keys(counts).find(k => counts[k] === 3) * 1 }; // Three of a Kind
  if (sortedCounts[0] === 2 && sortedCounts[1] === 2) {
    const pairs = Object.keys(counts).filter(k => counts[k] === 2).map(k => k * 1).sort((a, b) => b - a);
    return { rank: 2, value: pairs[0] * 1000 + pairs[1] }; // Two Pair
  }
  if (sortedCounts[0] === 2) return { rank: 1, value: Object.keys(counts).find(k => counts[k] === 2) * 1 }; // One Pair
  return { rank: 0, value: values[4] }; // High Card
}

function checkStraight(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length < 5) return false;
  // Wheel (A-2-3-4-5)
  if (sorted.join(',') === '2,3,4,5,14') return true;
  for (let i = 0; i <= sorted.length - 5; i++) {
    if (sorted[i + 4] - sorted[i] === 4) return true;
  }
  return false;
}

function compareHands(handA, handB) {
  const a = handRank(handA);
  const b = handRank(handB);
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.value - b.value;
}

function describeHand(hand) {
  const r = handRank(hand);
  const names = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'];
  return names[r.rank] || '未知';
}

function cardName(c) {
  return c ? `${c.rank}${c.suit}` : '?';
}

// ============================================================
// ROOM & PLAYER STATE
// ============================================================
const rooms = new Map();
const playerSockets = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function newPlayer(id, name, ws) {
  return {
    id,
    name,
    ws,
    hand: null,
    chips: 1000,
    score: 0,
    isFolded: false,
    isAllIn: false,
    isDealer: false,
    isSmallBlind: false,
    isBigBlind: false,
    currentBet: 0,
    lastAction: null,
  };
}

function newRoom(code, owner, bigBlind) {
  return {
    code,
    ownerId: owner.id,
    players: [owner],
    phase: 'waiting', // waiting | preflop | flop | turn | river | showdown | scoring
    communityCards: [],
    pot: 0,
    currentBet: 0,
    dealerIndex: 0,
    smallBlind: bigBlind / 2,
    bigBlind,
    maxPlayers: 10,
    deck: [],
    currentPlayerIndex: 0,
    phaseBets: 0,
    activePlayers: 0,
    roundNumber: 0,
    scores: {}, // cumulative scores
    chatHistory: [],
    winnerThisRound: null,
  };
}

// ============================================================
// GAME LOGIC
// ============================================================
function dealNewHand(room) {
  room.roundNumber++;
  room.deck = shuffleDeck(makeDeck());
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 0;
  room.phaseBets = 0;
  room.winnerThisRound = null;

  // Reset player states
  for (const p of room.players) {
    p.hand = null;
    p.isFolded = false;
    p.isAllIn = false;
    p.currentBet = 0;
    p.lastAction = null;
  }

  // Rotate dealer
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

  // Find active players
  room.activePlayers = room.players.filter(p => p.chips > 0 || p.isAllIn).length;
  if (room.activePlayers < 2) {
    broadcastRoom(room, { type: 'game_error', message: '需要至少2个有筹码的玩家' });
    return;
  }

  // Deal hole cards
  for (const p of room.players) {
    if (p.chips > 0) {
      p.hand = [room.deck.pop(), room.deck.pop()];
    }
  }

  // Set blinds
  const activePlayers = room.players.filter(p => !p.isFolded && !p.isAllIn && p.chips > 0);
  const dealerPlayer = room.players[room.dealerIndex];
  const sbPlayer = room.players[(room.dealerIndex + 1) % room.players.length];
  const bbPlayer = room.players[(room.dealerIndex + 2) % room.players.length];

  for (const p of room.players) {
    p.isDealer = p === dealerPlayer;
    p.isSmallBlind = p === sbPlayer;
    p.isBigBlind = p === bbPlayer;
  }

  room.phase = 'preflop';
  room.currentBet = room.bigBlind;
  room.phaseBets = 0;

  // Small blind bet
  const sbAmount = Math.min(room.smallBlind, sbPlayer.chips);
  if (sbAmount > 0) {
    sbPlayer.chips -= sbAmount;
    sbPlayer.currentBet = sbAmount;
    room.pot += sbAmount;
    room.phaseBets += sbAmount;
  }
  if (sbPlayer.chips === 0) sbPlayer.isAllIn = true;

  // Big blind bet
  const bbAmount = Math.min(room.bigBlind, bbPlayer.chips);
  if (bbAmount > 0) {
    bbPlayer.chips -= bbAmount;
    bbPlayer.currentBet = bbAmount;
    room.pot += bbAmount;
    room.phaseBets += bbAmount;
  }
  if (bbPlayer.chips === 0) bbPlayer.isAllIn = true;

  // Set current player (first to act after BB)
  room.currentPlayerIndex = room.players.findIndex(p => !p.isFolded && !p.isAllIn && p !== bbPlayer && p.chips > 0);

  broadcastRoomState(room);
}

function doAction(room, player, actionType, raiseAmount) {
  if (room.phase === 'waiting') return;
  if (room.phase === 'showdown') return;

  const toCall = room.currentBet - player.currentBet;

  switch (actionType) {
    case 'fold':
      player.isFolded = true;
      player.lastAction = 'fold';
      room.activePlayers--;
      break;

    case 'check':
      player.lastAction = 'check';
      break;

    case 'call':
      const callAmt = Math.min(toCall, player.chips);
      player.chips -= callAmt;
      player.currentBet += callAmt;
      room.pot += callAmt;
      room.phaseBets += callAmt;
      player.lastAction = `call ${callAmt}`;
      if (player.chips === 0) player.isAllIn = true;
      break;

    case 'raise':
      const totalBet = Math.min(raiseAmount, player.chips + player.currentBet);
      const raiseAmt = totalBet - player.currentBet;
      if (raiseAmt <= 0) { player.lastAction = 'check'; break; }
      player.chips -= raiseAmt;
      player.currentBet = totalBet;
      room.pot += raiseAmt;
      room.currentBet = totalBet;
      room.phaseBets = raiseAmt;
      player.lastAction = `raise ${raiseAmt}`;
      if (player.chips === 0) player.isAllIn = true;
      break;

    case 'allin':
      const allInAmt = player.chips;
      const newTotal = player.currentBet + allInAmt;
      if (newTotal > room.currentBet) {
        room.currentBet = newTotal;
        room.phaseBets = newTotal - room.currentBet;
      }
      player.chips = 0;
      player.currentBet = newTotal;
      player.isAllIn = true;
      player.lastAction = `allin ${allInAmt}`;
      room.pot += allInAmt;
      break;

    case 'bet':
      // Same as raise for simplicity
      const betAmt = Math.min(raiseAmount || room.bigBlind, player.chips);
      player.chips -= betAmt;
      player.currentBet += betAmt;
      room.pot += betAmt;
      room.currentBet = player.currentBet;
      room.phaseBets = betAmt;
      player.lastAction = `bet ${betAmt}`;
      if (player.chips === 0) player.isAllIn = true;
      break;
  }

  advanceTurn(room);
}

function advanceTurn(room) {
  // Check if betting round is complete
  const activePlayers = room.players.filter(p => !p.isFolded && !p.isAllIn && p.chips > 0);
  const playersWithChips = room.players.filter(p => !p.isFolded && p.chips > 0 && !p.isAllIn);

  // If only one player left with chips, they win
  if (playersWithChips.length <= 1) {
    if (playersWithChips.length === 1) {
      endHand(room, [playersWithChips[0].id]);
    } else if (activePlayers.length === 1) {
      const winner = room.players.find(p => !p.isFolded && !p.isAllIn);
      if (winner) endHand(room, [winner.id]);
      else {
        // Everyone is all-in or folded - find last active player
        const lastActive = room.players.find(p => !p.isFolded);
        if (lastActive) endHand(room, [lastActive.id]);
      }
    }
    return;
  }

  // Check if betting round is complete (everyone matched bet or folded)
  const allActed = activePlayers.every(p => {
    return p.currentBet === room.currentBet || p.isAllIn || p.isFolded;
  });

  // Special case: everyone who can act has acted
  const remainingActors = activePlayers.filter(p => p.currentBet < room.currentBet && !p.isAllIn);

  if (allActed || remainingActors.length === 0) {
    nextPhase(room);
    return;
  }

  // Move to next player
  let attempts = 0;
  do {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    attempts++;
  } while (
    attempts < room.players.length &&
    (room.players[room.currentPlayerIndex].isFolded ||
     room.players[room.currentPlayerIndex].isAllIn ||
     room.players[room.currentPlayerIndex].chips === 0 ||
     room.players[room.currentPlayerIndex].currentBet === room.currentBet)
  );

  broadcastRoomState(room);
}

function nextPhase(room) {
  // Reset bets for new phase
  for (const p of room.players) p.currentBet = 0;
  room.currentBet = 0;

  switch (room.phase) {
    case 'preflop':
      room.phase = 'flop';
      room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
      break;
    case 'flop':
      room.phase = 'turn';
      room.communityCards.push(room.deck.pop());
      break;
    case 'turn':
      room.phase = 'river';
      room.communityCards.push(room.deck.pop());
      break;
    case 'river':
      room.phase = 'showdown';
      showdown(room);
      return;
    default:
      return;
  }

  // Set first active player after dealer (or first active player for subsequent rounds)
  const startIdx = (room.dealerIndex + 1) % room.players.length;
  let idx = startIdx;
  let attempts = 0;
  do {
    idx = (idx + 1) % room.players.length;
    attempts++;
  } while (attempts < room.players.length && (room.players[idx].isFolded || room.players[idx].isAllIn || room.players[idx].chips === 0));

  room.currentPlayerIndex = idx;
  broadcastRoomState(room);
}

function showdown(room) {
  const activePlayers = room.players.filter(p => !p.isFolded);
  if (activePlayers.length === 1) {
    endHand(room, [activePlayers[0].id]);
    return;
  }

  // Evaluate hands
  let bestHand = null;
  let winners = [];

  for (const p of activePlayers) {
    const fullHand = [...p.hand, ...room.communityCards];
    const comparison = compareHands(bestHand ? [...bestHand, ...room.communityCards] : null, fullHand);

    // Actually we need to compare full 5-card hands
    const best5 = findBest5CardHand(fullHand);
    const r = handRank(best5);

    if (!bestHand) {
      bestHand = best5;
      winners = [p.id];
    } else {
      const best5Prev = findBest5CardHand([...bestHand, ...room.communityCards]);
      const cmp = compareHands(best5, best5Prev);
      if (cmp > 0) {
        bestHand = best5;
        winners = [p.id];
      } else if (cmp === 0) {
        winners.push(p.id);
      }
    }
  }

  endHand(room, winners);
}

function findBest5CardHand(cards) {
  if (cards.length < 5) return cards;
  let best = null;
  for (let i = 0; i < cards.length - 4; i++) {
    for (let j = i + 1; j < cards.length - 3; j++) {
      for (let k = j + 1; k < cards.length - 2; k++) {
        for (let l = k + 1; l < cards.length - 1; l++) {
          for (let m = l + 1; m < cards.length; m++) {
            const hand = [cards[i], cards[j], cards[k], cards[l], cards[m]];
            if (!best || compareHands(hand, best) > 0) {
              best = hand;
            }
          }
        }
      }
    }
  }
  return best || cards.slice(0, 5);
}

function endHand(room, winnerIds) {
  room.phase = 'scoring';
  const winAmount = room.pot;
  const perWinner = Math.floor(winAmount / winnerIds.length);

  for (const id of winnerIds) {
    const p = room.players.find(pl => pl.id === id);
    if (p) {
      p.chips += perWinner;
      p.score += perWinner;
      if (!room.scores[p.id]) room.scores[p.id] = 0;
      room.scores[p.id] += perWinner;
    }
  }

  room.winnerThisRound = winnerIds;

  // Broadcast result
  const winnerPlayers = room.players.filter(p => winnerIds.includes(p.id));
  const winnerNames = winnerPlayers.map(p => p.name).join(', ');
  const winningHand = winnerPlayers[0]?.hand ? describeHand(winnerPlayers[0].hand) : 'N/A';

  broadcastRoom(room, {
    type: 'hand_result',
    winners: winnerIds.map(id => {
      const p = room.players.find(pl => pl.id === id);
      return { id, name: p?.name, hand: p?.hand?.map(cardName), handType: winningHand };
    }),
    prize: perWinner,
    pot: room.pot,
    communityCards: room.communityCards.map(cardName),
    scores: getScoreboard(room),
  });

  // Auto start next hand after delay if still in playing state
  room.phase = 'waiting';
  for (const p of room.players) p.currentBet = 0;

  // Check if all players can still play
  const canPlay = room.players.filter(p => p.chips > 0);
  if (canPlay.length < 2) {
    // Game over - announce final scores
    broadcastRoom(room, {
      type: 'game_over',
      winner: canPlay[0]?.name || 'N/A',
      finalScores: getScoreboard(room),
    });
    return;
  }

  // Auto start next round after 4 seconds
  setTimeout(() => {
    if (rooms.has(room.code)) {
      dealNewHand(room);
    }
  }, 4000);
}

function getScoreboard(room) {
  return room.players
    .map(p => ({
      name: p.name,
      id: p.id,
      chips: p.chips,
      score: room.scores[p.id] || 0,
    }))
    .sort((a, b) => b.score - a.score);
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  }
}

function broadcastRoomState(room) {
  const activePlayers = room.players.filter(p => !p.isFolded && !p.isAllIn && p.chips > 0);
  const currentPlayer = room.players[room.currentPlayerIndex];
  const minRaise = room.currentBet === 0
    ? Math.max(room.bigBlind, activePlayers.length > 0 ? 20 : 0)
    : room.currentBet * 2;

  const state = {
    type: 'game_state',
    phase: room.phase,
    communityCards: room.communityCards.map(cardName),
    pot: room.pot,
    currentBet: room.currentBet,
    dealerIndex: room.dealerIndex,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      hand: p.hand ? p.hand.map(cardName) : null,
      isMyHand: p === room.players.find(pl => pl.ws.readyState === WebSocket.OPEN),
      chips: p.chips,
      score: room.scores[p.id] || 0,
      isFolded: p.isFolded,
      isAllIn: p.isAllIn,
      isDealer: p.isDealer,
      isSmallBlind: p.isSmallBlind,
      isBigBlind: p.isBigBlind,
      currentBet: p.currentBet,
      isCurrentTurn: p === currentPlayer,
      lastAction: p.lastAction,
    })),
    currentPlayerId: currentPlayer?.id || null,
    minRaise: minRaise,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    roundNumber: room.roundNumber,
    scores: getScoreboard(room),
  };

  broadcastRoom(room, state);
}

// ============================================================
// WEB SOCKET HANDLING
// ============================================================
wss.on('connection', (ws, req) => {
  const playerId = crypto.randomBytes(8).toString('hex');
  playerSockets.set(playerId, ws);
  ws.playerId = playerId;
  ws.roomCode = null;
  ws.playerName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const name = String(msg.playerName || 'Player').slice(0, 20);
        const bigBlind = Math.max(5, Math.min(1000, parseInt(msg.bigBlind) || 10));
        const maxPlayers = Math.max(2, Math.min(10, parseInt(msg.maxPlayers) || 10));

        const player = newPlayer(playerId, name, ws);
        const code = generateCode();
        const room = newRoom(code, player, bigBlind);
        room.maxPlayers = maxPlayers;
        rooms.set(code, room);
        ws.roomCode = code;

        ws.send(JSON.stringify({
          type: 'room_created',
          roomCode: code,
          playerId,
          player,
          room: {
            code,
            bigBlind,
            maxPlayers,
            phase: room.phase,
            players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, score: 0 })),
            scores: [],
          },
        }));
        break;
      }

      case 'join_room': {
        const code = String(msg.roomCode || '').toUpperCase().trim();
        const name = String(msg.playerName || 'Player').slice(0, 20);
        const room = rooms.get(code);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
          return;
        }
        if (room.phase !== 'waiting') {
          ws.send(JSON.stringify({ type: 'error', message: '游戏已开始，无法加入' }));
          return;
        }
        if (room.players.length >= room.maxPlayers) {
          ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
          return;
        }

        const player = newPlayer(playerId, name, ws);
        room.players.push(player);
        ws.roomCode = code;
        ws.playerName = name;

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomCode: code,
          playerId,
          player,
          room: {
            code,
            bigBlind: room.bigBlind,
            maxPlayers: room.maxPlayers,
            phase: room.phase,
            players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, score: room.scores[p.id] || 0 })),
            scores: getScoreboard(room),
          },
        }));

        // Notify all other players
        broadcastRoom(room, {
          type: 'player_joined',
          player: { id: player.id, name: player.name, chips: player.chips },
          players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips })),
          scores: getScoreboard(room),
        });
        break;
      }

      case 'start_game': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        if (room.ownerId !== playerId) {
          ws.send(JSON.stringify({ type: 'error', message: '只有房主可以开始游戏' }));
          return;
        }
        if (room.players.length < 2) {
          ws.send(JSON.stringify({ type: 'error', message: '至少需要2名玩家才能开始' }));
          return;
        }
        if (room.phase !== 'waiting') return;
        dealNewHand(room);
        break;
      }

      case 'action': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        if (room.phase === 'waiting' || room.phase === 'showdown' || room.phase === 'scoring') return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        if (room.players[room.currentPlayerIndex] !== player) {
          ws.send(JSON.stringify({ type: 'error', message: '还没轮到你' }));
          return;
        }
        if (player.isFolded || player.isAllIn) return;

        doAction(room, player, msg.action, parseInt(msg.amount) || 0);
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        const text = String(msg.message || '').slice(0, 200).replace(/[<>]/g, '');
        const chatEntry = { from: player.name, message: text, time: Date.now() };
        room.chatHistory.push(chatEntry);
        if (room.chatHistory.length > 100) room.chatHistory.shift();
        broadcastRoom(room, { type: 'chat_message', from: player.name, message: text });
        break;
      }

      case 'leave_room': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        handlePlayerLeave(room, playerId, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (room) handlePlayerLeave(room, playerId, ws);
    playerSockets.delete(playerId);
  });

  ws.on('error', () => {
    const room = rooms.get(ws.roomCode);
    if (room) handlePlayerLeave(room, playerId, ws);
    playerSockets.delete(playerId);
  });
});

function handlePlayerLeave(room, playerId, ws) {
  ws.roomCode = null;
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;

  const wasOwner = room.ownerId === playerId;
  room.players.splice(idx, 1);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  // Transfer ownership
  if (wasOwner) room.ownerId = room.players[0].id;

  // If game in progress, fold the player
  if (room.phase !== 'waiting') {
    const p = room.players.find(pl => pl.id === playerId);
    if (p) p.isFolded = true;
  }

  broadcastRoom(room, {
    type: 'player_left',
    playerId,
    players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips })),
    newOwnerId: room.ownerId,
    scores: getScoreboard(room),
  });
}

// ============================================================
// HTTP ENDPOINTS
// ============================================================
app.get('/api/rooms', (req, res) => {
  const roomList = [];
  for (const [code, room] of rooms) {
    roomList.push({
      code,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      phase: room.phase,
      bigBlind: room.bigBlind,
    });
  }
  res.json({ rooms: roomList });
});

// ============================================================
// START
// ============================================================
server.listen(PORT, HOST, () => {
  console.log(`Poker server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/poker.html to play`);
});
