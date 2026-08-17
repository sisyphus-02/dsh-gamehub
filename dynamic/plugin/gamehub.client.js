// 博弈小屋 GameHub · 动态插件 Client 半（v8：侧栏按钮 + 浮层面板 + 运行卡片 + 独立页面入口）
// 来源：game-7/pkg-15。此文件与 gamehub.host.js 配套，在 DSH 会话中用 cordis_define 创建动态插件。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    styles.insert(`
.gh-root{font-family:var(--font,inherit);color:var(--text,inherit);min-width:300px;max-width:520px}
.gh-header{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;padding:4px 2px}
.gh-sub{font-size:12px;opacity:.65;margin:2px 0 10px}
.gh-card{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:12px;margin:8px 0}
.gh-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gh-game{display:flex;flex-direction:column;gap:4px;padding:10px 12px;margin:8px 0;background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.22);border-radius:10px}
.gh-game-t{font-size:14px;font-weight:600}
.gh-game-d{font-size:12px;opacity:.7}
.gh-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.gh-btn{background:rgba(90,120,255,.18);border:1px solid rgba(120,150,255,.5);color:inherit;border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}
.gh-btn:hover{background:rgba(90,120,255,.32)}
.gh-btn:disabled{opacity:.45;cursor:not-allowed}
.gh-btn.gh-primary{background:rgba(90,200,120,.2);border-color:rgba(90,200,120,.55)}
.gh-input{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.3);border-radius:8px;color:inherit;padding:6px 10px;font-size:13px}
.gh-code{font-size:26px;font-weight:700;letter-spacing:6px;text-align:center;padding:8px 0;font-family:monospace}
.gh-status{font-size:12px;padding:2px 10px;border-radius:999px;background:rgba(255,180,60,.22);color:inherit}
.gh-status.on{background:rgba(90,200,120,.25)}
.gh-status.end{background:rgba(255,90,90,.22)}
.gh-msg{font-size:12px;color:rgba(255,110,110,.95);margin:6px 0}
.gh-note{font-size:11px;opacity:.55;margin-top:6px}
.gh-log{font-size:12px;opacity:.8;line-height:1.6}
.gh-textarea{width:100%;box-sizing:border-box;background:rgba(128,128,128,.06);border:1px dashed rgba(128,128,128,.35);border-radius:8px;color:inherit;font-size:12px;padding:8px;resize:vertical}
.gh-board{display:grid;grid-template-columns:repeat(3,64px);gap:6px;justify-content:center;margin:10px 0}
.gh-cell{width:64px;height:64px;font-size:26px;background:rgba(128,128,128,.1);border:1px solid rgba(128,128,128,.3);border-radius:8px;color:inherit;cursor:pointer}
.gh-cell:disabled{cursor:not-allowed}
.gh-move{font-size:15px;padding:10px 16px}
.gh-wait{font-size:12px;opacity:.7;text-align:center;padding:10px 0}
.gh-win{text-align:center;font-size:15px;font-weight:700;padding:10px 0;color:rgba(90,200,120,.95)}
.gh-pond{display:flex;align-items:center;justify-content:center;gap:8px;font-size:16px;padding:6px 0}
.gh-pond b{font-size:34px;color:rgba(244,162,89,.95)}
.gh-page-link{display:inline-block;margin-left:auto;font-size:12px;color:rgba(120,150,255,.9);text-decoration:none;border:1px solid rgba(120,150,255,.4);border-radius:8px;padding:3px 10px}
.gh-side-btn{display:flex;align-items:center;justify-content:center;width:100%;border:none;background:transparent;color:inherit;cursor:pointer;font-size:15px;padding:6px 0}
.gh-side-btn:hover{background:rgba(128,128,128,.15)}
.gh-side-wide{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;padding:8px 12px;text-align:left}
.gh-side-wide:hover{background:rgba(128,128,128,.15)}
.gh-overlay{position:fixed;top:16px;right:16px;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;background:rgba(20,24,38,.97);border:1px solid rgba(128,128,128,.3);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.5);z-index:9999;pointer-events:auto;padding:12px 14px;color:#eef4ed}
.gh-overlay-head{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;padding-bottom:8px;border-bottom:1px solid rgba(128,128,128,.2);margin-bottom:10px}
.gh-overlay-close{margin-left:auto;border:none;background:rgba(128,128,128,.2);color:inherit;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:13px}
.gh-overlay-close:hover{background:rgba(128,128,128,.35)}
.gh-overlay .gh-root{max-width:100%}
`)

    // 弹窗开关状态（侧栏按钮 ↔ 浮层面板共享）
    const bus = { open: false, subs: [] }
    function setOverlay(open) {
      bus.open = !!open
      bus.subs.forEach(function (fn) { fn(bus.open) })
    }
    function useOverlayOpen() {
      const [open, setOpen] = React.useState(bus.open)
      React.useEffect(function () {
        const fn = function (v) { setOpen(v) }
        bus.subs.push(fn)
        return function () {
          const i = bus.subs.indexOf(fn)
          if (i >= 0) bus.subs.splice(i, 1)
        }
      }, [])
      return [open, setOverlay]
    }

    // 侧栏底部入口按钮（新增，不替换现有项）
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'gamehub', order: -10, label: '博弈小屋' },
      (props) => {
        const [open, setOpen] = useOverlayOpen()
        const wide = !!props.wide
        return React.createElement('button', {
          className: wide ? 'gh-side-wide' : 'gh-side-btn',
          title: '博弈小屋 · 游戏大厅',
          onClick: function () { setOpen(!open) }
        }, wide ? React.createElement('span', null, '🎮 博弈小屋') : React.createElement('span', null, '🎮'))
      }
    ))

    // 全局浮层面板：完整游戏大厅，点击侧栏按钮开合
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'gamehub-panel', order: 0, label: '博弈小屋面板' },
      (props) => {
        const [open] = useOverlayOpen()
        if (!open) return null
        return React.createElement('div', { className: 'gh-overlay' },
          React.createElement('div', { className: 'gh-overlay-head' },
            React.createElement('span', null, '🎮 博弈小屋'),
            React.createElement('button', { className: 'gh-overlay-close', onClick: function () { setOverlay(false) } }, '✕')
          ),
          React.createElement(GameHub, { ctx: ctx, sessionId: null })
        )
      }
    ))

    // 运行卡片内的界面（保留）
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => React.createElement(GameHub, { ctx: ctx, sessionId: props.sessionId })
    ))

    function GameHub(props) {
      const ctxLocal = props.ctx
      const sessionId = props.sessionId || null
      const [playerId, setPlayerId] = React.useState(null)
      const [name, setName] = React.useState('')
      const [games, setGames] = React.useState([])
      const [view, setView] = React.useState('lobby')
      const [room, setRoom] = React.useState(null)
      const [invite, setInvite] = React.useState(null)
      const [codeInput, setCodeInput] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [rooms, setRooms] = React.useState([])
      const [pageUrl, setPageUrl] = React.useState('')

      React.useEffect(function () { init() }, [])
      React.useEffect(function () {
        if (!room || room.status === 'finished') return undefined
        const d = ctxLocal.interval(function () { refreshRoom() }, 1500)
        return function () { d() }
      }, [room ? room.code + room.status : ''])
      React.useEffect(function () {
        if (view === 'lobby') refreshRooms()
      }, [view])

      async function init() {
        try {
          const r = await host.call('identify', { sessionId: sessionId })
          setPlayerId(r.playerId)
          setName(r.name)
          const g = await host.call('games')
          setGames(g || [])
          const u = await host.call('page-url')
          if (u && u.url) setPageUrl(u.url)
        } catch (e) { setMsg('初始化失败: ' + String(e && e.message || e)) }
      }
      async function refreshRoom() {
        if (!room) return
        try {
          const r = await host.call('state', { code: room.code, playerId: playerId })
          if (r) setRoom(r)
        } catch (e) { /* ignore */ }
      }
      async function refreshRooms() {
        try {
          const r = await host.call('list')
          setRooms(r || [])
        } catch (e) { /* ignore */ }
      }
      async function call(action, args) {
        setBusy(true)
        setMsg('')
        try {
          const r = await host.call(action, Object.assign({ playerId: playerId, name: name }, args || {}))
          if (r && r.error) { setMsg(r.error); return null }
          return r
        } catch (e) { setMsg(String(e && e.message || e)); return null }
        finally { setBusy(false) }
      }
      async function doCreate(gameId, withBot) {
        const r = await call('create', { game: gameId, withBot: !!withBot })
        if (!r) return
        setRoom(r.room); setInvite(r.share); setView('room')
      }
      async function doQuick(gameId) {
        const r = await call('quick', { game: gameId })
        if (!r) return
        setRoom(r.room); setInvite(r.share); setView('room')
      }
      async function doJoin(code) {
        const r = await call('join', { code: code })
        if (!r) return
        setRoom(r.room); setInvite(r.share); setView('room')
      }
      async function doMove(move) {
        if (!room || busy) return
        const r = await call('move', { code: room.code, move: move })
        if (!r) return
        setRoom(r.room)
        const s = await host.call('share', { code: room.code })
        if (s && s.text) setInvite(s)
      }
      async function doLeave() {
        if (room) await call('leave', { code: room.code })
        setRoom(null); setInvite(null); setView('lobby'); refreshRooms()
      }
      async function doSetName() {
        const r = await call('set-name', { name: name })
        if (r) setMsg('昵称已保存')
      }

      if (view === 'room' && room) {
        return React.createElement(RoomView, {
          room: room, invite: invite, playerId: playerId, name: name, setName: setName,
          busy: busy, msg: msg, setMsg: setMsg,
          onMove: doMove, onLeave: doLeave, pageUrl: pageUrl
        })
      }
      return React.createElement(LobbyView, {
        games: games, rooms: rooms, codeInput: codeInput, setCodeInput: setCodeInput,
        name: name, setName: setName, msg: msg, setMsg: setMsg, busy: busy,
        onCreate: doCreate, onQuick: doQuick, onJoin: doJoin, onName: doSetName, onRefresh: refreshRooms,
        pageUrl: pageUrl
      })
    }

    function LobbyView(p) {
      const cards = (p.games || []).map(function (g) {
        const extra = g.id === 'gongyu' ? ' · 4人同塘 · 公共地悲剧' : (g.kind === 'simultaneous' ? ' · 双方同时出招' : ' · 轮流落子')
        return React.createElement('div', { key: g.id, className: 'gh-game' },
          React.createElement('div', { className: 'gh-game-t' }, g.icon + ' ' + g.name),
          React.createElement('div', { className: 'gh-game-d' }, g.desc + extra),
          React.createElement('div', { className: 'gh-btns' },
            React.createElement('button', { className: 'gh-btn gh-primary', disabled: p.busy, onClick: function () { p.onCreate(g.id, false) } }, '创建房间'),
            React.createElement('button', { className: 'gh-btn', disabled: p.busy, onClick: function () { p.onQuick(g.id) } }, '快速匹配'),
            React.createElement('button', { className: 'gh-btn', disabled: p.busy, onClick: function () { p.onCreate(g.id, true) } }, '🤖 人机对战')
          )
        )
      })
      const roomRows = (p.rooms || []).map(function (r) {
        return React.createElement('div', { key: r.code, className: 'gh-row' },
          React.createElement('span', { style: { fontSize: 13 } }, r.gameIcon + ' ' + r.gameName + ' · ' + r.code + ' · 房主 ' + r.host),
          React.createElement('button', { className: 'gh-btn', disabled: p.busy, onClick: function () { p.onJoin(r.code) } }, '加入')
        )
      })
      return React.createElement('div', { className: 'gh-root' },
        React.createElement('div', { className: 'gh-header' },
          React.createElement('span', null, '🎮 博弈小屋'),
          p.pageUrl ? React.createElement('a', { className: 'gh-page-link', href: p.pageUrl, target: '_blank', rel: 'noreferrer' }, '打开独立页面 ↗')
            : null
        ),
        React.createElement('div', { className: 'gh-sub' }, '博弈游戏大厅：创建房间 / 快速匹配 / 人机对战，房间号可任意形式分享'),
        React.createElement('div', { className: 'gh-card' },
          React.createElement('div', { className: 'gh-row' },
            React.createElement('input', { className: 'gh-input', value: p.name, onChange: function (e) { p.setName(e.target.value) }, style: { flex: 1, minWidth: 120 } }),
            React.createElement('button', { className: 'gh-btn', onClick: p.onName }, '保存昵称')
          )
        ),
        React.createElement('div', { className: 'gh-card' },
          React.createElement('div', { className: 'gh-row' },
            React.createElement('input', { className: 'gh-input', value: p.codeInput, onChange: function (e) { p.setCodeInput(e.target.value.toUpperCase()) }, placeholder: '输入房间号加入', style: { flex: 1, minWidth: 120 } }),
            React.createElement('button', { className: 'gh-btn gh-primary', disabled: p.busy || !p.codeInput.trim(), onClick: function () { p.onJoin(p.codeInput.trim()) } }, '加入房间')
          ),
          React.createElement('div', { className: 'gh-note' }, '朋友把房间号发给你后，在这里输入即可开局；下方列出等待中的房间可直接加入')
        ),
        cards,
        React.createElement('div', { className: 'gh-sub' }, '🕐 等待中的房间'),
        React.createElement('div', { className: 'gh-card' }, roomRows.length ? roomRows : React.createElement('div', { className: 'gh-note' }, '暂无等待中的房间')),
        p.msg ? React.createElement('div', { className: 'gh-msg' }, p.msg) : null
      )
    }

    function RoomView(p) {
      const room = p.room
      const isMyTurn = room.kind === 'turn' ? room.players.some(function (pl, i) { return pl.id === p.playerId && room.turn === i }) : true
      const statusChip = room.status === 'playing'
        ? React.createElement('span', { className: 'gh-status on' }, '对局中')
        : room.status === 'finished'
          ? React.createElement('span', { className: 'gh-status end' }, '已结束')
          : React.createElement('span', { className: 'gh-status' }, '等待中…')

      const playersRow = (room.players || []).map(function (pl) {
        const score = room.scores ? (room.scores[pl.id] || 0) : 0
        const tag = pl.isBot ? ' 🤖' : (pl.id === p.playerId ? '（你）' : '')
        return React.createElement('div', { key: pl.id, className: 'gh-row' },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, (pl.emoji || '') + ' ' + pl.name + tag),
          React.createElement('span', { style: { fontSize: 12, opacity: .7 } }, '得分 ' + score)
        )
      })

      let board = null
      if (room.kind === 'simultaneous') {
        const labels = room.moveLabels || {}
        const moveKeys = Object.keys(labels)
        const canMove = room.status === 'playing' && !room.myMove && !p.busy
        board = React.createElement('div', null,
          React.createElement('div', { className: 'gh-btns', style: { justifyContent: 'center' } },
            moveKeys.map(function (k) {
              return React.createElement('button', { key: k, className: 'gh-btn gh-move', disabled: !canMove, onClick: function () { p.onMove(k) } }, labels[k])
            })
          ),
          React.createElement('div', { className: 'gh-wait' },
            room.myMove ? (room.bothMoved ? '双方已出招 ✓' : '已出招，等待对手…') : (room.status === 'playing' ? (room.oppMoved ? '对手已出招，轮到你了！' : '请出招') : '')
          ),
          room.lastRound ? React.createElement('div', { className: 'gh-log' },
            '第 ' + room.lastRound.round + ' 回合：' + (room.lastRound.a === 'rock' ? '✊' : room.lastRound.a === 'paper' ? '✋' : room.lastRound.a === 'scissors' ? '✌️' : room.lastRound.a) + ' vs ' +
            (room.lastRound.b === 'rock' ? '✊' : room.lastRound.b === 'paper' ? '✋' : room.lastRound.b === 'scissors' ? '✌️' : room.lastRound.b) + ' → ' +
            (room.lastRound.winner ? (room.lastRound.winner === p.playerId ? '你赢了这一回合' : '对手赢了这一回合') : '平局')
          ) : null,
          room.game === 'pd' ? React.createElement('div', { className: 'gh-note' },
            '收益：合作+合作=3/3 · 你背叛对方=5/0 · 对方背叛你=0/5 · 都背叛=1/1（5回合累计）'
          ) : null
        )
      } else if (room.kind === 'turn' && room.board) {
        const marks = ['X', 'O']
        const myIdx = (room.players || []).findIndex(function (pl) { return pl.id === p.playerId })
        board = React.createElement('div', null,
          React.createElement('div', { className: 'gh-wait' },
            room.status === 'playing'
              ? (isMyTurn ? '轮到你落子（' + marks[Math.max(myIdx, 0)] + '）' : '等待对手落子…')
              : '对局结束'
          ),
          React.createElement('div', { className: 'gh-board' },
            (room.board || []).map(function (cell, i) {
              return React.createElement('button', {
                key: i, className: 'gh-cell',
                disabled: room.status !== 'playing' || !isMyTurn || cell !== null || p.busy,
                onClick: function () { p.onMove(String(i)) }
              }, cell || '')
            })
          )
        )
      } else if (room.game === 'gongyu') {
        const pond = room.pond || 0
        const phase = room.phase || 'catch'
        const myTurn = room.punishTurn === p.playerId
        let phaseBox = null
        if (room.status === 'playing' && phase === 'catch') {
          const canTake = !room.myCatch && !p.busy
          phaseBox = React.createElement('div', null,
            React.createElement('div', { className: 'gh-wait' },
              room.myCatch ? '已下网，等待收网…' : (room.catchDone ? '正在收网…' : '暗选捞几条（别人看不到）')
            ),
            React.createElement('div', { className: 'gh-btns', style: { justifyContent: 'center' } },
              [1, 2, 3].map(function (n) {
                return React.createElement('button', { key: n, className: 'gh-btn gh-move', disabled: !canTake, onClick: function () { p.onMove(String(n)) } }, '捞 ' + n + ' 条 🐟')
              })
            ),
            React.createElement('div', { className: 'gh-note' }, '人均可持续 ≈1.5 条/轮 —— 但别人可不会这么想')
          )
        } else if (room.status === 'playing' && phase === 'punish') {
          phaseBox = React.createElement('div', null,
            React.createElement('div', { className: 'gh-wait' },
              myTurn ? '轮到你：惩罚阶段（花自己 1 分，扣某人 3 分）' : '等待 ' + (room.punishTurnName || '对手') + ' 决策…'
            ),
            myTurn ? React.createElement('div', { className: 'gh-btns', style: { justifyContent: 'center' } },
              (room.punishOptions || []).map(function (o) {
                return React.createElement('button', { key: o.id, className: 'gh-btn gh-move', disabled: p.busy, onClick: function () { p.onMove(o.id) } }, '咬 ' + o.emoji + ' ' + o.name)
              }),
              React.createElement('button', { key: 'skip', className: 'gh-btn', disabled: p.busy, onClick: function () { p.onMove('skip') } }, '忍了，跳过')
            ) : null
          )
        }
        let finalsBox = null
        if (room.finals) {
          const order = (room.players || []).map(function (pl, i) { return i }).sort(function (a, b) { return (room.finals[room.players[b].id] || 0) - (room.finals[room.players[a].id] || 0) })
          const medals = ['🥇', '🥈', '🥉', '']
          finalsBox = React.createElement('div', { className: 'gh-card' },
            order.map(function (i, k) {
              const pl = room.players[i]
              return React.createElement('div', { key: pl.id, className: 'gh-row' },
                React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, medals[k] + ' ' + (pl.emoji || '') + ' ' + pl.name),
                React.createElement('b', null, room.finals[pl.id])
              )
            })
          )
        }
        board = React.createElement('div', null,
          React.createElement('div', { className: 'gh-card' },
            React.createElement('div', { className: 'gh-pond' }, '🐟 ×', React.createElement('b', null, pond), React.createElement('span', { style: { fontSize: 12, opacity: .7 } }, '/ 20')),
            React.createElement('div', { className: 'gh-wait' }, '第 ' + room.round + '/' + room.rounds + ' 轮 · ' + (room.collapsed ? '💀 鱼塘已枯竭' : (phase === 'catch' ? '捕鱼阶段' : '惩罚阶段')))
          ),
          phaseBox,
          finalsBox
        )
      }

      let log = null
      if (room.history && room.history.length) {
        const rows = room.history.slice(-6).map(function (h, i) {
          if (room.game === 'pd') {
            const isMe0 = (room.players || [])[0] && (room.players || [])[0].id === p.playerId
            const myMove = isMe0 ? h.a : h.b
            const oppMove = isMe0 ? h.b : h.a
            return React.createElement('div', { key: i }, '第' + h.round + '轮：你 ' + (myMove === 'cooperate' ? '🤝' : '🗡️') + ' vs 对手 ' + (oppMove === 'cooperate' ? '🤝' : '🗡️') + ' → 你 ' + (isMe0 ? h.p1 : h.p2) + ' / 对手 ' + (isMe0 ? h.p2 : h.p1))
          }
          if (room.game === 'rps' && h.round) {
            return React.createElement('div', { key: i }, '第' + h.round + '回合结束')
          }
          if (room.game === 'gongyu' && h.round) {
            const pun = (h.punishes || []).length
            return React.createElement('div', { key: i }, '第' + h.round + '轮：共捞 ' + h.total + ' 条 → 塘剩 ' + h.after + '×2' + (pun ? ' · 咬人 ' + pun + ' 次' : ''))
          }
          return null
        }).filter(function (x) { return x !== null })
        log = rows.length ? React.createElement('div', { className: 'gh-card' }, React.createElement('div', { className: 'gh-log' }, rows)) : null
      }

      let result = null
      if (room.status === 'finished') {
        const winner = room.winner
        let text = '平局！'
        if (winner) {
          const w = (room.players || []).find(function (pl) { return pl.id === winner })
          text = (w ? w.name : '对手') + (w && w.id === p.playerId ? '（你）' : '') + ' 获胜！🎉'
        }
        result = React.createElement('div', { className: 'gh-win' }, text)
      }

      return React.createElement('div', { className: 'gh-root' },
        React.createElement('div', { className: 'gh-header' },
          React.createElement('span', null, room.gameIcon + ' ' + room.gameName),
          statusChip,
          p.pageUrl ? React.createElement('a', { className: 'gh-page-link', href: p.pageUrl, target: '_blank', rel: 'noreferrer' }, '独立页面 ↗') : null,
          React.createElement('button', { className: 'gh-btn', disabled: p.busy, onClick: p.onLeave, style: { marginLeft: 'auto' } }, '退出房间')
        ),
        React.createElement('div', { className: 'gh-card' },
          React.createElement('div', { className: 'gh-code' }, room.code),
          React.createElement('div', { className: 'gh-sub', style: { textAlign: 'center' } }, '房间号 · 分享给朋友即可加入'),
          p.invite && p.invite.text ? React.createElement('textarea', { className: 'gh-textarea', readOnly: true, rows: 5, value: p.invite.text, onFocus: function (e) { e.target.select() } }) : null
        ),
        React.createElement('div', { className: 'gh-card' }, playersRow),
        board,
        result,
        log,
        p.msg ? React.createElement('div', { className: 'gh-msg' }, p.msg) : null
      )
    }
  }
}
