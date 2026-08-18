// 博弈小屋 GameHub · preset 版插件（普通 Cordis 插件环境）· 支持局域网 P2P
// 每个会话挂载一次：注册 game_hub 工具 + HTTP 大厅/发现 API + 本机共享大厅引擎。
// 局域网 P2P：UDP 组播发现在线实例（239.255.77.77:45777），每个实例开一个局域网 HTTP
//             对等端口，互相拉取/同步大厅、直接转发加入与落子。跨机器对局零中心。
// 安全设计：对等 HTTP 只暴露白名单房间 API（列表/加入/落子/退出），全部输入校验；
//           大厅文件仅写 /tmp 白名单路径；发现广播只含实例 id/昵称/端口，不含路径与环境信息；
//           不做任何代码执行、不读任意文件、不暴露环境变量。
'use strict'
const LOBBY_NAME = 'dsh-gamehub-lobby.json'
const LOBBY_CANDIDATES = ['/tmp/' + LOBBY_NAME, '/tmp/dsh-gamehub/' + LOBBY_NAME]
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const NAME_MAX = 16
const CODE_RE = /^[A-Z0-9]{4}$/

// 局域网 P2P 常量
const P2P_MCAST_GROUP = '239.255.77.77'
const P2P_MCAST_PORT = 45777
const P2P_INTERVAL_MS = 10000   // 广播/清理周期
const P2P_PEER_TTL_MS = 30000   // 实例 30s 无心跳则视为离线

const GAMEHUB_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎮 博弈小屋</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:linear-gradient(180deg,#0b2545,#134074);color:#eef4ed;min-height:100vh}
.wrap{max-width:520px;margin:0 auto;padding:16px}
h1{font-size:24px;text-align:center;margin:8px 0 2px}
.sub{text-align:center;opacity:.7;font-size:12px;margin-bottom:14px}
.card{background:rgba(255,255,255,.08);border-radius:14px;padding:14px;margin-bottom:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{flex:1;border:none;border-radius:10px;padding:10px 0;font-size:14px;font-weight:700;cursor:pointer;background:#f4a259;color:#1a1a1a}
.btn.ghost{background:rgba(255,255,255,.15);color:#eef4ed}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.small{flex:0 0 auto;padding:6px 14px;font-size:12px;border-radius:8px}
.game{background:rgba(255,255,255,.07);border-radius:12px;padding:12px;margin-bottom:10px}
.game h3{font-size:15px;margin-bottom:2px}
.game .desc{font-size:12px;opacity:.7;margin-bottom:8px}
.game .btns{display:flex;gap:6px}
.game .btns .btn{flex:1;font-size:12px;padding:8px 0}
input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:10px;color:#eef4ed;padding:10px 12px;font-size:14px;flex:1;min-width:100px}
input::placeholder{color:rgba(238,244,237,.4)}
.code{font-size:30px;font-weight:700;letter-spacing:8px;text-align:center;padding:10px 0;font-family:monospace;color:#f4a259}
.status{font-size:12px;padding:2px 10px;border-radius:999px;background:rgba(255,180,60,.25)}
.status.on{background:rgba(90,200,120,.3)}
.status.end{background:rgba(255,90,90,.3)}
.msg{font-size:12px;color:#ff9a9a;margin:6px 0}
.note{font-size:11px;opacity:.55;margin-top:6px}
.log{font-size:12px;opacity:.85;line-height:1.7}
textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.35);border-radius:10px;color:#eef4ed;font-size:12px;padding:8px;resize:vertical;font-family:inherit}
.board{display:grid;grid-template-columns:repeat(3,68px);gap:6px;justify-content:center;margin:12px 0}
.cell{width:68px;height:68px;font-size:28px;background:rgba(255,255,255,.1);border:none;border-radius:10px;color:#eef4ed;cursor:pointer}
.cell:disabled{cursor:not-allowed;opacity:.8}
.moves{display:flex;gap:8px;justify-content:center;margin:12px 0}
.moves .btn{flex:0 0 auto;padding:12px 18px;font-size:15px}
.wait{font-size:13px;opacity:.75;text-align:center;padding:8px 0}
.win{text-align:center;font-size:16px;font-weight:700;padding:12px 0;color:#7ee2a8}
.pond{display:flex;align-items:center;justify-content:center;gap:8px;font-size:18px}
.pond b{font-size:38px;color:#f4a259}
.player{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.07);margin-bottom:6px;font-size:13px}
.player.me{outline:1px solid #f4a259}
.tag{font-size:11px;background:rgba(255,255,255,.15);padding:2px 6px;border-radius:6px}
.medal{font-size:14px}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
'use strict';
const app = document.getElementById('app');
let S = { pid:'', name:'', view:'lobby', games:[], room:null, invite:null, rooms:[], codeInput:'', msg:'', busy:false };

function genPid(){ return 'u-' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function init(){
  let pid = '';
  try { pid = localStorage.getItem('gamehub_pid') || ''; } catch(e){}
  if (!pid) { pid = genPid(); try { localStorage.setItem('gamehub_pid', pid); } catch(e){} }
  let name = '';
  try { name = localStorage.getItem('gamehub_name') || ''; } catch(e){}
  S.pid = pid; S.name = name || '玩家' + pid.slice(-4);
  api('games').then(function(r){ if (r && r.ok) { S.games = r.games; render(); } });
  refreshRooms();
}
function api(path, body){
  const opts = { method: body ? 'POST' : 'GET' };
  if (body) opts.headers = { 'content-type': 'application/json' };
  if (body) opts.body = JSON.stringify(body);
  return fetch('/api/gamehub/' + path, opts).then(function(r){ return r.json(); }).catch(function(){ return { ok:false, error:'网络错误' }; });
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
function refreshRooms(){
  api('lobby').then(function(r){ if (r && r.ok) { S.rooms = r.rooms.filter(function(x){ return x.status === 'waiting'; }); render(); } });
}
function act(name, body){
  body = body || {}; body.playerId = S.pid; body.name = S.name;
  S.busy = true; S.msg = ''; render();
  api(name, body).then(function(r){
    S.busy = false;
    if (!r || !r.ok) { S.msg = (r && r.error) || '操作失败'; render(); return; }
    if (r.room) { S.room = r.room; S.invite = r.share || S.invite; S.view = 'room'; }
    render();
  });
}
function create(g, bot){ act('create', { game:g, withBot:!!bot }); }
function quick(g){ act('quick', { game:g }); }
function join(code){ act('join', { code:code }); }
function move(m){ act('move', { code:S.room.code, move:m }); }
function leave(){ act('leave', { code:S.room.code }); setTimeout(function(){ S.room=null; S.invite=null; S.view='lobby'; refreshRooms(); }, 300); }
function saveName(){ const n = S.name.trim(); if (!n) return; S.name = n; try { localStorage.setItem('gamehub_name', n); } catch(e){} act('setName', { name:n }); S.msg = '昵称已保存'; render(); }

function pollRoom(){
  if (S.view !== 'room' || !S.room || S.room.status === 'finished') return;
  api('room?code=' + S.room.code + '&playerId=' + S.pid).then(function(r){
    if (r && r.ok && r.room) { S.room = r.room; S.invite = r.share || S.invite; render(); }
  });
}
setInterval(pollRoom, 1500);

function playerRow(p, i){
  const score = S.room.scores ? (S.room.scores[p.id] || 0) : 0;
  const me = p.id === S.pid ? ' me' : '';
  const tag = p.isBot ? ' <span class="tag">AI</span>' : (p.id === S.pid ? ' <span class="tag">你</span>' : '');
  return '<div class="player' + me + '"><span>' + esc(p.emoji || '') + ' ' + esc(p.name) + tag + '</span><span>得分 ' + score + '</span></div>';
}

function renderLobby(){
  const games = S.games.map(function(g){
    const extra = g.id === 'gongyu' ? ' · 4人同塘' : (g.kind === 'simultaneous' ? ' · 同时出招' : ' · 轮流落子');
    return '<div class="game"><h3>' + g.icon + ' ' + esc(g.name) + '</h3><div class="desc">' + esc(g.desc) + extra + '</div>' +
      '<div class="btns"><button class="btn" onclick="create(\'' + g.id + '\',false)">创建房间</button>' +
      '<button class="btn ghost" onclick="quick(\'' + g.id + '\')">快速匹配</button>' +
      '<button class="btn ghost" onclick="create(\'' + g.id + '\',true)">🤖 人机</button></div></div>';
  }).join('');
  const roomRows = S.rooms.map(function(r){
    return '<div class="player"><span>' + r.gameIcon + ' ' + esc(r.gameName) + ' · ' + r.code + ' · 房主 ' + esc(r.players && r.players[0] ? r.players[0].name : '') + '</span>' +
      '<button class="btn small" onclick="join(\'' + r.code + '\')">加入</button></div>';
  }).join('') || '<div class="note">暂无等待中的房间</div>';
  app.innerHTML = '<h1>🎮 博弈小屋</h1><div class="sub">博弈游戏大厅 · 房间号可任意形式分享</div>' +
    '<div class="card"><div class="row"><input value="' + esc(S.name) + '" oninput="S.name=this.value" placeholder="昵称">' +
    '<button class="btn small" onclick="saveName()">保存</button></div></div>' +
    '<div class="card"><div class="row"><input value="' + esc(S.codeInput) + '" oninput="S.codeInput=this.value.toUpperCase()" placeholder="输入房间号加入" onkeydown="if(event.key===\'Enter\')join(S.codeInput.trim())">' +
    '<button class="btn small" onclick="join(S.codeInput.trim())">加入房间</button></div></div>' +
    games +
    '<div class="sub">🕐 等待中的房间</div><div class="card">' + roomRows + '</div>' +
    (S.msg ? '<div class="msg">' + esc(S.msg) + '</div>' : '');
}

function renderRoom(){
  const r = S.room;
  const chip = r.status === 'playing' ? '<span class="status on">对局中</span>' : r.status === 'finished' ? '<span class="status end">已结束</span>' : '<span class="status">等待中…</span>';
  const players = (r.players || []).map(playerRow).join('');
  let board = '';
  if (r.kind === 'simultaneous'){
    const canMove = r.status === 'playing' && !r.myMove && !S.busy;
    const labels = r.moveLabels || {};
    const btns = Object.keys(labels).map(function(k){ return '<button class="btn" ' + (canMove ? '' : 'disabled') + ' onclick="move(\'' + k + '\')">' + esc(labels[k]) + '</button>'; }).join('');
    let wait = r.myMove ? (r.bothMoved ? '双方已出招 ✓' : '已出招，等待对手…') : (r.status === 'playing' ? (r.oppMoved ? '对手已出招，轮到你了！' : '请出招') : '');
    let last = r.lastRound ? '<div class="log">第 ' + r.lastRound.round + ' 回合：' + r.lastRound.a + ' vs ' + r.lastRound.b + ' → ' + (r.lastRound.winner ? (r.lastRound.winner === S.pid ? '你赢了' : '对手赢了') : '平局') + '</div>' : '';
    board = '<div class="moves">' + btns + '</div><div class="wait">' + wait + '</div>' + last +
      (r.game === 'pd' ? '<div class="note">收益：合作+合作=3/3 · 你背叛=5/0 · 对方背叛你=0/5 · 都背叛=1/1（5回合）</div>' : '');
  } else if (r.kind === 'turn' && r.board){
    const myIdx = (r.players || []).findIndex(function(pl){ return pl.id === S.pid; });
    const myTurn = r.turn === myIdx;
    const cells = r.board.map(function(cell, i){
      return '<button class="cell" ' + (r.status === 'playing' && myTurn && cell === null && !S.busy ? '' : 'disabled') + ' onclick="move(\'' + i + '\')">' + (cell || '') + '</button>';
    }).join('');
    board = '<div class="wait">' + (r.status === 'playing' ? (myTurn ? '轮到你落子（' + (myIdx === 0 ? 'X' : 'O') + '）' : '等待对手落子…') : '对局结束') + '</div><div class="board">' + cells + '</div>';
  } else if (r.game === 'gongyu'){
    const phase = r.phase || 'catch';
    const myTurn = r.punishTurn === S.pid;
    let phaseBox = '';
    if (r.status === 'playing' && phase === 'catch'){
      const can = !r.myCatch && !S.busy;
      phaseBox = '<div class="wait">' + (r.myCatch ? '已下网，等待收网…' : '暗选捞几条（别人看不到）') + '</div>' +
        '<div class="moves">' + [1,2,3].map(function(n){ return '<button class="btn" ' + (can ? '' : 'disabled') + ' onclick="move(\'' + n + '\')">捞 ' + n + ' 条 🐟</button>'; }).join('') + '</div>' +
        '<div class="note">人均可持续 ≈1.5 条/轮 —— 但别人可不会这么想</div>';
    } else if (r.status === 'playing' && phase === 'punish'){
      const opts = (r.punishOptions || []).map(function(o){ return '<button class="btn" onclick="move(\'' + esc(o.id) + '\')">咬 ' + o.emoji + ' ' + esc(o.name) + '</button>'; }).join('');
      phaseBox = '<div class="wait">' + (myTurn ? '轮到你：惩罚阶段（花1分扣3分）' : '等待 ' + esc(r.punishTurnName || '对手') + ' 决策…') + '</div>' +
        (myTurn ? '<div class="moves">' + opts + '<button class="btn ghost" onclick="move(\'skip\')">忍了，跳过</button></div>' : '');
    }
    let finals = '';
    if (r.finals){
      const order = (r.players || []).map(function(_,i){ return i; }).sort(function(a,b){ return (r.finals[r.players[b].id]||0) - (r.finals[r.players[a].id]||0); });
      const medals = ['🥇','🥈','🥉',''];
      finals = '<div class="card">' + order.map(function(i,k){ return '<div class="player"><span class="medal">' + medals[k] + ' ' + esc(r.players[i].emoji||'') + ' ' + esc(r.players[i].name) + '</span><b>' + r.finals[r.players[i].id] + '</b></div>'; }).join('') + '</div>';
    }
    board = '<div class="card"><div class="pond">🐟 × <b>' + (r.pond||0) + '</b> <span style="font-size:12px;opacity:.7">/ 20</span></div>' +
      '<div class="wait">第 ' + r.round + '/' + r.rounds + ' 轮 · ' + (r.collapsed ? '💀 鱼塘已枯竭' : (phase === 'catch' ? '捕鱼阶段' : '惩罚阶段')) + '</div></div>' + phaseBox + finals;
  }
  const log = (r.history || []).slice(-6).map(function(h){
    if (r.game === 'gongyu') return '<div>第' + h.round + '轮：共捞 ' + h.total + ' 条 → 塘剩 ' + h.after + '×2' + ((h.punishes||[]).length ? ' · 咬人 ' + h.punishes.length + ' 次' : '') + '</div>';
    if (r.game === 'pd'){
      const isMe0 = (r.players||[])[0] && r.players[0].id === S.pid;
      return '<div>第' + h.round + '轮：你 ' + (isMe0 ? h.a : h.b) + ' vs 对手 ' + (isMe0 ? h.b : h.a) + ' → 你 ' + (isMe0 ? h.p1 : h.p2) + ' / 对手 ' + (isMe0 ? h.p2 : h.p1) + '</div>';
    }
    return '';
  }).join('') || '';
  const win = r.status === 'finished' ? (function(){
    if (!r.winner) return '<div class="win">平局！</div>';
    const w = (r.players||[]).find(function(pl){ return pl.id === r.winner; });
    return '<div class="win">' + esc(w ? w.name : '对手') + (w && w.id === S.pid ? '（你）' : '') + ' 获胜！🎉</div>';
  })() : '';
  app.innerHTML = '<h1>🎮 博弈小屋</h1><div class="sub">' + esc(r.gameIcon) + ' ' + esc(r.gameName) + ' · 房间号可分享</div>' +
    '<div class="card"><div class="row"><b style="font-size:13px">房间</b>' + chip +
    '<button class="btn small ghost" style="margin-left:auto" onclick="leave()">退出房间</button></div>' +
    '<div class="code">' + r.code + '</div>' +
    (S.invite && S.invite.text ? '<textarea rows="4" readonly onclick="this.select()">' + esc(S.invite.text) + '</textarea>' : '') +
    '</div><div class="card">' + players + '</div>' + board + win +
    (log ? '<div class="card log">' + log + '</div>' : '') +
    (S.msg ? '<div class="msg">' + esc(S.msg) + '</div>' : '');
}

function render(){
  if (S.busy && S.view === 'lobby') return;
  if (S.view === 'room' && S.room) renderRoom(); else renderLobby();
}
init();
</script>
</body>
</html>`

module.exports = {
  inject: ['timer'],
  apply(ctx) {
    const timer = ctx.timer
    const fs = ctx.get('fs')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const webServer = ctx.get('webServer')

    // ---------- 侧栏入口注入（host 组合常驻版） ----------
    // 通过 webServer.tapIndex 把侧栏按钮 + iframe 浮层脚本注入每个 DSH 页面：
    // 按钮点击弹出博弈小屋大厅（复用 /gamehub 独立页面），样式走 shadow DOM 隔离。
    const SIDEBAR_SCRIPT = '<script>\n' +
      '(function(){\n' +
      '  try {\n' +
      '    if (window.__gamehubInjected) return; window.__gamehubInjected = true;\n' +
      '    var host = document.createElement("div");\n' +
      '    host.style.cssText = "position:fixed;left:0;bottom:0;z-index:2147483000;pointer-events:none";\n' +
      '    var root = host.attachShadow ? host.attachShadow({mode:"open"}) : host;\n' +
      '    var style = document.createElement("style");\n' +
      '    style.textContent =\n' +
      '      ".gh-btn{position:fixed;left:14px;bottom:72px;z-index:2147483001;width:42px;height:42px;border-radius:13px;border:none;background:linear-gradient(135deg,#f4a259,#e8873c);color:#1a1a1a;font-size:19px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.4);pointer-events:auto;transition:transform .12s ease}" +\n' +
      '      ".gh-btn:hover{transform:scale(1.08)}" +\n' +
      '      ".gh-panel{position:fixed;left:68px;bottom:20px;z-index:2147483001;width:min(600px,calc(100vw - 96px));height:min(760px,calc(100vh - 48px));background:#0b2545;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.55);display:none;overflow:hidden;border:1px solid rgba(255,255,255,.14);pointer-events:auto}" +\n' +
      '      ".gh-panel.open{display:block}" +\n' +
      '      ".gh-close{position:absolute;top:10px;right:10px;z-index:2;width:30px;height:30px;border-radius:9px;border:none;background:rgba(255,255,255,.16);color:#eef4ed;cursor:pointer;font-size:14px;line-height:1}" +\n' +
      '      ".gh-frame{width:100%;height:100%;border:none;background:#0b2545}";\n' +
      '    root.appendChild(style);\n' +
      '    var btn = document.createElement("button");\n' +
      '    btn.className = "gh-btn"; btn.title = "博弈小屋"; btn.textContent = "🎮";\n' +
      '    var panel = document.createElement("div");\n' +
      '    panel.className = "gh-panel";\n' +
      '    var close = document.createElement("button");\n' +
      '    close.className = "gh-close"; close.textContent = "✕";\n' +
      '    var frame = document.createElement("iframe");\n' +
      '    frame.className = "gh-frame"; frame.src = "/gamehub";\n' +
      '    panel.appendChild(close); panel.appendChild(frame);\n' +
      '    root.appendChild(btn); root.appendChild(panel);\n' +
      '    document.documentElement.appendChild(host);\n' +
      '    function toggle(){ var open = panel.classList.toggle("open"); if (open) { frame.src = "/gamehub"; } }\n' +
      '    btn.addEventListener("click", toggle);\n' +
      '    close.addEventListener("click", toggle);\n' +
      '  } catch (e) { /* 注入失败不影响页面 */ }\n' +
      '})();\n' +
      '</script>'
    if (webServer && typeof webServer.tapIndex === 'function') {
      ctx.effect(() => webServer.tapIndex(function (html) {
        try {
          const s = String(html)
          if (s.indexOf('__gamehubInjected') >= 0) return s
          return s.replace('</body>', SIDEBAR_SCRIPT + '</body>')
        } catch (e) { return html }
      }))
    }

    // ---------- shared lobby persistence (same-machine cross-session) ----------
    let lobbyPath = null
    let memoryLobby = null

    async function resolveLobbyPath() {
      if (lobbyPath) return lobbyPath
      const candidates = LOBBY_CANDIDATES.slice()
      if (fs && sandboxPolicy) {
        try {
          const root = sandboxPolicy.workspaceRoot
          if (root) candidates.push(root + '/.dsh-gamehub/' + LOBBY_NAME)
        } catch (e) { /* ignore */ }
      }
      if (fs) candidates.push('.dsh-gamehub-lobby.json')
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
        // 已结束的对局 5 分钟内清理；等待/进行中 45 分钟
        const ttl = r.status === 'finished' ? 5 * 60 * 1000 : 45 * 60 * 1000
        if (now - (r.updatedAt || 0) > ttl) delete lobby.rooms[code]
      }
    }

    function getPlayer(lobby, playerId) {
      return lobby.players[playerId] || { name: '玩家' + String(playerId).slice(-4) }
    }

    // ---------- games registry ----------
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

    // ---------- 共鱼 · 鱼塘博弈 ----------
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
              const ctx2 = gongyuPunishCtx(r, idx)
              const t = gongyuBotPunish(r.players, idx, ctx2)
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
          for (const l of TTT_LINES) {
            const mine = l.filter(function (i) { return board[i] === mark })
            const empty = l.filter(function (i) { return board[i] === null })
            if (mine.length === 2 && empty.length === 1) return empty[0]
          }
          for (const l of TTT_LINES) {
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
      // 没有真人玩家了（空房或只剩 AI）→ 彻底删除，不再出现在任何列表
      const hasHuman = room.players.some(function (p) { return !p.isBot })
      if (!hasHuman) {
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

    // ---------- 安全护栏 ----------
    function sanitizeName(raw) {
      const s = String(raw == null ? '' : raw).replace(/[\r\n\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX)
      return s || '玩家'
    }
    function sanitizeCode(raw) {
      const s = String(raw == null ? '' : raw).trim().toUpperCase()
      return CODE_RE.test(s) ? s : ''
    }
    function sanitizePlayerId(raw) {
      return String(raw == null ? '' : raw).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 40)
    }
    function playerOf(args) {
      const pid = sanitizePlayerId((args && args.playerId) || ('u-' + Math.random().toString(36).slice(2, 8)))
      return { id: pid || ('u-' + Math.random().toString(36).slice(2, 8)), name: sanitizeName(args && args.name) }
    }

    // ---------- 局域网 P2P：UDP 组播发现 + 对等 HTTP ----------
    // 依赖 node:dgram / node:http（preset 环境可用；动态插件沙箱不可用，所以 P2P 在 preset 版）
    let p2p = null
    try {
      const dgram = require('node:dgram')
      const http = require('node:http')
      const os = require('node:os')

      // 本机局域网地址（排除回环）
      function lanAddress() {
        try {
          const ifaces = os.networkInterfaces()
          for (const name of Object.keys(ifaces)) {
            for (const info of ifaces[name] || []) {
              if (info.family === 'IPv4' && !info.internal) return info.address
            }
          }
        } catch (e) { /* ignore */ }
        return '127.0.0.1'
      }

      // 实例身份：只广播公开元数据
      const peerId = 'gh-' + Math.random().toString(36).slice(2, 10)
      let peerName = '博弈小屋'
      const peers = {} // id -> { id, name, addr, port, lastSeen }
      let peerServer = null
      let peerPort = 0
      const lanIp = lanAddress()

      function peerUrl(peer) {
        return 'http://' + peer.addr + ':' + peer.port
      }

      // 对等 HTTP 白名单 API：lobby / peers / room / join / move / leave
      function peerHandler(req, res) {
        const respond = function (data, status) {
          res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(data))
        }
        let path = ''
        try { path = String(req.url || '').split('?')[0] } catch (e) { path = '' }
        const method = req.method || 'GET'

        if (path === '/api/peer/ping') {
          respond({ ok: true, id: peerId, name: peerName, kind: 'gamehub' })
          return
        }
        if (path === '/api/peer/lobby' && method === 'GET') {
          readLobby().then(function (lobby) {
            const rooms = Object.keys(lobby.rooms)
              .filter(function (code) { return lobby.rooms[code].status === 'waiting' })
              .map(function (code) {
                const r = lobby.rooms[code]
                return { code: r.code, game: r.game, gameName: GAMES[r.game].name, gameIcon: GAMES[r.game].icon, host: r.players[0] ? r.players[0].name : '' }
              })
            respond({ ok: true, id: peerId, name: peerName, rooms: rooms })
          }).catch(function () { respond({ ok: false, error: 'lobby read failed' }, 500) })
          return
        }
        if (path === '/api/peer/room' && method === 'GET') {
          let code = ''
          try { code = String((req.url || '').split('?')[1] || '').split('&').map(function (p) { return p.split('=') }).filter(function (kv) { return kv[0] === 'code' }).map(function (kv) { return kv[1] }).join('') } catch (e) { code = '' }
          code = code.toUpperCase()
          if (!CODE_RE.test(code)) return respond({ ok: false, error: '房间号格式错误' }, 400)
          readLobby().then(function (lobby) {
            const room = lobby.rooms[code]
            if (!room) return respond({ ok: false, error: '房间不存在' }, 404)
            respond({ ok: true, room: roomView(room, null) })
          }).catch(function () { respond({ ok: false, error: 'read failed' }, 500) })
          return
        }
        if (path === '/api/peer/join' && method === 'POST') {
          let body = ''
          req.on('data', function (c) { body += c; if (body.length > 4096) req.destroy() })
          req.on('end', function () {
            let args = {}
            try { args = JSON.parse(body || '{}') } catch (e) { args = {} }
            const code = sanitizeCode(args.code)
            if (!code) return respond({ ok: false, error: '房间号格式错误' }, 400)
            const player = playerOf(args)
            mutateLobby(function (lobby) {
              lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
              const out = joinRoom(lobby, code, player)
              if (out.error) return respond({ ok: false, error: out.error }, 400)
              respond({ ok: true, room: roomView(out.room, player.id), share: sharePayload(out.room) })
            })
          })
          req.on('error', function () { respond({ ok: false, error: 'bad request' }, 400) })
          return
        }
        if (path === '/api/peer/move' && method === 'POST') {
          let body = ''
          req.on('data', function (c) { body += c; if (body.length > 4096) req.destroy() })
          req.on('end', function () {
            let args = {}
            try { args = JSON.parse(body || '{}') } catch (e) { args = {} }
            const code = sanitizeCode(args.code)
            const pid = sanitizePlayerId(args.playerId)
            if (!code || !pid) return respond({ ok: false, error: '参数错误' }, 400)
            mutateLobby(function (lobby) {
              const out = applyPlayerMove(lobby, code, pid, args.move)
              if (!out.ok) return respond({ ok: false, error: out.error || '落子失败' }, 400)
              respond({ ok: true, room: out.room })
            })
          })
          req.on('error', function () { respond({ ok: false, error: 'bad request' }, 400) })
          return
        }
        if (path === '/api/peer/leave' && method === 'POST') {
          let body = ''
          req.on('data', function (c) { body += c; if (body.length > 4096) req.destroy() })
          req.on('end', function () {
            let args = {}
            try { args = JSON.parse(body || '{}') } catch (e) { args = {} }
            const code = sanitizeCode(args.code)
            const pid = sanitizePlayerId(args.playerId)
            mutateLobby(function (lobby) { leaveRoom(lobby, code, pid) })
            respond({ ok: true })
          })
          req.on('error', function () { respond({ ok: false, error: 'bad request' }, 400) })
          return
        }
        respond({ ok: false, error: 'not found' }, 404)
      }

      // UDP 组播发现
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      udp.on('message', function (msg, rinfo) {
        try {
          const data = JSON.parse(msg.toString())
          if (data && data.kind === 'gamehub' && data.id && data.id !== peerId) {
            peers[data.id] = { id: data.id, name: sanitizeName(data.name), addr: rinfo.address, port: Number(data.port) || 0, lastSeen: Date.now() }
          }
        } catch (e) { /* 非本协议报文忽略 */ }
      })
      udp.bind(P2P_MCAST_PORT, function () {
        try { udp.addMembership(P2P_MCAST_GROUP) } catch (e) { /* 单机/无组播环境忽略 */ }
        udp.setMulticastTTL(1)
        udp.setBroadcast(true)
      })

      // 周期广播 + 清理离线实例
      const announce = function () {
        try {
          const payload = Buffer.from(JSON.stringify({ kind: 'gamehub', id: peerId, name: peerName, port: peerPort }))
          udp.send(payload, P2P_MCAST_PORT, P2P_MCAST_GROUP)
          const now = Date.now()
          for (const id of Object.keys(peers)) {
            if (now - peers[id].lastSeen > P2P_PEER_TTL_MS) delete peers[id]
          }
        } catch (e) { /* ignore */ }
      }
      const announceTimer = timer.interval(announce, P2P_INTERVAL_MS)

      // 启动对等 HTTP 服务器（监听局域网地址）
      peerServer = http.createServer(peerHandler)
      peerServer.listen(0, lanIp, function () {
        peerPort = peerServer.address().port
        // 启动后立刻广播一次
        try {
          const payload = Buffer.from(JSON.stringify({ kind: 'gamehub', id: peerId, name: peerName, port: peerPort }))
          udp.send(payload, P2P_MCAST_PORT, P2P_MCAST_GROUP)
        } catch (e) { /* ignore */ }
      })

      // 远程操作封装：把 code 不在本地时转发给持有它的在线实例
      async function remoteFind(code) {
        for (const id of Object.keys(peers)) {
          const p = peers[id]
          if (!p.port) continue
          try {
            const url = peerUrl(p) + '/api/peer/lobby'
            const res = await httpGetJson(url, null, 2500)
            if (res && res.ok && res.rooms && res.rooms.some(function (r) { return r.code === code })) {
              return p
            }
          } catch (e) { /* 实例不可达忽略 */ }
        }
        return null
      }
      function httpGetJson(url, body, timeoutMs) {
        return new Promise(function (resolve, reject) {
          const u = new URL(url)
          const opts = {
            hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: body ? 'POST' : 'GET',
            timeout: timeoutMs || 2500, headers: { 'content-type': 'application/json' }
          }
          const req = http.request(opts, function (res) {
            let data = ''
            res.on('data', function (c) { data += c })
            res.on('end', function () {
              try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(new Error('bad json')) }
            })
          })
          req.on('timeout', function () { req.destroy(); reject(new Error('timeout')) })
          req.on('error', reject)
          if (body) req.write(JSON.stringify(body))
          req.end()
        })
      }

      p2p = {
        id: peerId,
        name: function () { return peerName },
        setName: function (n) { peerName = sanitizeName(n) },
        lanIp: lanIp,
        port: function () { return peerPort },
        peers: function () {
          const now = Date.now()
          return Object.keys(peers).map(function (id) {
            const p = peers[id]
            return { id: p.id, name: p.name, addr: p.addr, port: p.port, lastSeen: now - p.lastSeen }
          })
        },
        // 从在线实例拉取等待房间（并发）
        remoteRooms: async function () {
          const out = []
          const list = Object.keys(peers).map(function (id) { return peers[id] }).filter(function (p) { return p.port })
          await Promise.all(list.map(async function (p) {
            try {
              const res = await httpGetJson(peerUrl(p) + '/api/peer/lobby', null, 2000)
              if (res && res.ok && res.rooms) {
                out.push({ peer: { id: p.id, name: p.name, addr: p.addr, port: p.port }, rooms: res.rooms })
              }
            } catch (e) { /* 不可达忽略 */ }
          }))
          return out
        },
        // 加入远程房间：按 code 找到持有实例并转发
        remoteJoin: async function (code, player) {
          const peer = await remoteFind(code)
          if (!peer) return { error: '远程房间不存在或不可达' }
          try {
            const res = await httpGetJson(peerUrl(peer) + '/api/peer/join', { code: code, playerId: player.id, name: player.name }, 3000)
            return res || { error: '无响应' }
          } catch (e) {
            return { error: '远程实例不可达: ' + String(e && e.message || e) }
          }
        },
        // 远程落子
        remoteMove: async function (code, playerId, move) {
          const peer = await remoteFind(code)
          if (!peer) return { error: '远程房间不存在或不可达' }
          try {
            const res = await httpGetJson(peerUrl(peer) + '/api/peer/move', { code: code, playerId: playerId, move: move }, 3000)
            return res || { error: '无响应' }
          } catch (e) {
            return { error: '远程实例不可达: ' + String(e && e.message || e) }
          }
        },
        // 远程退出
        remoteLeave: async function (code, playerId) {
          const peer = await remoteFind(code)
          if (!peer) return { ok: true }
          try {
            await httpGetJson(peerUrl(peer) + '/api/peer/leave', { code: code, playerId: playerId }, 3000)
          } catch (e) { /* ignore */ }
          return { ok: true }
        },
        dispose: function () {
          try { announceTimer() } catch (e) { /* ignore */ }
          try { udp.close() } catch (e) { /* ignore */ }
          try { peerServer.close() } catch (e) { /* ignore */ }
        }
      }
    } catch (e) {
      console.log('gamehub: P2P 不可用（' + String(e && e.message || e) + '）')
      p2p = null
    }
    if (p2p) {
      ctx.effect(function () {
        return p2p.dispose
      })
    }

    // ---- 独立页面 ----
    if (webServer) {
      // 先清掉历史/旧实例占用的路由（进程级共享表），再注册，避免 duplicate
      try {
        const exact = webServer.exact
        if (exact && typeof exact.delete === 'function') {
          exact.delete('/api/gamehub/lobby')
          exact.delete('/api/gamehub/room')
          exact.delete('/api/gamehub/peers')
          exact.delete('/api/gamehub/create')
          exact.delete('/api/gamehub/join')
          exact.delete('/api/gamehub/quick')
          exact.delete('/api/gamehub/move')
          exact.delete('/api/gamehub/leave')
          exact.delete('/api/gamehub/games')
          exact.delete('/api/gamehub/share')
          exact.delete('/api/gamehub/setName')
          exact.delete('/gamehub')
        }
      } catch (e) { /* ignore */ }
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/gamehub',
        handler: function (req, res) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(GAMEHUB_PAGE)
        }
      }))
    }

    // ---------- HTTP API（只读 + 可写，全部校验） ----------
    if (webServer) {
      const respondJson = function (res, data, status) {
        res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify(data))
      }
      const parseQuery = function (req) {
        const raw = String(req.url || '')
        const qi = raw.indexOf('?')
        const qs = qi >= 0 ? raw.slice(qi + 1) : ''
        const out = {}
        qs.split('&').forEach(function (part) {
          const eq = part.indexOf('=')
          if (eq <= 0) return
          out[part.slice(0, eq)] = part.slice(eq + 1)
        })
        return out
      }
      const readBody = function (req) {
        return new Promise(function (resolve) {
          let data = ''
          req.on('data', function (c) {
            data += c
            if (data.length > 65536) { req.destroy(); resolve({}) }
          })
          req.on('end', function () {
            try { resolve(JSON.parse(data || '{}')) } catch (e) { resolve({}) }
          })
          req.on('error', function () { resolve({}) })
        })
      }

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/setName',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const pid = sanitizePlayerId(body && body.playerId)
          const nm = sanitizeName((body && body.name) || '玩家')
          if (!pid) return respondJson(res, { ok: false, error: '缺少 playerId' }, 400)
          await mutateLobby(function (lobby) {
            lobby.players[pid] = { name: nm, updatedAt: Date.now() }
          })
          respondJson(res, { ok: true, name: nm })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/games',
        handler: function (req, res) {
          respondJson(res, { ok: true, games: Object.keys(GAMES).map(function (id) {
            const g = GAMES[id]
            return { id: id, name: g.name, icon: g.icon, desc: g.desc, kind: g.kind, rounds: g.rounds, maxPlayers: g.maxPlayers, moveLabels: g.moveLabels }
          }) })
        }
      }))

      // 大厅：本地等待房间 + 远程实例的等待房间
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/lobby',
        handler: async function (req, res) {
          const lobby = await readLobby()
          const rooms = Object.keys(lobby.rooms).map(function (code) {
            const r = lobby.rooms[code]
            return { code: r.code, game: r.game, gameName: GAMES[r.game].name, gameIcon: GAMES[r.game].icon, status: r.status, players: r.players.map(function (p) { return { name: p.name, isBot: !!p.isBot } }) }
          })
          let remote = []
          if (p2p) {
            try { remote = await p2p.remoteRooms() } catch (e) { remote = [] }
          }
          respondJson(res, { ok: true, rooms: rooms, remotePeers: remote })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/room',
        handler: async function (req, res) {
          const q = parseQuery(req)
          const code = String(q.code || '').toUpperCase()
          if (!CODE_RE.test(code)) return respondJson(res, { ok: false, error: '房间号格式错误' }, 400)
          const lobby = await readLobby()
          const room = lobby.rooms[code]
          if (!room) return respondJson(res, { ok: false, error: '房间不存在' }, 404)
          respondJson(res, { ok: true, room: roomView(room, sanitizePlayerId(q.playerId) || null), share: sharePayload(room) })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/share',
        handler: async function (req, res) {
          const q = parseQuery(req)
          const code = String(q.code || '').toUpperCase()
          if (!CODE_RE.test(code)) return respondJson(res, { ok: false, error: '房间号格式错误' }, 400)
          const lobby = await readLobby()
          const room = lobby.rooms[code]
          if (!room) return respondJson(res, { ok: false, error: '房间不存在' }, 404)
          respondJson(res, { ok: true, share: sharePayload(room) })
        }
      }))

      // 在线实例发现：本地实例信息 + 发现的 peers
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/peers',
        handler: async function (req, res) {
          const self = p2p ? { id: p2p.id, name: p2p.name(), addr: p2p.lanIp, port: p2p.port(), local: true } : null
          const peerList = p2p ? p2p.peers() : []
          respondJson(res, { ok: true, self: self, peers: peerList })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/create',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const gameId = GAMES[body && body.game] ? body.game : ''
          if (!gameId) return respondJson(res, { ok: false, error: '未知游戏' }, 400)
          const player = playerOf(body)
          const withBot = !!(body && body.withBot)
          let out = null
          await mutateLobby(function (lobby) {
            lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
            out = createRoom(lobby, gameId, player, withBot)
          })
          if (!out || out.error) return respondJson(res, { ok: false, error: (out && out.error) || '创建失败' }, 400)
          respondJson(res, { ok: true, code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/join',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const code = sanitizeCode(body && body.code)
          if (!code) return respondJson(res, { ok: false, error: '房间号格式错误' }, 400)
          const player = playerOf(body)
          let out = null
          await mutateLobby(function (lobby) {
            lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
            out = joinRoom(lobby, code, player)
          })
          if (!out || out.error) {
            // 本地没有 → 尝试远程实例
            if (p2p && out && out.error === '房间不存在或已过期') {
              const remote = await p2p.remoteJoin(code, player)
              if (remote && remote.ok) return respondJson(res, remote)
              if (remote && remote.error) return respondJson(res, { ok: false, error: remote.error }, 404)
            }
            return respondJson(res, { ok: false, error: (out && out.error) || '加入失败' }, 400)
          }
          respondJson(res, { ok: true, code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/quick',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const gameId = GAMES[body && body.game] ? body.game : ''
          if (!gameId) return respondJson(res, { ok: false, error: '未知游戏' }, 400)
          const player = playerOf(body)
          let out = null
          await mutateLobby(function (lobby) {
            lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
            out = quickMatch(lobby, gameId, player)
          })
          if (!out || out.error) return respondJson(res, { ok: false, error: (out && out.error) || '匹配失败' }, 400)
          respondJson(res, { ok: true, code: out.room.code, room: roomView(out.room, player.id), share: sharePayload(out.room) })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/move',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const code = sanitizeCode(body && body.code)
          if (!code) return respondJson(res, { ok: false, error: '房间号格式错误' }, 400)
          const pid = sanitizePlayerId(body && body.playerId)
          if (!pid) return respondJson(res, { ok: false, error: '缺少玩家身份' }, 400)
          let out = null
          await mutateLobby(function (lobby) {
            out = applyPlayerMove(lobby, code, pid, body && body.move)
          })
          if (!out || out.error) {
            if (p2p && out && out.error === '房间不存在或已过期') {
              const remote = await p2p.remoteMove(code, pid, body && body.move)
              if (remote && remote.ok) return respondJson(res, remote)
              if (remote && remote.error) return respondJson(res, { ok: false, error: remote.error }, 404)
            }
            return respondJson(res, { ok: false, error: (out && out.error) || '落子失败' }, 400)
          }
          respondJson(res, { ok: true, room: out.room })
        }
      }))

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/gamehub/leave',
        handler: async function (req, res) {
          if (req.method !== 'POST') return respondJson(res, { ok: false, error: '需要 POST' }, 405)
          const body = await readBody(req)
          const code = sanitizeCode(body && body.code)
          const pid = sanitizePlayerId(body && body.playerId)
          if (p2p && !(await readLobby()).rooms[code]) {
            await p2p.remoteLeave(code, pid)
            return respondJson(res, { ok: true })
          }
          await mutateLobby(function (lobby) { leaveRoom(lobby, code, pid) })
          respondJson(res, { ok: true })
        }
      }))
    }

    // ---------- model-visible tool ----------
    const agentId = 'agent-' + Math.random().toString(36).slice(2, 8)
    const gameTool = {
      name: 'game_hub',
      description: '博弈小屋：创建博弈游戏房间、快速匹配、加入房间、查询房间状态、以 AI 身份落子。支持局域网 P2P：可发现同一局域网内其他在线实例并加入其房间。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'quick', 'join', 'list', 'state', 'move', 'share', 'peers'], description: '操作：create 创建房间(可选 withBot)，quick 快速匹配，join 按房间号加入（本地或局域网远程），list 列出本地+远程房间，state 查看房间状态，move 落子，share 生成邀请文本，peers 查看局域网在线实例' },
          game: { type: 'string', enum: ['rps', 'pd', 'ttt', 'gongyu'], description: '游戏：rps=石头剪刀布, pd=囚徒困境, ttt=井字棋, gongyu=共鱼(4人鱼塘博弈)' },
          code: { type: 'string', description: '房间号（join/state/move/share 需要，4位大写字母数字）' },
          move: { type: 'string', description: '落子：rps=rock/paper/scissors，pd=cooperate/defect，ttt=0-8 格编号，gongyu 捕鱼阶段=1/2/3、惩罚阶段=skip 或目标玩家id' },
          withBot: { type: 'boolean', description: '创建房间时是否带 AI 陪练（共鱼会补 3 个 AI，默认 false）' },
          name: { type: 'string', description: '玩家昵称（默认 AI玩家，最长16字符）' }
        },
        required: ['action']
      },
      output: {
        schema: { type: 'object' },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
      },
      execute: async function (args) {
        const action = args && args.action
        const player = { id: agentId, name: sanitizeName((args && args.name) || 'AI玩家') }
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
            const code = sanitizeCode(args && args.code)
            if (!code) return { ok: false, error: '房间号格式错误（4位大写字母数字）' }
            let out = null
            await mutateLobby(function (lobby) {
              lobby.players[player.id] = { name: player.name, updatedAt: Date.now() }
              out = joinRoom(lobby, code, player)
            })
            if (!out || out.error) {
              if (p2p && out && out.error === '房间不存在或已过期') {
                const remote = await p2p.remoteJoin(code, player)
                if (remote && remote.ok) return { ok: true, code: code, room: remote.room, share: remote.share }
                if (remote && remote.error) return { ok: false, error: remote.error }
              }
              return { ok: false, error: (out && out.error) || '加入失败' }
            }
            return { ok: true, code: out.room.code, room: roomView(out.room, player.id) }
          }
          if (action === 'list') {
            const lobby = await readLobby()
            const local = Object.keys(lobby.rooms).map(function (code) {
              const r = lobby.rooms[code]
              return { code: r.code, game: r.game, gameName: GAMES[r.game].name, status: r.status, players: r.players.map(function (p) { return { name: p.name, isBot: !!p.isBot } }) }
            })
            let remote = []
            if (p2p) {
              try { remote = await p2p.remoteRooms() } catch (e) { remote = [] }
            }
            return { ok: true, rooms: local, remoteRooms: remote }
          }
          if (action === 'peers') {
            if (!p2p) return { ok: true, p2p: false, error: '此实例未启用 P2P（preset 环境）' }
            return { ok: true, p2p: true, self: { id: p2p.id, name: p2p.name(), addr: p2p.lanIp, port: p2p.port() }, peers: p2p.peers(), remoteRooms: await p2p.remoteRooms() }
          }
          if (action === 'state') {
            const code = sanitizeCode(args && args.code)
            const lobby = await readLobby()
            const room = lobby.rooms[code]
            if (!room) return { ok: false, error: '房间不存在' }
            return { ok: true, room: roomView(room, player.id) }
          }
          if (action === 'move') {
            const code = sanitizeCode(args && args.code)
            let out = null
            await mutateLobby(function (lobby) {
              out = applyPlayerMove(lobby, code, player.id, args && args.move)
            })
            if (!out || out.error) {
              if (p2p && out && out.error === '房间不存在或已过期') {
                const remote = await p2p.remoteMove(code, player.id, args && args.move)
                if (remote && remote.ok) return { ok: true, room: remote.room }
                if (remote && remote.error) return { ok: false, error: remote.error }
              }
              return { ok: false, error: (out && out.error) || '落子失败' }
            }
            return { ok: true, room: out.room }
          }
          if (action === 'share') {
            const code = sanitizeCode(args && args.code)
            const lobby = await readLobby()
            const room = lobby.rooms[code]
            if (!room) return { ok: false, error: '房间不存在' }
            return { ok: true, share: sharePayload(room) }
          }
          return { ok: false, error: '未知操作: ' + action }
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) }
        }
      }
    }

    // preset 环境没有 harness，直接用 tools 注册表
    const tools = ctx.get('tools')
    if (tools) {
      ctx.effect(() => tools.register(gameTool))
    }
  }
}
