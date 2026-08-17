// 博弈小屋 GameHub · Host 半（引擎/大厅/匹配/HTTP API/模型工具）
// 来源：动态插件 game-7/pkg-11。此文件与 gamehub.client.js 配套使用。
// 安装方式见 README.md —— 在 DSH 会话中让助手读取这两个文件并用 cordis_define 创建动态插件。
return {
  inject: ['timer'],
  apply(ctx) {
    const timer = ctx.timer
    const fs = ctx.get('fs')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const webServer = ctx.get('webServer')

    // ---------- shared lobby persistence (cross-session matchmaking) ----------
    const LOBBY_NAME = 'dsh-gamehub-lobby.json'
    let lobbyPath = null
    let memoryLobby = null

    async function resolveLobbyPath() {
      if (lobbyPath) return lobbyPath
      const candidates = []
      if (fs) {
        candidates.push('/tmp/' + LOBBY_NAME)
        if (sandboxPolicy) {
          try {
            const root = sandboxPolicy.workspaceRoot
            if (root) candidates.push(root + '/.dsh-gamehub/' + LOBBY_NAME)
          } catch (e) { /* ignore */ }
        }
        candidates.push('.dsh-gamehub-lobby.json')
      }
      for (const p of candidates) {
        try {
          const target = await fs.resolve(p)
          let existing = null
          try { existing = await fs.readText(target) } catch (e) { existing = null }
          await fs.writeText(target, existing === null ? '{}' : existing)
          lobbyPath = target
          return target
        } catch (e) {
          console.log('gamehub: lobby candidate failed ' + p + ': ' + (e && e.message))
        }
      }
      return null
    }

    function emptyLobby() { return { rev: 0, rooms: {}, players: {}, updatedAt: Date.now() } }

    async function readLobby() {
      if (!lobbyPath && !memoryLobby) {
        const p = await resolveLobbyPath()
        if (p === null) memoryLobby = emptyLobby()
      }
      if (memoryLobby) return memoryLobby
      try {
        const text = await fs.readText(lobbyPath)
        const data = JSON.parse(text || '{}')
        if (!data.rooms) data.rooms = {}
        if (!data.players) data.players = {}
        if (!data.rev) data.rev = 0
        pruneRooms(data)
        return data
      } catch (e) {
        return emptyLobby()
      }
    }

    async function writeLobby(lobby) {
      lobby.updatedAt = Date.now()
      if (memoryLobby) { memoryLobby = lobby; return }
      await fs.writeText(lobbyPath, JSON.stringify(lobby))
    }

    async function mutateLobby(fn, attempts) {
      const max = attempts || 4
      for (let i = 0; i < max; i++) {
        const lobby = await readLobby()
        const rev = lobby.rev + 1
        lobby.rev = rev
        const result = fn(lobby)
        await writeLobby(lobby)
        const check = await readLobby()
        if (check.rev === rev) return result
      }
      return null
    }

    function pruneRooms(lobby) {
      const now = Date.now()
      for (const code of Object.keys(lobby.rooms)) {
        const r = lobby.rooms[code]
        if (now - (r.updatedAt || 0) > 45 * 60 * 1000) delete lobby.rooms[code]
      }
    }

    function getPlayer(lobby, playerId) {
      return lobby.players[playerId] || { name: '玩家' + String(playerId).slice(-4) }
    }

    // ---------- games registry (博弈游戏待定 → 可扩展) ----------
    const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    function genCode(lobby) {
      for (let i = 0; i < 60; i++) {
        let code = ''
        for (let j = 0; j < 4; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
        if (!lobby.rooms[code]) return code
      }
      return 'A' + Date.now().toString(36).toUpperCase().slice(-3)
    }

    const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
    function tttCheckWin(board) {
      for (const l of TTT_LINES) {
        const a = l[0], b = l[1], c = l[2]
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]
      }
      return null
    }

    // ---------- 共鱼 · 鱼塘博弈 (来自原型 共鱼.html) ----------
    const GONGYU_CFG = { startFish: 12, cap: 20, rounds: 6, minTake: 1, maxTake: 3, cost: 1, dock: 3 }
    const GONGYU_BOTS = [
      { name: '😇 老好人', type: 'nice' },
      { name: '🦈 贪婪鬼', type: 'greedy' },
      { name: '🐙 记仇鬼', type: 'grudge' }
    ]
    const GONGYU_EMOJI = ['🐠', '🐟', '🦐', '🐡']
    function gongyuInitState() {
      return {
        round: 1, pond: GONGYU_CFG.startFish, collapsed: false, phase: 'catch',
        moves: {}, punishes: [], punishOrder: 0,
        catchTotal: {}, spent: {}, docked: {}, punishTotal: {}, lastCatch: {},
        history: []
      }
    }
    function gongyuBotTake(state, players, idx) {
      const last = state.history[state.history.length - 1]
      const greedyCount = last ? last.catches.filter(function (c) { return c === 3 }).length : 0
      switch (players[idx].botType) {
        case 'nice': return state.pond >= 16 ? 2 : 1
        case 'greedy': return state.pond < 3 ? 1 : 3
        case 'grudge': return state.pond < 6 ? 1 : (greedyCount >= 1 ? 2 : 1)
        default: return 1 + Math.floor(Math.random() * 3)
      }
    }
    function gongyuBotPunish(players, idx, ctx) {
      switch (players[idx].botType) {
        case 'nice': return null
        case 'greedy': return ctx.dockers.length ? ctx.dockers[0] : null
        case 'grudge': return ctx.greedy.length ? ctx.greedy[0] : (ctx.dockers.length ? ctx.dockers[0] : null)
        default: return Math.random() < 0.25 ? ctx.others[Math.floor(Math.random() * ctx.others.length)] : null
      }
    }
    function gongyuPunishCtx(room, idx) {
      const s = room.state
      const cur = s.history[s.history.length - 1]
      const dockers = cur ? cur.punishes.filter(function (x) { return x.to === idx }).map(function (x) { return x.from }) : []
      const greedy = room.players.map(function (q, i) { return i }).filter(function (i) { return i !== idx && room.players[i].lastCatch === 3 })
      const others = room.players.map(function (_, i) { return i }).filter(function (i) { return i !== idx })
      return { dockers: dockers, greedy: greedy, others: others }
    }
    function gongyuFinals(room) {
      const s = room.state
      const n = room.players.length
      const share = s.collapsed ? 0 : Math.round(s.pond / n * 10) / 10
      const finals = {}
      room.players.forEach(function (p) {
        let f = s.collapsed ? Math.floor((s.catchTotal[p.id] || 0) / 2) : (s.catchTotal[p.id] || 0) + share
        f -= (s.spent[p.id] || 0) + 3 * (s.docked[p.id] || 0)
        finals[p.id] = Math.round(f * 10) / 10
      })
      return finals
    }
    function gongyuWinner(room) {
      const finals = gongyuFinals(room)
      let best = null, bestScore = -Infinity, tie = false
      room.players.forEach(function (p) {
        const f = finals[p.id]
        if (f > bestScore) { bestScore = f; best = p.id; tie = false }
        else if (f === bestScore) tie = true
      })
      return tie ? null : best
    }
    function resolveGongyuCatch(room) {
      const s = room.state
      const ids = room.players.map(function (p) { return p.id })
      const catches = ids.map(function (id) { return s.moves[id] || 0 })
      const total = catches.reduce(function (a, b) { return a + b }, 0)
      const after = s.pond - total
      room.players.forEach(function (p, i) {
        s.lastCatch[p.id] = catches[i]
        s.catchTotal[p.id] = (s.catchTotal[p.id] || 0) + catches[i]
      })
      s.history.push({ round: s.round, catches: catches, punishes: [], total: total, after: after })
      s.moves = {}
      if (after <= 0) {
        s.collapsed = true
        s.phase = 'done'
        finish(room, gongyuWinner(room))
        return
      }
      s.pond = Math.min(after * 2, GONGYU_CFG.cap)
      s.phase = 'punish'
      s.punishOrder = 0
    }
    function nextGongyuRound(room) {
      const s = room.state
      s.round += 1
      if (s.round > GONGYU_CFG.rounds) {
        s.phase = 'done'
        finish(room, gongyuWinner(room))
        return
      }
      s.phase = 'catch'
      s.moves = {}
    }
    function applyGongyuMove(room, playerId, move) {
      const s = room.state
      if (s.phase === 'catch') {
        const n = Number(move)
        if (n !== 1 && n !== 2 && n !== 3) return { ok: false, error: '只能捞 1~3 条' }
        if (s.moves[playerId] !== undefined) return { ok: false, error: '本回合已下网' }
        s.moves[playerId] = n
        if (room.players.every(function (q) { return s.moves[q.id] !== undefined })) resolveGongyuCatch(room)
        return { ok: true }
      }
      if (s.phase === 'punish') {
        const cur = room.players[s.punishOrder]
        if (!cur || cur.id !== playerId) return { ok: false, error: '还没轮到你决策' }
        if (move === 'skip') {
          s.punishOrder += 1
          if (s.punishOrder >= room.players.length) nextGongyuRound(room)
          return { ok: true }
        }
        const target = room.players.find(function (q) { return q.id === move })
        if (!target) return { ok: false, error: '无效目标' }
        s.punishes.push({ from: playerId, to: move })
        s.spent[playerId] = (s.spent[playerId] || 0) + GONGYU_CFG.cost
        s.docked[move] = (s.docked[move] || 0) + GONGYU_CFG.dock
        s.punishTotal[playerId] = (s.punishTotal[playerId] || 0) + 1
        const h = s.history[s.history.length - 1]
        if (h) h.punishes.push({ from: playerId, to: move })
        s.punishOrder += 1
        if (s.punishOrder >= room.players.length) nextGongyuRound(room)
        return { ok: true }
      }
      return { ok: false, error: '对局已结束' }
    }
    function scheduleGongyuBots(room) {
      const code = room.code
      timer.timeout(function () {
        mutateLobby(function (lobby) {
          const r = lobby.rooms[code]
          if (!r || r.status !== 'playing') return
          const s = r.state
          let changed = false
          if (s.phase === 'catch') {
            r.players.forEach(function (p, i) {
              if (p.isBot && s.moves[p.id] === undefined) {
                s.moves[p.id] = gongyuBotTake(s, r.players, i)
                changed = true
              }
            })
            if (changed && r.players.every(function (q) { return s.moves[q.id] !== undefined })) resolveGongyuCatch(r)
          } else if (s.phase === 'punish') {
            const cur = r.players[s.punishOrder]
            if (cur && cur.isBot) {
              const idx = s.punishOrder
              const ctx = gongyuPunishCtx(r, idx)
              const t = gongyuBotPunish(r.players, idx, ctx)
              if (t != null) {
                s.punishes.push({ from: cur.id, to: r.players[t].id })
                s.spent[cur.id] = (s.spent[cur.id] || 0) + GONGYU_CFG.cost
                s.docked[r.players[t].id] = (s.docked[r.players[t].id] || 0) + GONGYU_CFG.dock
                s.punishTotal[cur.id] = (s.punishTotal[cur.id] || 0) + 1
                const h = s.history[s.history.length - 1]
                if (h) h.punishes.push({ from: cur.id, to: r.players[t].id })
              }
              s.punishOrder += 1
              if (s.punishOrder >= r.players.length) nextGongyuRound(r)
              else if (r.status === 'playing' && s.phase === 'punish') scheduleGongyuBots(r)
            }
          }
          r.updatedAt = Date.now()
        })
      }, 900)
    }

    const GAMES = {
      rps: {
        id: 'rps', name: '石头剪刀布', icon: '✊✋✌️', desc: '经典博弈 · 三局两胜',
        maxPlayers: 2, kind: 'simultaneous', rounds: 3,
        initState: function () { return { round: 1, moves: {}, scores: {}, lastRound: null } },
        moveLabels: { rock: '✊ 石头', paper: '✋ 布', scissors: '✌️ 剪刀' },
        validMoves: ['rock', 'paper', 'scissors'],
        applyMove: function (room, playerId, move) {
          const s = room.state
          if (s.moves[playerId]) return { ok: false, error: '本回合已出招' }
          s.moves[playerId] = move
          const ids = room.players.map(function (p) { return p.id })
          if (ids.every(function (id) { return s.moves[id] })) {
            const a = s.moves[ids[0]], b = s.moves[ids[1]]
            const beat = { rock: 'scissors', scissors: 'paper', paper: 'rock' }
            let winner = null
            if (beat[a] === b) winner = ids[0]
            else if (beat[b] === a) winner = ids[1]
            s.lastRound = { a: a, b: b, winner: winner, round: s.round }
            if (winner) {
              s.scores[winner] = (s.scores[winner] || 0) + 1
              if (s.scores[winner] >= 2) return finish(room, winner)
            }
            if (s.round >= 3) {
              const s0 = s.scores[ids[0]] || 0, s1 = s.scores[ids[1]] || 0
              if (s0 === s1) return finish(room, null)
              return finish(room, s0 > s1 ? ids[0] : ids[1])
            }
            s.round += 1
            s.moves = {}
          }
          return { ok: true }
        },
        botMove: function (state, botId, oppId, ids) {
          const opts = ['rock', 'paper', 'scissors']
          return opts[Math.floor(Math.random() * 3)]
        }
      },
      pd: {
        id: 'pd', name: '囚徒困境', icon: '⛓️', desc: '合作 or 背叛 · 累计得分',
        maxPlayers: 2, kind: 'simultaneous', rounds: 5,
        initState: function () { return { round: 1, moves: {}, scores: {}, history: [] } },
        moveLabels: { cooperate: '🤝 合作', defect: '🗡️ 背叛' },
        validMoves: ['cooperate', 'defect'],
        payoff: { cc: [3, 3], cd: [0, 5], dc: [5, 0], dd: [1, 1] },
        applyMove: function (room, playerId, move) {
          const s = room.state
          if (s.moves[playerId]) return { ok: false, error: '本回合已出招' }
          s.moves[playerId] = move
          const ids = room.players.map(function (p) { return p.id })
          if (ids.every(function (id) { return s.moves[id] })) {
            const a = s.moves[ids[0]], b = s.moves[ids[1]]
            const key = a[0] + b[0]
            const pay = this.payoff[key]
            s.scores[ids[0]] = (s.scores[ids[0]] || 0) + pay[0]
            s.scores[ids[1]] = (s.scores[ids[1]] || 0) + pay[1]
            s.history.push({ round: s.round, a: a, b: b, p1: pay[0], p2: pay[1] })
            if (s.round >= this.rounds) {
              const s0 = s.scores[ids[0]] || 0, s1 = s.scores[ids[1]] || 0
              if (s0 === s1) return finish(room, null)
              return finish(room, s0 > s1 ? ids[0] : ids[1])
            }
            s.round += 1
            s.moves = {}
          }
          return { ok: true }
        },
        botMove: function (state, botId, oppId, ids) {
          const last = state.history[state.history.length - 1]
          if (!last) return 'cooperate'
          return oppId === ids[0] ? last.a : last.b
        }
      },
      ttt: {
        id: 'ttt', name: '井字棋', icon: '⭕❌', desc: '轮流落子 · 三连即胜',
        maxPlayers: 2, kind: 'turn', rounds: 1,
        initState: function () { return { board: [null,null,null,null,null,null,null,null,null], turn: 0, moves: 0 } },
        moveLabels: {},
        validMoves: [],
        applyMove: function (room, playerId, move) {
          const s = room.state
          const idx = room.players.findIndex(function (p) { return p.id === playerId })
          if (idx !== s.turn) return { ok: false, error: '还没轮到你' }
          const cell = Number(move)
          if (!Number.isInteger(cell) || cell < 0 || cell > 8 || s.board[cell] !== null) return { ok: false, error: '无效落子' }
          s.board[cell] = idx === 0 ? 'X' : 'O'
          s.moves += 1
          const win = tttCheckWin(s.board)
          if (win || s.moves === 9) {
            let winner = null
            if (win === 'X') winner = room.players[0].id
            else if (win === 'O') winner = room.players[1].id
            return finish(room, winner)
          }
          s.turn = 1 - s.turn
          return { ok: true }
        },
        botMove: function (state, room) {
          const botIdx = room.players.findIndex(function (p) { return p.isBot })
          const mark = botIdx === 0 ? 'X' : 'O'
          const opp = mark === 'X' ? 'O' : 'X'
          const board = state.board
          const lines = TTT_LINES
          for (const l of lines) {
            const mine = l.filter(function (i) { return board[i] === mark })
            const empty = l.filter(function (i) { return board[i] === null })
            if (mine.length === 2 && empty.length === 1) return empty[0]
          }
          for (const l of lines) {
            const theirs = l.filter(function (i) { return board[i] === opp })
            const empty = l.filter(function (i) { return board[i] === null })
            if (theirs.length === 2 && empty.length === 1) return empty[0]
          }
          if (board[4] === null) return 4
          const corners = [0, 2, 6, 8].filter(function (i) { return board[i] === null })
          if (corners.length) return corners[Math.floor(Math.random() * corners.length)]
          const rest = board.map(function (v, i) { return v === null ? i : -1 }).filter(function (i) { return i >= 0 })
          return rest[Math.floor(Math.random() * rest.length)]
        }
      },
      gongyu: {
        id: 'gongyu', name: '共鱼', icon: '🐟', desc: '鱼塘博弈 · 4人同塘',
        maxPlayers: 4, kind: 'gongyu', rounds: GONGYU_CFG.rounds,
        initState: gongyuInitState,
        moveLabels: {},
        validMoves: [],
        applyMove: applyGongyuMove
      }
    }

    function finish(room, winner) {
      room.status = 'finished'
      room.winner = winner
      return { ok: true, finished: true }
    }

    // ---------- lobby operations ----------
    function createRoom(lobby, gameId, host, withBot) {
      const game = GAMES[gameId]
      if (!game) return { error: '未知游戏: ' + gameId }
      const code = genCode(lobby)
      const players = [{ id: host.id, name: host.name, isBot: false }]
      if (withBot) {
        if (game.id === 'gongyu') {
          GONGYU_BOTS.forEach(function (b, k) {
            players.push({ id: 'bot-' + code + '-' + k, name: b.name, isBot: true, botType: b.type })
          })
        } else {
          players.push({ id: 'bot-' + code, name: 'AI·小智', isBot: true })
        }
      }
      const room = {
        code: code, game: gameId, status: withBot ? 'playing' : 'waiting',
        players: players, hostId: host.id, state: game.initState(),
        winner: null, createdAt: Date.now(), updatedAt: Date.now()
      }
      lobby.rooms[code] = room
      return { room: room }
    }

    function joinRoom(lobby, code, player) {
      const room = lobby.rooms[code]
      if (!room) return { error: '房间不存在或已过期' }
      const game = GAMES[room.game]
      if (room.status === 'finished') return { error: '对局已结束' }
      if (room.players.some(function (p) { return p.id === player.id })) return { room: room, you: player.id }
      if (room.players.length >= game.maxPlayers) return { error: '房间已满' }
      room.players.push({ id: player.id, name: player.name, isBot: false })
      if (room.players.length >= game.maxPlayers) room.status = 'playing'
      room.updatedAt = Date.now()
      return { room: room, you: player.id }
    }

    function quickMatch(lobby, gameId, player) {
      for (const code of Object.keys(lobby.rooms)) {
        const r = lobby.rooms[code]
        if (r.game === gameId && r.status === 'waiting' && !r.players.some(function (p) { return p.id === player.id })) {
          return joinRoom(lobby, code, player)
        }
      }
      return createRoom(lobby, gameId, player, false)
    }

    function roomView(room, viewerId) {
      const game = GAMES[room.game]
      const state = room.state
      const v = {
        code: room.code, game: room.game, gameName: game.name, gameIcon: game.icon,
        kind: game.kind, status: room.status, winner: room.winner || null,
        players: room.players.map(function (p, i) { return { id: p.id, name: p.name, isBot: !!p.isBot, emoji: game.id === 'gongyu' ? GONGYU_EMOJI[i % 4] : '' } }),
        scores: Object.assign({}, state.scores || {}),
        round: state.round || 1, rounds: game.rounds || 1,
        you: viewerId || null,
        history: (state.history || []).slice(-12),
        lastRound: state.lastRound || null,
        moveLabels: game.moveLabels,
        turn: state.turn !== undefined ? state.turn : null,
        board: state.board ? state.board.slice() : null,
        myMove: state.moves ? (state.moves[viewerId] || null) : null,
        oppMoved: state.moves ? room.players.some(function (p) { return p.id !== viewerId && !!state.moves[p.id] }) : false,
        bothMoved: state.moves ? room.players.every(function (p) { return !!state.moves[p.id] }) : false
      }
      if (game.id === 'gongyu') {
        v.phase = state.phase
        v.pond = state.pond
        v.collapsed = !!state.collapsed
        v.myCatch = state.moves ? (state.moves[viewerId] || null) : null
        v.catchDone = state.moves ? room.players.every(function (p) { return state.moves[p.id] !== undefined }) : false
        const cur = state.punishOrder !== undefined ? room.players[state.punishOrder] : null
        v.punishTurn = cur ? cur.id : null
        v.punishTurnName = cur ? cur.name : ''
        v.punishOptions = []
        if (state.phase === 'punish' && viewerId && cur && cur.id === viewerId) {
          room.players.forEach(function (p, i) {
            if (p.id !== viewerId) v.punishOptions.push({ id: p.id, name: p.name, emoji: GONGYU_EMOJI[i % 4] })
          })
        }
        v.finals = state.phase === 'done' ? gongyuFinals(room) : null
        const curScore = {}
        room.players.forEach(function (p) {
          curScore[p.id] = (state.catchTotal[p.id] || 0) - (state.spent[p.id] || 0) - 3 * (state.docked[p.id] || 0)
        })
        v.scores = curScore
      }
      return v
    }

    let roomApiPath = '/api/gamehub/room'
    function sharePayload(room) {
      const game = GAMES[room.game]
      let link = ''
      try {
        if (webServer && webServer.port) link = 'http://127.0.0.1:' + webServer.port + roomApiPath + '?code=' + room.code
      } catch (e) { link = '' }
      const text = '🎮 博弈小屋 · 开局邀请\n游戏：' + game.name + ' ' + game.icon +
        '\n房间号：' + room.code +
        (link ? '\n链接：' + link : '') +
        '\n打开博弈小屋 → 输入房间号 ' + room.code + ' 即可加入'
      return { code: room.code, text: text, link: link }
    }

    function scheduleBot(room) {
      if (room.game === 'gongyu') { scheduleGongyuBots(room); return }
      const game = GAMES[room.game]
      const bot = room.players.find(function (p) { return p.isBot })
      if (!bot || room.status !== 'playing') return
      const code = room.code
      timer.timeout(function () {
        mutateLobby(function (lobby) {
          const r = lobby.rooms[code]
          if (!r || r.status !== 'playing') return
          const g = GAMES[r.game]
          const b = r.players.find(function (p) { return p.isBot })
          if (!b) return
          if (g.kind === 'simultaneous') {
            const human = r.players.find(function (p) { return !p.isBot })
            if (!human || r.state.moves[human.id] === undefined) return
            if (r.state.moves[b.id] !== undefined) return
            const ids = r.players.map(function (p) { return p.id })
            const move = g.botMove(r.state, b.id, human.id, ids)
            g.applyMove(r, b.id, move)
          } else {
            const bIdx = r.players.findIndex(function (p) { return p.isBot })
            if (r.state.turn !== bIdx) return
            const move = g.botMove(r.state, r)
            g.applyMove(r, b.id, String(move))
          }
          r.updatedAt = Date.now()
        })
      }, 900)
    }

    function applyPlayerMove(lobby, code, playerId, move) {
      const room = lobby.rooms[code]
      if (!room) return { error: '房间不存在或已过期' }
      const game = GAMES[room.game]
      if (room.status !== 'playing') return { error: '对局未开始' }
      const p = room.players.find(function (x) { return x.id === playerId })
      if (!p || p.isBot) return { error: '你不是本房间玩家' }
      if (game.id === 'gongyu') {
        const result = applyGongyuMove(room, playerId, move)
        if (!result.ok) return result
        room.updatedAt = Date.now()
        scheduleBot(room)
        return { ok: true, room: roomView(room, playerId) }
      }
      if (game.kind === 'simultaneous' && game.validMoves.indexOf(move) === -1) return { error: '无效出招' }
      const result = game.applyMove(room, playerId, move)
      if (!result.ok) return result
      room.updatedAt = Date.now()
      scheduleBot(room)
      return { ok: true, room: roomView(room, playerId) }
    }

    function leaveRoom(lobby, code, playerId) {
      const room = lobby.rooms[code]
      if (!room) return { ok: true }
      const idx = room.players.findIndex(function (p) { return p.id === playerId })
      if (idx >= 0) room.players.splice(idx, 1)
      if (room.players.length === 0) {
        delete lobby.rooms[code]
        return { ok: true }
      }
      if (room.status === 'playing') {
        room.status = 'finished'
        const left = room.players[0]
        room.winner = left && !left.isBot ? left.id : null
        room.updatedAt = Date.now()
        return { ok: true }
      }
      room.status = 'waiting'
      room.updatedAt = Date.now()
      return { ok: true }
    }

    function playerOf(args) {
      const pid = (args && args.playerId) || 'u-' + Math.random().toString(36).slice(2, 8)
      const nm = (args && args.name) || '玩家'
      return { id: String(pid).slice(0, 40), name: String(nm).slice(0, 16) }
    }

    // ---------- HTTP share API (联网匹配 / 任意形式分享) ----------
    if (webServer) {
      const respondJson = function (res, data, status) {
        res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(data))
      }
      const parseCode = function (req) {
        const raw = String(req.url || '')
        const qi = raw.indexOf('?')
        const qs = qi >= 0 ? raw.slice(qi + 1) : ''
        const parts = qs.split('&')
        for (const part of parts) {
          if (part.indexOf('code=') === 0) return part.slice(5).toUpperCase()
        }
        return ''
      }
      try {
        const exact = webServer.exact
        if (exact && typeof exact.delete === 'function') {
          exact.delete('/api/gamehub/lobby')
          exact.delete('/api/gamehub/room')
        }
      } catch (e) { /* ignore */ }
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/lobby',
        handler: async function (req, res) {
          const lobby = await readLobby()
          const rooms = Object.keys(lobby.rooms).map(function (code) {
            const r = lobby.rooms[code]
            return { code: r.code, game: r.game, gameName: GAMES[r.game].name, gameIcon: GAMES[r.game].icon, status: r.status, players: r.players.map(function (p) { return { name: p.name, isBot: !!p.isBot } }) }
          })
          respondJson(res, { ok: true, rooms: rooms })
        }
      }))
      try {
        ctx.effect(() => webServer.register({
          kind: 'exact',
          path: '/api/gamehub/room',
          handler: async function (req, res) {
            const code = parseCode(req)
            const lobby = await readLobby()
            const room = lobby.rooms[code]
            if (!room) return respondJson(res, { ok: false, error: '房间不存在' }, 404)
            respondJson(res, { ok: true, room: roomView(room, null), share: sharePayload(room) })
          }
        }))
      } catch (e) { /* 已注册 */ }
    }

    // ---------- Client RPC ----------
    harness.handle('identify', async function (args) {
      const sid = (args && args.sessionId) || null
      const playerId = sid ? 'u-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '').slice(-28) : 'u-' + Math.random().toString(36).slice(2, 10)
      let name = ''
      await mutateLobby(function (lobby) {
        const p = getPlayer(lobby, playerId)
        name = p.name
      })
      return { playerId: playerId, name: name }
    })

    harness.handle('set-name', async function (args) {
      const pid = args && args.playerId
      const nm = String((args && args.name) || '玩家').slice(0, 16)
      if (!pid) return { error: '缺少 playerId' }
      await mutateLobby(function (lobby) {
        lobby.players[pid] = { name: nm, updatedAt: Date.now() }
      })
      return { ok: true, name: nm }
    })

    harness.handle('games', async function () {
      return Object.keys(GAMES).map(function (id) {
        const g = GAMES[id]
        return { id: id, name: g.name, icon: g.icon, desc: g.desc, kind: g.kind, rounds: g.rounds, maxPlayers: g.maxPlayers, moveLabels: g.moveLabels }
      })
    })

    harness.handle('create', async function (args) {
      const player = playerOf(args)
      const withBot = !!(args && args.withBot)
      let out = null
      await mutateLobby(function (lobby) {
        lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
        out = createRoom(lobby, args && args.game, player, withBot)
        if (!out.error) out.room.updatedAt = Date.now()
      })
      if (out.error) return out
      return { code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) }
    })

    harness.handle('quick', async function (args) {
      const player = playerOf(args)
      let out = null
      await mutateLobby(function (lobby) {
        lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
        out = quickMatch(lobby, args && args.game, player)
      })
      if (out.error) return out
      return { code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) }
    })

    harness.handle('join', async function (args) {
      const player = playerOf(args)
      const code = String((args && args.code) || '').toUpperCase().trim()
      if (!code) return { error: '请输入房间号' }
      let out = null
      await mutateLobby(function (lobby) {
        lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
        out = joinRoom(lobby, code, player)
      })
      if (out.error) return out
      return { code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) }
    })

    harness.handle('list', async function () {
      const lobby = await readLobby()
      return Object.keys(lobby.rooms)
        .map(function (code) {
          const r = lobby.rooms[code]
          if (r.status !== 'waiting') return null
          return { code: r.code, game: r.game, gameName: GAMES[r.game].name, gameIcon: GAMES[r.game].icon, host: r.players[0] ? r.players[0].name : '', createdAt: r.createdAt }
        })
        .filter(function (x) { return x !== null })
        .sort(function (a, b) { return a.createdAt - b.createdAt })
    })

    harness.handle('state', async function (args) {
      const code = String((args && args.code) || '').toUpperCase().trim()
      if (!code) return null
      const lobby = await readLobby()
      const room = lobby.rooms[code]
      if (!room) return null
      return roomView(room, (args && args.playerId) || null)
    })

    harness.handle('move', async function (args) {
      const code = String((args && args.code) || '').toUpperCase().trim()
      let out = null
      await mutateLobby(function (lobby) {
        out = applyPlayerMove(lobby, code, args && args.playerId, args && args.move)
      })
      return out
    })

    harness.handle('leave', async function (args) {
      const code = String((args && args.code) || '').toUpperCase().trim()
      await mutateLobby(function (lobby) { leaveRoom(lobby, code, args && args.playerId) })
      return { ok: true }
    })

    harness.handle('share', async function (args) {
      const code = String((args && args.code) || '').toUpperCase().trim()
      const lobby = await readLobby()
      const room = lobby.rooms[code]
      if (!room) return { error: '房间不存在' }
      return sharePayload(room)
    })

    // ---------- model-visible tool: 通过对话创建/分享/对弈 ----------
    const agentId = 'agent-' + Math.random().toString(36).slice(2, 8)
    const gameTool = harness.defineTool({
      name: 'game_hub',
      description: '博弈小屋：创建博弈游戏房间、快速匹配、加入房间、查询房间状态、以 AI 身份落子。用于和用户或其他会话进行博弈游戏对局，房间号可分享给任何人加入。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'quick', 'join', 'list', 'state', 'move', 'share'], description: '操作：create 创建房间(可选 withBot)，quick 快速匹配，join 按房间号加入，list 列出所有房间，state 查看房间状态，move 落子，share 生成邀请文本' },
          game: { type: 'string', enum: ['rps', 'pd', 'ttt', 'gongyu'], description: '游戏：rps=石头剪刀布, pd=囚徒困境, ttt=井字棋, gongyu=共鱼(4人鱼塘博弈)' },
          code: { type: 'string', description: '房间号（join/state/move/share 需要）' },
          move: { type: 'string', description: '落子：rps=rock/paper/scissors，pd=cooperate/defect，ttt=0-8 格编号，gongyu 捕鱼阶段=1/2/3、惩罚阶段=skip 或目标玩家id' },
          withBot: { type: 'boolean', description: '创建房间时是否带 AI 陪练（共鱼会补 3 个 AI，默认 false）' },
          name: { type: 'string', description: '玩家昵称（默认 AI玩家）' }
        },
        required: ['action']
      },
      output: {
        schema: { type: 'json' },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
      },
      execute: async function (args) {
        const action = args && args.action
        const player = { id: agentId, name: (args && args.name) || 'AI玩家' }
        try {
          if (action === 'create' || action === 'quick') {
            let out = null
            await mutateLobby(function (lobby) {
              lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
              out = action === 'quick' ? quickMatch(lobby, args.game, player) : createRoom(lobby, args.game, player, !!(args && args.withBot))
            })
            if (!out || out.error) return { ok: false, error: (out && out.error) || '操作失败' }
            return { ok: true, code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) }
          }
          if (action === 'join') {
            let out = null
            await mutateLobby(function (lobby) {
              lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
              out = joinRoom(lobby, String((args && args.code) || '').toUpperCase(), player)
            })
            if (!out || out.error) return { ok: false, error: (out && out.error) || '加入失败' }
            return { ok: true, code: out.room.code, room: roomView(out.room, player.id) }
          }
          if (action === 'list') {
            const lobby = await readLobby()
            return { ok: true, rooms: Object.keys(lobby.rooms).map(function (code) {
              const r = lobby.rooms[code]
              return { code: r.code, game: r.game, gameName: GAMES[r.game].name, status: r.status, players: r.players.map(function (p) { return { name: p.name, isBot: !!p.isBot } }) }
            }) }
          }
          if (action === 'state') {
            const lobby = await readLobby()
            const room = lobby.rooms[String((args && args.code) || '').toUpperCase()]
            if (!room) return { ok: false, error: '房间不存在' }
            return { ok: true, room: roomView(room, player.id) }
          }
          if (action === 'move') {
            let out = null
            await mutateLobby(function (lobby) {
              out = applyPlayerMove(lobby, String((args && args.code) || '').toUpperCase(), player.id, args && args.move)
            })
            if (!out || out.error) return { ok: false, error: (out && out.error) || '落子失败' }
            return { ok: true, room: out.room }
          }
          if (action === 'share') {
            const lobby = await readLobby()
            const room = lobby.rooms[String((args && args.code) || '').toUpperCase()]
            if (!room) return { ok: false, error: '房间不存在' }
            return { ok: true, share: sharePayload(room) }
          }
          return { ok: false, error: '未知操作: ' + action }
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) }
        }
      }
    })
    harness.registerTool(ctx, gameTool)
  }
}
