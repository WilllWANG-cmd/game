/* ========================================================================
   像素城市求生  Pixel City Survival
   一款 2D 像素末日生存游戏（Electron 桌面应用）
   ======================================================================== */

(() => {
  'use strict';

  // ---------- 基础常量 ----------
  const TILE = 16;            // 一个图块的内部分辨率
  const VIEW_W = 640;
  const VIEW_H = 480;
  const VIEW_TW = VIEW_W / TILE; // 40
  const VIEW_TH = VIEW_H / TILE; // 30

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // ---------- 输入 ----------
  const keys = {};
  let keyPressed = {}; // 单次按下
  function anyDialogOpen() { return namingPending || joinPending || hostNamePending; }
  window.addEventListener('keydown', (e) => {
    // 任何对话框打开时，把按键完全交给输入框
    if (anyDialogOpen()) { return; }
    if (e.code === 'F3') { party.debugHud = !party.debugHud; e.preventDefault(); return; }
    // F12 由主进程拦截并通过 dev:toggle IPC 通知，这里不再处理
    const firstPress = !keys[e.code];
    if (firstPress) keyPressed[e.code] = true;
    keys[e.code] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    // 客户端边沿输入缓冲：interact / useItem 是"按一次"的边沿触发，
    // 但 keyPressed 每帧被清空、clientTick 每 33ms 才发一次，会丢按键。
    // 只在首次按下时写缓冲（排除按键自动重复），clientTick 发送时再读走并清空。
    if (firstPress && state === 'PLAYING' && game && game.netMode === 'client') {
      if (e.code === 'KeyE' || e.code === 'KeyF') party._edgeInteract = true;
      else if (e.code === 'Digit1') party._edgeUseItem = 'medkit';
      else if (e.code === 'Digit2') party._edgeUseItem = 'bandage';
      else if (e.code === 'Digit3') party._edgeUseItem = 'canned';
      else if (e.code === 'Digit4') party._edgeUseItem = 'water';
    }
  });
  window.addEventListener('keyup', (e) => {
    if (anyDialogOpen()) return;
    keys[e.code] = false;
  });

  // ---------- 鼠标 ----------
  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (VIEW_W / rect.width);
    const y = (e.clientY - rect.top) * (VIEW_H / rect.height);
    return { x, y };
  }
  // 全局鼠标位置（画布内部坐标），用于瞄准
  let mousePos = { x: VIEW_W/2, y: VIEW_H/2 };
  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = canvasPoint(e);
    mousePos = { x, y };
    if (state !== 'SAVES') { saveHover = -1; return; }
    saveHover = saveRowAt(x, y);
  });
  canvas.addEventListener('click', (e) => {
    if (namingPending) return; // 命名对话框打开时不响应画布点击
    const { x, y } = canvasPoint(e);
    handleClick(x, y);
  });

  // ---------- 工具 ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b));
  const choice = (arr) => arr[randi(0, arr.length)];
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx*dx + dy*dy; };

  // ---------- 颜色调板 ----------
  const PAL = {
    asphalt: '#2a2a33',
    asphalt2: '#222229',
    road: '#3a3a44',
    roadLine: '#8a8a3a',
    sidewalk: '#5a5a64',
    grass: '#2c4a2a',
    grassDark: '#1e3a1e',
    buildingWall: '#4a4a5a',
    buildingWall2: '#3e3e4e',
    buildingWin: '#1a2233',
    buildingWinLit: '#7a8a4a',
    door: '#6a3a1a',
    doorFrame: '#3a1a0a',
    interiorFloor: '#6a5a4a',
    interiorFloor2: '#5a4a3a',
    interiorWall: '#3a3a44',
    interiorWall2: '#2a2a34',
    stair: '#8a8a8a',
    stairDark: '#5a5a5a',
    blood: '#8a1a1a',
    ui: '#d0d0e0',
    uiDim: '#707080',
    uiBg: 'rgba(10,10,18,0.85)',
    danger: '#d04040',
    heal: '#40d070',
    fog: '#9aa0b0'
  };

  // ---------- 物品类型 ----------
  const ITEMS = {
    medkit:    { name: '医疗包', heal: 50, color: '#f0f0f0', sym: '✚', stack: 5 },
    canned:    { name: '罐头',   heal: 15, color: '#c08030', sym: '▤', stack: 10 },
    water:     { name: '矿泉水', heal: 10, color: '#4090d0', sym: '◉', stack: 10 },
    bandage:   { name: '绷带',   heal: 20, color: '#e0e0c0', sym: '◑', stack: 8 },
    ammo:      { name: '子弹',   heal: 0,  color: '#d0a030', sym: '⁝', stack: 99, kind: 'ammo' },
  };

  // ---------- 怪物类型 ----------
  const MON = {
    zombie: {
      name: '僵尸', hp: 30, speed: 0.45, dmg: 8, atkRange: 38, atkCd: 700,
      xp: 10, color: '#5a7a3a', color2: '#3a5a2a', eye: '#d04040'
    },
    fogman: {
      name: '雾中人', hp: 22, speed: 1.1, dmg: 14, atkRange: 22, atkCd: 500,
      xp: 20, color: '#9aa0b0', color2: '#6a7080', eye: '#e0e0f0', fog: true
    }
  };
  // 僵尸衣着调色板（每只僵尸随机一种，让群体看起来穿着不同）
  const ZOMBIE_CLOTHES = ['#5a3a2a','#3a3a4a','#4a3a5a','#6a4a2a','#2a4a4a','#5a4a3a','#7a3a3a','#3a4a3a','#4a2a2a','#3a3a2a'];

  // ====================================================================
  //  世界生成
  // ====================================================================

  // 城市地图：tile 类型
  // 0 路面 / 1 人行道 / 2 草地 / 3 楼房外墙(不可进) / 4 楼房门(可进) / 5 玩家所在楼入口
  function generateCity(seed) {
    const W = 80, H = 60;
    const map = new Uint8Array(W * H);
    const buildings = [];

    // 用简单 seeded random —— 城市生成必须完全由 seed 决定，否则读档后地图变了会卡墙
    let s = (seed | 0) || 1;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const srandi = (a, b) => Math.floor(a + rng() * (b - a));
    const schoice = (arr) => arr[Math.floor(rng() * arr.length)];

    // 先全部填路面
    map.fill(0);

    // 横纵街道
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // 街区划分：每 16 个 tile 一块，外圈是人行道
        const bx = x % 16, by = y % 12;
        if (bx === 0 || by === 0) {
          map[y*W+x] = 1; // 人行道
        }
      }
    }

    // 在每个街区里放置 1-2 个建筑
    const blockCols = Math.floor(W / 16);
    const blockRows = Math.floor(H / 12);
    let homePlaced = false;
    let bidx = 0;
    for (let byi = 0; byi < blockRows; byi++) {
      for (let bxi = 0; bxi < blockCols; bxi++) {
        const ox = bxi * 16 + 1;
        const oy = byi * 12 + 1;
        const bw = srandi(7, 14);
        const bh = srandi(6, 10);
        if (ox + bw > bxi*16 + 15 || oy + bh > byi*12 + 11) continue;

        const id = 'b' + (bidx++);
        const isHome = !homePlaced && (bxi === Math.floor(blockCols/2)) && (byi === Math.floor(blockRows/2));
        if (isHome) homePlaced = true;

        const building = {
          id, x: ox, y: oy, w: bw, h: bh,
          kind: isHome ? 'home' : schoice(['zombie','fog','zombie','fog','mixed']),
          floors: isHome ? 3 : srandi(2, 5),
          looted: {},     // floorIdx -> bool
          cleared: {},    // floorIdx -> bool
          isHome
        };
        buildings.push(building);

        // 画墙
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            map[(oy+yy)*W + (ox+xx)] = 3;
          }
        }
        // 门：底边中间
        const dx = ox + Math.floor(bw/2);
        const dy = oy + bh - 1;
        map[dy*W + dx] = isHome ? 5 : 4;
        building.door = { x: dx, y: dy };
      }
    }

    // 兜底：若 home 没被放置（极少），把第一个楼设为 home
    if (!homePlaced && buildings.length > 0) {
      const b = buildings[0];
      b.kind = 'home'; b.isHome = true; b.floors = 3;
      map[b.door.y * W + b.door.x] = 5;
    }

    return { W, H, map, buildings, seed };
  }

  // 建筑内部：一层楼。返回 tile 网格与实体列表
  // tile: 0 地板 / 1 墙 / 2 楼梯上 / 3 楼梯下 / 4 出口门(到城市)
  function generateFloor(building, floorIdx, isHome, cleared) {
    const W = 24, H = 18;
    const map = new Uint8Array(W * H);
    // 外圈墙
    for (let x = 0; x < W; x++) { map[x] = 1; map[(H-1)*W+x] = 1; }
    for (let y = 0; y < H; y++) { map[y*W] = 1; map[y*W+(W-1)] = 1; }
    // 内部地板
    for (let y = 1; y < H-1; y++)
      for (let x = 1; x < W-1; x++)
        map[y*W+x] = 0;

    // 随机房间隔断
    const rng = Math.random;
    const walls = [];
    // 几道竖墙
    const vCount = randi(1, 3);
    for (let i = 0; i < vCount; i++) {
      const wx = randi(6, W-6);
      const wy0 = 1;
      const wy1 = randi(Math.floor(H/2), H-2);
      for (let y = wy0; y <= wy1; y++) {
        if (rng() > 0.2) map[y*W+wx] = 1;
      }
      // 留一个开口
      const gap = randi(wy0+1, wy1-1);
      map[gap*W+wx] = 0;
    }
    const hCount = randi(1, 3);
    for (let i = 0; i < hCount; i++) {
      const wy = randi(5, H-5);
      const wx0 = 1;
      const wx1 = randi(Math.floor(W/2), W-2);
      for (let x = wx0; x <= wx1; x++) {
        if (rng() > 0.2) map[wy*W+x] = 1;
      }
      const gap = randi(wx0+1, wx1-1);
      map[wy*W+gap] = 0;
    }

    // 出口门：底边中间 -> 回到城市
    const ex = Math.floor(W/2);
    map[(H-1)*W + ex] = 4;

    // 楼梯
    if (floorIdx < building.floors - 1) {
      // 楼梯上：放在右上角附近
      let sx = W - 3, sy = 2;
      map[sy*W+sx] = 2;
    }
    if (floorIdx > 0) {
      // 楼梯下：放在左上角附近
      let sx = 2, sy = 2;
      map[sy*W+sx] = 3;
    }

    // 物品点 —— 保证每层都有物资
    const items = [];
    if (!cleared) {
      // 先收集所有可行走的地板格，确保一定能放下物资
      const floorTiles = [];
      for (let y = 2; y < H-2; y++) {
        for (let x = 2; x < W-2; x++) {
          if (map[y*W+x] === 0) floorTiles.push([x, y]);
        }
      }
      // 打乱
      for (let i = floorTiles.length - 1; i > 0; i--) {
        const j = randi(0, i + 1);
        [floorTiles[i], floorTiles[j]] = [floorTiles[j], floorTiles[i]];
      }
      const itemCount = Math.min(
        floorTiles.length,
        isHome ? randi(3, 5) : randi(3, 6)
      );
      const kinds = isHome
        ? ['medkit','canned','water','bandage','medkit']
        : ['canned','water','bandage','medkit','ammo','ammo','canned'];
      for (let i = 0; i < itemCount; i++) {
        const [tx, ty] = floorTiles[i];
        const k = choice(kinds);
        items.push({ x: tx*TILE + TILE/2, y: ty*TILE + TILE/2, type: k, taken: false });
      }
    }

    // 怪物（非 home 楼）
    const monsters = [];
    if (!isHome && !cleared) {
      const mCount = (building.kind === 'fog') ? randi(2, 4)
                   : (building.kind === 'zombie') ? randi(3, 6)
                   : randi(2, 5);
      for (let i = 0; i < mCount; i++) {
        let tx, ty, tries = 0;
        do {
          tx = randi(3, W-3); ty = randi(3, H-3); tries++;
        } while (map[ty*W+tx] !== 0 && tries < 40);
        if (map[ty*W+tx] !== 0) continue;
        const kind = (building.kind === 'fog') ? 'fogman'
                   : (building.kind === 'zombie') ? 'zombie'
                   : choice(['zombie','fogman']);
        monsters.push(makeMonster(kind, tx*TILE + TILE/2, ty*TILE + TILE/2));
      }
    }

    return { W, H, map, items, monsters, floorIdx };
  }

  function makeMonster(kind, x, y) {
    const m = MON[kind];
    return {
      kind, x, y, hp: m.hp, maxHp: m.hp,
      vx: 0, vy: 0,
      lastAtk: 0, hurtFlash: 0,
      wanderTx: x, wanderTy: y, nextWander: 0,
      alive: true,
      // 渲染用：衣着、朝向、走路相位、扑咬方向
      clothColor: choice(ZOMBIE_CLOTHES),
      facing: 2,           // 1 左 2 右
      walkPhase: Math.random() * 6,
      atkDx: 0, atkDy: 1,   // 最近一次攻击的方向（朝向玩家）
      atkDist: 0,           // 最近一次攻击时到玩家的距离（扑出刚好落到玩家位置）
      pouncing: false,      // 这一轮是否在"扑"过来（贴身啃食时为 false，不跳不前扑）
      atkSpread: Math.random() * 2 - 1   // 扑咬落点的侧向偏移，让多只僵尸围在玩家周围不同位置，不重叠
    };
  }

  // ====================================================================
  //  游戏状态
  // ====================================================================

  let state = 'MENU';   // MENU / SAVES / NAMING / PLAYING / PAUSED / DEAD
  let game = null;      // 当前对局
  let menuSel = 0;
  let savesList = [];
  let saveCursor = 0;
  let saveHover = -1;
  let toast = null;     // {text, until}
  let lastTime = 0;
  let playtimeAcc = 0;
  let devMode = false;  // 开发者模式：仅存档内（single 模式 PLAYING 中）按 F12 切换

  // ---------- 命名对话框 ----------
  const nameDialog = document.getElementById('nameDialog');
  const nameInput = document.getElementById('nameInput');
  const nameOk = document.getElementById('nameOk');
  const nameCancel = document.getElementById('nameCancel');
  let namingPending = false; // 是否正在等待命名
  let namingReturnState = 'MENU';

  function openNameDialog() {
    namingPending = true;
    namingReturnState = state;
    state = 'NAMING';
    nameInput.value = '';
    nameDialog.classList.remove('hidden');
    // 默认填充一个建议名
    nameInput.placeholder = '输入存档名（可中文），默认：幸存者' + randi(100, 999);
    setTimeout(() => nameInput.focus(), 0);
  }
  function closeNameDialog() {
    namingPending = false;
    nameDialog.classList.add('hidden');
    nameInput.blur();
  }
  function confirmName() {
    if (!namingPending) return;
    let name = (nameInput.value || '').trim();
    if (!name) name = '幸存者' + randi(100, 999);
    name = name.slice(0, 16);
    closeNameDialog();
    newGame(name);
    game.createdAt = Date.now();
    saveGame();
  }
  function cancelName() {
    if (!namingPending) return;
    closeNameDialog();
    state = namingReturnState;
  }
  nameOk.addEventListener('click', confirmName);
  nameCancel.addEventListener('click', cancelName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmName(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelName(); }
  });
  // 点击对话框背景不触发画布点击：阻止冒泡
  nameDialog.addEventListener('click', (e) => e.stopPropagation());

  // ====================================================================
  //  派对 / 联机
  // ====================================================================
  const joinDialog = document.getElementById('joinDialog');
  const joinInput = document.getElementById('joinInput');
  const joinOk = document.getElementById('joinOk');
  const joinCancel = document.getElementById('joinCancel');
  const hostNameDialog = document.getElementById('hostNameDialog');
  const hostNameInput = document.getElementById('hostNameInput');
  const hostNameOk = document.getElementById('hostNameOk');
  const hostNameCancel = document.getElementById('hostNameCancel');

  // 派对运行时状态（渲染端）
  const party = {
    role: null,            // 'host' | 'client'
    code: null, addr: null,
    hostName: null, myName: null,
    myClientId: null,
    stateInfo: null,       // 来自 party:state 的信息（公网IP等）
    lobbyPlayers: [],      // [{id, name, isHost}]
    clientInputs: {},      // 主机端：clientId -> 最新输入
    discoverList: [],
    discoverTimer: 0,
    broadcastAcc: 0,       // 主机广播累计
    inputSendAcc: 0,       // 客户端发送输入累计
    lastSentSceneKey: null, // 用于只在场景变化时发送地图
    // 客户端边沿输入缓冲：keydown 写入，clientTick 发送后清空。
    // 避免 keyPressed 每帧被清空、而 clientTick 每 33ms 才发一次导致的边沿按键丢失。
    _edgeInteract: false,
    _edgeUseItem: null
  };
  let joinPending = false;
  let hostNamePending = false;

  function openJoinDialog() {
    joinPending = true;
    state = 'JOINING';
    joinInput.value = '';
    joinDialog.classList.remove('hidden');
    setTimeout(() => joinInput.focus(), 0);
  }
  function closeJoinDialog() {
    joinPending = false;
    joinDialog.classList.add('hidden');
    joinInput.blur();
  }
  async function confirmJoin() {
    if (!joinPending) return;
    const v = (joinInput.value || '').trim();
    if (!v) return;
    closeJoinDialog();
    // 判断是地址（含冒号）还是派对码
    let args;
    if (v.includes(':')) args = { addr: v };
    else args = { code: v.toUpperCase() };
    args.name = party.myName || ('玩家' + randi(100,999));
    toastMsg('正在连接...', 1500);
    const r = await window.api.partyJoin(args);
    if (!r.ok) { toastMsg('加入失败：' + (r.error || ''), 3500); state = 'PARTY'; return; }
    party.role = 'client';
    state = 'CLIENT_LOBBY';
    toastMsg('已连接，等待主机开始游戏', 2000);
  }
  joinOk.addEventListener('click', confirmJoin);
  joinCancel.addEventListener('click', () => { closeJoinDialog(); state = 'PARTY'; });
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmJoin(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeJoinDialog(); state = 'PARTY'; }
  });
  joinDialog.addEventListener('click', (e) => e.stopPropagation());

  function openHostNameDialog() {
    hostNamePending = true;
    state = 'HOST_NAMING';
    hostNameInput.value = '';
    hostNameDialog.classList.remove('hidden');
    setTimeout(() => hostNameInput.focus(), 0);
  }
  function closeHostNameDialog() {
    hostNamePending = false;
    hostNameDialog.classList.add('hidden');
    hostNameInput.blur();
  }
  async function confirmHostName() {
    if (!hostNamePending) return;
    let name = (hostNameInput.value || '').trim() || ('玩家' + randi(100,999));
    name = name.slice(0, 12);
    closeHostNameDialog();
    party.myName = name;
    toastMsg('正在创建派对...', 1500);
    const r = await window.api.partyHostStart({ name });
    if (!r.ok) { toastMsg('创建失败：' + (r.error || ''), 3000); state = 'PARTY'; return; }
    party.role = 'host';
    party.code = r.data.code;
    party.addr = r.data.lanIp + ':' + r.data.port;
    party.lobbyPlayers = [{ id: 0, name: name, isHost: true }];
    state = 'HOST_LOBBY';
    toastMsg('派对已创建！把派对码或地址发给朋友', 3000);
    // 拉取一次状态（公网IP可能还在获取）
    refreshPartyState();
  }
  hostNameOk.addEventListener('click', confirmHostName);
  hostNameCancel.addEventListener('click', () => { closeHostNameDialog(); state = 'PARTY'; });
  hostNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmHostName(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeHostNameDialog(); state = 'PARTY'; }
  });
  hostNameDialog.addEventListener('click', (e) => e.stopPropagation());

  async function refreshPartyState() {
    if (!window.api || !window.api.partyState) return;
    try { party.stateInfo = await window.api.partyState(); } catch {}
  }

  async function refreshDiscover() {
    if (!window.api || !window.api.partyDiscover) return;
    try { party.discoverList = await window.api.partyDiscover(); } catch {}
  }

  async function leaveParty() {
    if (window.api && window.api.partyLeave) {
      try { await window.api.partyLeave(); } catch {}
    }
    party.role = null;
    party.code = null; party.addr = null;
    party.lobbyPlayers = [];
    party.clientInputs = {};
    party.myClientId = null;
  }

  // 派对事件订阅
  let _partyUnsub = null;
  function attachPartyEvents() {
    if (_partyUnsub || !window.api || !window.api.onPartyEvent) return;
    _partyUnsub = window.api.onPartyEvent((evt) => onPartyEvent(evt));
  }

  function onPartyEvent(evt) {
    if (!evt) return;
    switch (evt.type) {
      case 'welcome':
        party.myClientId = evt.clientId;
        party.hostName = evt.hostName;
        break;
      case 'lobby':
        party.lobbyPlayers = evt.players || [];
        break;
      case 'client-join':
        if (party.role === 'host') {
          // 游戏进行中：为新加入的客户端建立 avatar，放到城市出生点。
          // 注意：client-join 事件在 lobby 事件之前到达，此时 party.lobbyPlayers 还没更新，
          // 所以必须用 evt 自带的 id/name，不能去 lobbyPlayers 里查（否则查不到，avatar 不会建）。
          if (game && game.netMode === 'host') {
            if (!game.remotePlayers.some(r => r.id === evt.id)) {
              const rp = makePlayerEntity(evt.name || ('玩家' + evt.id), evt.id, false);
              rp.scene = 'city'; rp.curBuilding = null; rp.curFloor = 0;
              const home = game.city.buildings.find(b => b.isHome) || game.city.buildings[0];
              const cityBundle = ensureCityScene();
              activateScene(cityBundle);
              placePlayerNear(rp, home.door.x * TILE + TILE/2, (home.door.y + 2) * TILE + TILE/2);
              game.remotePlayers.push(rp);
              syncBundle(cityBundle);
              activateScene(sceneOf(game.player));
              // 关键：游戏已开始时，主机不会再次广播 start，必须单独补发给迟到客户端，
              // 否则客户端永远停在 CLIENT_LOBBY，不发输入（表现为联机卡住、avatar 站在出生点不动）。
              if (window.api && window.api.partyHostSendTo) {
                window.api.partyHostSendTo(evt.id, {
                  type: 'start',
                  seed: game.seed,
                  yourId: evt.id,
                  hostName: party.myName || '主机',
                  players: party.lobbyPlayers
                });
              }
            }
          }
        }
        break;
      case 'client-leave':
        if (party.role === 'host' && game && game.netMode === 'host') {
          game.remotePlayers = (game.remotePlayers || []).filter(rp => rp.id !== evt.id);
          if (party.clientInputs) delete party.clientInputs[evt.id];
        }
        break;
      case 'client-input':
        party._inputEvents = (party._inputEvents || 0) + 1;
        party.clientInputs[evt.id] = evt.input;
        break;
      case 'start':
        // 客户端：进入游戏
        clientStartGame(evt);
        break;
      case 'snapshot':
        if (party.role === 'client') clientApplySnapshot(evt);
        break;
      case 'toast':
        if (evt.text) toastMsg(evt.text, evt.ms || 2000);
        break;
      case 'kick':
        toastMsg('被请出派对：' + (evt.reason || ''), 3500);
        leaveParty();
        if (state === 'PLAYING') { state = 'MENU'; game = null; }
        else { state = 'MENU'; }
        break;
      case 'disconnected':
        toastMsg('连接断开：' + (evt.reason || '与主机失去连接'), 3500);
        leaveParty();
        if (state === 'PLAYING') { state = 'MENU'; game = null; }
        else if (state === 'CLIENT_LOBBY') { state = 'PARTY'; }
        break;
      case 'left':
        break;
    }
  }

  // ---------- 主机：开始游戏 ----------
  async function hostStartGame() {
    if (party.role !== 'host') return;
    // 用主机名作为存档名
    const seed = (Math.random() * 0x7fffffff) | 0;
    const city = generateCity(seed);
    const home = city.buildings.find(b => b.isHome) || city.buildings[0];
    const hostName = party.myName || '主机';
    const player = makePlayerEntity(hostName, 0, true);
    const stats = { kills: 0, looted: 0, deaths: 0, dmgDealt: 0, dmgTaken: 0 };
    game = {
      id: 'party_' + Date.now().toString(36),
      name: hostName + ' 的派对',
      createdAt: 0, updatedAt: 0, playtime: 0,
      seed, city, player, stats,
      scene: 'city', curBuilding: null, curFloor: 0, floor: null,
      cam: { x: 0, y: 0 },
      cityMonsters: [], nextCitySpawn: 0, fogIntensity: 0,
      bullets: [], cityItems: [],
      netMode: 'host', remotePlayers: [],
      scenes: new Map(),
      needSave: false,
      timeMs: 0
    };
    player.scene = 'city'; player.curBuilding = null; player.curFloor = 0;
    // 玩家放在 home 门口
    const d = home.door;
    player.x = d.x * TILE + TILE/2;
    player.y = (d.y + 2) * TILE + TILE/2;
    // 为每个已连接客户端建立 avatar
    // 从 lobbyPlayers 取（isHost=false 的）
    for (const lp of party.lobbyPlayers) {
      if (lp.isHost) continue;
      const rp = makePlayerEntity(lp.name, lp.id, false);
      rp.scene = 'city'; rp.curBuilding = null; rp.curFloor = 0;
      rp.x = player.x; rp.y = player.y;
      game.remotePlayers.push(rp);
    }
    enterCity();
    // 重新把每个玩家放在 home 门口附近可走格（独立位置，避免重叠/卡墙）
    {
      const cityBundle = ensureCityScene();
      activateScene(cityBundle);
      const ex = d.x * TILE + TILE/2, ey = (d.y + 2) * TILE + TILE/2;
      placePlayerNear(game.player, ex, ey);
      for (const rp of game.remotePlayers) placePlayerNear(rp, ex, ey);
      syncBundle(cityBundle);
    }
    state = 'PLAYING';
    // 通知所有客户端开始
    partyHostBroadcastMsg({
      type: 'start',
      seed, yourId: 0,
      hostName,
      players: party.lobbyPlayers
    });
    toastMsg('游戏开始！', 1500);
    refreshPartyState();
  }

  function makePlayerEntity(name, id, isHost) {
    return {
      id, name, isHost,
      hp: 100, maxHp: 100,
      x: 0, y: 0, facing: 0, walkPhase: 0,
      inv: {}, weapon: 'fists', ammo: 0,
      lastAtk: 0, lastShoot: 0, hurtFlash: 0,
      baseAtk: 12, atkRange: 22, atkCd: 380,
      isLocal: isHost, // 主机端只有 host 是 local
      scene: 'city', curBuilding: null, curFloor: 0
    };
  }

  function partyHostBroadcastMsg(obj) {
    if (window.api && window.api.partyHostBroadcast) {
      window.api.partyHostBroadcast(obj);
    }
  }

  // ---------- 主机：广播快照（按客户端所在场景定向发送） ----------
  function overviewOf(p, isHost) {
    const now = performance.now();
    return {
      id: p.id || 0, name: p.name, isHost,
      x: Math.round(p.x), y: Math.round(p.y),
      hp: p.hp, maxHp: p.maxHp,
      facing: p.facing, aimDx: (p.lastAim||{}).dx || 0, aimDy: (p.lastAim||{}).dy || 0,
      hurtFlash: p.hurtFlash || 0, walkPhase: p.walkPhase || 0,
      ammo: p.ammo || 0, inv: p.inv || {},
      scene: p.scene || 'city',
      curBuildingId: p.curBuilding ? p.curBuilding.id : null,
      curFloor: p.curFloor || 0,
      // 攻击/开枪的"距今毫秒数"，用相对时间避免主客机 performance.now() 时钟不一致。
      // 客户端据此还原 lastAtk/lastShoot，让自己能看到挥拳/开火动画。
      atkAge: p.lastAtk ? Math.min(9999, now - p.lastAtk) : 9999,
      shootAge: p.lastShoot ? Math.min(9999, now - p.lastShoot) : 9999
    };
  }
  function maybeBroadcastSnapshot() {
    party.broadcastAcc += 16; // 近似帧时间
    if (party.broadcastAcc < 50) return; // ~20 次/秒（配合客户端插值，远程玩家更顺滑）
    party.broadcastAcc = 0;
    if (!game || game.netMode !== 'host') return;

    // 全玩家概览（每个客户端都拿得到所有队友的状态，用于 HUD）
    const allOverview = [overviewOf(game.player, true)];
    for (const rp of game.remotePlayers) allOverview.push(overviewOf(rp, false));

    for (const cp of game.remotePlayers) {
      const bundle = sceneOf(cp);
      if (!bundle) continue;
      const key = sceneKeyOf(cp);
      const sceneChanged = (cp._lastSceneKey !== key);
      cp._lastSceneKey = key;
      activateScene(bundle);
      const monsters = currentMonsters().map(m => ({
        kind: m.kind, x: Math.round(m.x), y: Math.round(m.y),
        hp: m.hp, maxHp: m.maxHp, hurtFlash: m.hurtFlash || 0, alive: m.alive,
        clothColor: m.clothColor || null, facing: m.facing || 2,
        walkPhase: m.walkPhase || 0, lastAtk: m.lastAtk || 0,
        atkDx: m.atkDx || 0, atkDy: m.atkDy || 0, atkDist: m.atkDist || 0, pouncing: !!m.pouncing, atkSpread: m.atkSpread || 0
      }));
      let items = [];
      if (game.scene === 'interior') items = game.floor.items.filter(i=>!i.taken).map(i=>({x:i.x,y:i.y,type:i.type}));
      else items = (game.cityItems||[]).filter(i=>!i.taken).map(i=>({x:i.x,y:i.y,type:i.type}));
      const bullets = (game.bullets||[]).map(b => ({x:Math.round(b.x),y:Math.round(b.y),dx:b.dx,dy:b.dy}));
      const snap = {
        type: 'snapshot',
        mySceneKey: key,
        scene: game.scene,
        curBuildingId: game.curBuilding ? game.curBuilding.id : null,
        curFloor: game.curFloor,
        seed: game.seed,
        sceneChanged,
        cityMap: (game.scene === 'city' && sceneChanged) ? Array.from(game.city.map) : null,
        floorMap: (game.scene === 'interior' && sceneChanged) ? Array.from(game.floor.map) : null,
        floorW: game.scene === 'interior' ? game.floor.W : null,
        floorH: game.scene === 'interior' ? game.floor.H : null,
        curBuildingKind: game.curBuilding ? game.curBuilding.kind : null,
        curBuildingIsHome: game.curBuilding ? game.curBuilding.isHome : false,
        curBuildingFloors: game.curBuilding ? game.curBuilding.floors : 0,
        players: allOverview, monsters, items, bullets,
        cityItems: game.scene === 'city' ? items : [],
        fogIntensity: game.fogIntensity || 0,
        stats: { kills: game.stats.kills || 0 }
      };
      if (window.api.partyHostSendTo) window.api.partyHostSendTo(cp.id, snap);
    }
    // 恢复主机场景
    activateScene(sceneOf(game.player));
    // 同步场景标签给发现者
    if (window.api.partyHostSetSceneLabel) {
      window.api.partyHostSetSceneLabel(game.scene === 'city' ? '城市' : '楼内F' + (game.curFloor+1));
    }
  }

  // ---------- 客户端：开始游戏 ----------
  function clientStartGame(evt) {
    const seed = evt.seed;
    const city = generateCity(seed);
    const home = city.buildings.find(b => b.isHome) || city.buildings[0];
    // 找到自己
    const me = (evt.players || []).find(p => p.id === party.myClientId) || { id: party.myClientId, name: party.myName || '玩家' };
    const player = makePlayerEntity(me.name || party.myName || '玩家', me.id, false);
    player.isLocal = true; // 客户端：自己就是本地
    const stats = { kills: 0, looted: 0, deaths: 0, dmgDealt: 0, dmgTaken: 0 };
    game = {
      id: 'party_client_' + Date.now().toString(36),
      name: party.hostName + ' 的派对',
      createdAt: 0, updatedAt: 0, playtime: 0,
      seed, city, player, stats,
      scene: 'city', curBuilding: null, curFloor: 0, floor: null,
      cam: { x: 0, y: 0 },
      cityMonsters: [], nextCitySpawn: 0, fogIntensity: 0,
      bullets: [], cityItems: [],
      netMode: 'client', remotePlayers: [],
      scenes: null, // 客户端不维护 scenes Map，靠快照里的 game.scene/floor
      needSave: false,
      timeMs: 0
    };
    player.scene = 'city'; player.curBuilding = null; player.curFloor = 0;
    const d = home.door;
    player.x = d.x * TILE + TILE/2;
    player.y = (d.y + 2) * TILE + TILE/2;
    game.cityItems = [];
    updateCamera();
    state = 'PLAYING';
    toastMsg('加入派对成功！等待主机带领', 2000);
  }

  // ---------- 客户端：应用快照 ----------
  function clientApplySnapshot(s) {
    if (!game || game.netMode !== 'client') return;
    party._snapCount = (party._snapCount || 0) + 1;
    // 场景/地图
    if (s.scene !== game.scene || (s.sceneChanged && s.cityMap) || (s.sceneChanged && s.floorMap)) {
      if (s.scene === 'city') {
        if (s.cityMap) {
          // 用主机的地图覆盖（与种子重建一致，覆盖以防差异）
          game.city.map = Uint8Array.from(s.cityMap);
        }
        game.scene = 'city';
        game.curBuilding = null; game.floor = null;
      } else {
        // interior
        if (s.floorMap) {
          const fW = s.floorW, fH = s.floorH;
          game.floor = { W: fW, H: fH, map: Uint8Array.from(s.floorMap), items: [], monsters: [] };
        }
        game.scene = 'interior';
        game.curFloor = s.curFloor;
        // 重建 curBuilding 占位（供 HUD 显示）
        if (!game.curBuilding || game.curBuilding.id !== s.curBuildingId) {
          game.curBuilding = game.city.buildings.find(b => b.id === s.curBuildingId) || {
            id: s.curBuildingId, kind: s.curBuildingKind, isHome: s.curBuildingIsHome, floors: s.curBuildingFloors, cleared: {}
          };
        }
      }
    }
    // 怪物
    if (s.scene === 'city') {
      game.cityMonsters = (s.monsters||[]).map(m => ({
        kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp,
        hurtFlash: m.hurtFlash, alive: m.alive !== false,
        lastAtk: m.lastAtk || 0, nextWander: 0, wanderTx: m.x, wanderTy: m.y,
        clothColor: m.clothColor || '#5a3a2a', facing: m.facing || 2,
        walkPhase: m.walkPhase || 0, atkDx: m.atkDx || 0, atkDy: m.atkDy || 0, atkDist: m.atkDist || 0, pouncing: !!m.pouncing, atkSpread: m.atkSpread || 0
      }));
    } else if (game.floor) {
      game.floor.monsters = (s.monsters||[]).map(m => ({
        kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp,
        hurtFlash: m.hurtFlash, alive: m.alive !== false,
        lastAtk: m.lastAtk || 0, nextWander: 0, wanderTx: m.x, wanderTy: m.y,
        clothColor: m.clothColor || '#5a3a2a', facing: m.facing || 2,
        walkPhase: m.walkPhase || 0, atkDx: m.atkDx || 0, atkDy: m.atkDy || 0, atkDist: m.atkDist || 0, pouncing: !!m.pouncing, atkSpread: m.atkSpread || 0
      }));
    }
    // 物品
    const items = (s.items||[]).map(i => ({x:i.x, y:i.y, type:i.type, taken:false}));
    if (s.scene === 'interior' && game.floor) game.floor.items = items;
    else game.cityItems = items;
    // 子弹
    const now = performance.now();
    game.bullets = (s.bullets||[]).map(b => ({x:b.x, y:b.y, dx:b.dx, dy:b.dy, born: now, dmg: 25}));
    // 玩家
    const meId = party.myClientId;
    const players = s.players || [];
    const me = players.find(p => p.id === meId);
    if (me) {
      // 服务器权威：血量/物品/弹药/场景归属/受击闪烁/瞄准/攻击动画都以快照为准
      game.player.hp = me.hp; game.player.maxHp = me.maxHp;
      game.player.hurtFlash = me.hurtFlash;
      game.player.ammo = me.ammo;
      game.player.inv = me.inv || {};
      game.player.lastAim = { dx: me.aimDx, dy: me.aimDy };
      game.player.name = me.name;
      // 用快照里的相对 age 还原本机 lastAtk/lastShoot，让客户端能看到自己挥拳/开火的动画
      const cnow = performance.now();
      game.player.lastAtk = (me.atkAge != null && me.atkAge < 9999) ? (cnow - me.atkAge) : 0;
      game.player.lastShoot = (me.shootAge != null && me.shootAge < 9999) ? (cnow - me.shootAge) : 0;
      // 场景归属（用于 HUD/同场景渲染判断）
      game.player.scene = me.scene || 'city';
      game.player.curFloor = me.curFloor || 0;
      game.player.curBuilding = me.curBuildingId != null
        ? (game.city.buildings.find(b => b.id === me.curBuildingId) || { id: me.curBuildingId, kind: s.curBuildingKind, isHome: s.curBuildingIsHome, floors: s.curBuildingFloors, cleared: {} })
        : null;
      // 位置纠错：本地预测 vs 服务器。偏差小（<1 格）就保留预测位置（更跟手、不抖）；
      // 偏差大（被僵尸击退、碰撞不一致等）才以服务器为准瞬移纠正。facing/walkPhase 保留本地预测值。
      const drift = Math.hypot(me.x - game.player.x, me.y - game.player.y);
      if (drift > 16) { game.player.x = me.x; game.player.y = me.y; }
    }
    game.remotePlayers = players.filter(p => p.id !== meId).map(p => {
      const cb = p.curBuildingId != null
        ? (game.city.buildings.find(b => b.id === p.curBuildingId) || { id: p.curBuildingId, kind: null, isHome: false, floors: 0, cleared: {} })
        : null;
      // 远程玩家：把快照位置存成插值目标 _tx/_ty，x/y 保留当前值，
      // 由 clientTick 每帧 lerp 追过去，避免 16Hz 快照造成的瞬移抖动。
      // 场景切换时（进/出建筑）坐标系变了，直接 snap 到新位置，不插值。
      const old = (game.remotePlayers || []).find(r => r.id === p.id);
      const sceneChanged = !old || old.scene !== (p.scene || 'city');
      return {
        id: p.id, name: p.name, isHost: p.isHost,
        x: sceneChanged ? p.x : old.x, y: sceneChanged ? p.y : old.y,
        _tx: p.x, _ty: p.y,
        hp: p.hp, maxHp: p.maxHp,
        facing: p.facing, walkPhase: p.walkPhase, hurtFlash: p.hurtFlash,
        ammo: p.ammo, inv: p.inv || {}, lastAim: { dx: p.aimDx, dy: p.aimDy },
        scene: p.scene || 'city', curBuilding: cb, curFloor: p.curFloor || 0
      };
    });
    game.fogIntensity = s.fogIntensity || 0;
    if (s.stats) game.stats.kills = s.stats.kills || 0;
    updateCamera();
  }

  // ---------- 客户端：本地预测 + 发送输入 ----------
  // 客户端比主机卡的根本原因：客户端自己不模拟移动，只能等"按键→发包→主机模拟→快照回传"这一整个往返
  // 才看到自己动，输入延迟 ≈ 33ms(发包) + 62ms(快照) + 网络 RTT，明显比主机顿。
  // 解决：客户端本地立即预测自己的移动（碰撞用本机地图，和主机一致），快照回来只做纠错。
  function clientTick(dt) {
    if (!game || game.netMode !== 'client') return;
    game.timeMs = (game.timeMs || 0) + dt;

    // 1) 本地预测：每帧立即应用自己的移动输入，跟手不等网络
    const inp = readLocalInput();
    stepClientLocalPrediction(inp, dt);

    // 2) 远程玩家位置插值：把快照设的目标位置平滑追过去，避免 16Hz 快照造成的瞬移抖动
    for (const rp of (game.remotePlayers || [])) {
      if (rp._tx == null) continue;
      const lerp = Math.min(1, dt / 80); // ~80ms 追上目标
      rp.x += (rp._tx - rp.x) * lerp;
      rp.y += (rp._ty - rp.y) * lerp;
    }
    updateCamera();

    // 3) 发送输入 ~30Hz
    party.inputSendAcc += dt;
    if (party.inputSendAcc < 33) { keyPressed = {}; return; }
    party.inputSendAcc = 0;
    inp.name = party.myName;
    party._lastSentMv = { mx: inp.mx, my: inp.my };
    party._sentInputs = (party._sentInputs || 0) + 1;
    window.api.partySend({ type: 'input', mx: inp.mx, my: inp.my, aimDx: inp.aimDx, aimDy: inp.aimDy, attack: inp.attack, shoot: inp.shoot, interact: inp.interact, useItem: inp.useItem });
    // 边沿输入已发出，清空缓冲，避免下一包重复触发 interact / useItem
    party._edgeInteract = false;
    party._edgeUseItem = null;
    keyPressed = {};
  }

  // 客户端本地移动预测：只预测移动 + 朝向 + 步频（攻击/开枪/互动仍由主机权威结算）
  function stepClientLocalPrediction(input, dt) {
    const speed = 90;
    const nx = game.player.x + input.mx * speed * dt / 1000;
    const ny = game.player.y + input.my * speed * dt / 1000;
    if (canWalk(nx, game.player.y)) game.player.x = nx;
    if (canWalk(game.player.x, ny)) game.player.y = ny;
    if (input.attack || input.shoot) {
      game.player.facing = cardinalFromDir(input.aimDx, input.aimDy);
    } else if (input.mx < 0) game.player.facing = 1;
    else if (input.mx > 0) game.player.facing = 2;
    else if (input.my < 0) game.player.facing = 3;
    else if (input.my > 0) game.player.facing = 0;
    if (input.mx !== 0 || input.my !== 0) game.player.walkPhase = (game.player.walkPhase || 0) + dt / 100;
  }

  // 新建对局
  function newGame(name) {
    devMode = false;
    const seed = (Math.random() * 0x7fffffff) | 0;
    const city = generateCity(seed);
    const home = city.buildings.find(b => b.isHome) || city.buildings[0];
    const player = {
      name: name || '幸存者',
      hp: 100, maxHp: 100,
      x: 0, y: 0,            // 在场景中的像素坐标
      facing: 0,             // 0 下 1 左 2 右 3 上
      walkPhase: 0,
      inv: {},               // type -> count
      weapon: 'fists',
      ammo: 0,
      lastAtk: 0,
      hurtFlash: 0,
      baseAtk: 12,           // 拳头伤害
      atkRange: 22,
      atkCd: 380,
      // 场景归属（独立场景用）
      scene: 'city', curBuilding: null, curFloor: 0
    };
    const stats = { kills: 0, looted: 0, deaths: 0, dmgDealt: 0, dmgTaken: 0 };

    const g = {
      id: 'save_' + Date.now().toString(36) + '_' + Math.floor(Math.random()*1e6).toString(36),
      name: name || '幸存者',
      createdAt: 0, updatedAt: 0, playtime: 0,
      seed, city, player, stats,
      scene: 'city',         // 当前激活场景（用于渲染/单玩家）
      curBuilding: null, curFloor: 0, floor: null,
      cam: { x: 0, y: 0 },
      cityMonsters: [],
      nextCitySpawn: 0,
      fogIntensity: 0,
      bullets: [],
      // 联机 / 多场景
      netMode: 'single',
      remotePlayers: [],
      scenes: new Map(),
      needSave: false,
      timeMs: 0  // 昼夜循环累计毫秒（10 分钟一轮，5 分钟白天 + 5 分钟夜晚）
    };

    // 玩家放在 home 楼门口外的路上
    const d = home.door;
    player.x = d.x * TILE + TILE/2;
    player.y = (d.y + 2) * TILE + TILE/2;

    game = g;
    enterCity();
    state = 'PLAYING';
    toastMsg('找到你的高楼 (绿色门) 以进入安全区', 4000);
  }

  // 进入城市场景
  function enterCity() {
    const bundle = ensureCityScene();
    activateScene(bundle);
    // 在城市里生成少量僵尸/雾中人
    game.cityMonsters = [];
    const n = randi(3, 7);
    for (let i = 0; i < n; i++) {
      const kind = Math.random() < 0.6 ? 'zombie' : 'fogman';
      let tx, ty, tries = 0;
      do {
        tx = randi(2, game.city.W-2); ty = randi(2, game.city.H-2); tries++;
      } while ((game.city.map[ty*game.city.W+tx] !== 0 && game.city.map[ty*game.city.W+tx] !== 1) && tries < 30);
      if (game.city.map[ty*game.city.W+tx] > 1) continue;
      const mx = tx*TILE + TILE/2, my = ty*TILE + TILE/2;
      if (dist2(mx, my, game.player.x, game.player.y) < 200*200) continue;
      game.cityMonsters.push(makeMonster(kind, mx, my));
    }
    game.nextCitySpawn = performance.now() + 20000;
    syncBundle(bundle);
  }

  // 进入建筑（针对单个玩家 p，独立场景）
  function enterBuildingAs(p, building, floorIdx = 0) {
    const bundle = ensureInteriorScene(building, floorIdx);
    p.scene = 'interior'; p.curBuilding = building; p.curFloor = floorIdx;
    activateScene(bundle);
    const { ex, ey } = floorEntryPoint();
    placePlayerNear(p, ex, ey);
    if (p === game.player) {
      if (building.isHome) toastMsg('安全屋 · 第 ' + (floorIdx+1) + ' 层', 2200);
      else toastMsg(building.kind === 'zombie' ? '僵尸楼 · 第 ' + (floorIdx+1) + ' 层'
                  : building.kind === 'fog' ? '雾中人巢穴 · 第 ' + (floorIdx+1) + ' 层'
                  : '未知建筑 · 第 ' + (floorIdx+1) + ' 层', 2200);
    }
  }
  // 兼容旧调用（单玩家）
  function enterBuilding(building, floorIdx = 0) { enterBuildingAs(game.player, building, floorIdx); }
  function enterBuildingShared(building, floorIdx = 0) { enterBuildingAs(game.player, building, floorIdx); }

  // 出口门 -> 回到城市（针对单个玩家）
  function exitToCityAs(p) {
    const b = p.curBuilding;
    const cityBundle = ensureCityScene();
    p.scene = 'city'; p.curBuilding = null; p.curFloor = 0;
    activateScene(cityBundle);
    if (b) placePlayerNear(p, b.door.x * TILE + TILE/2, (b.door.y + 1) * TILE + TILE/2);
  }


  // ====================================================================
  //  存档
  // ====================================================================

  async function refreshSaves() {
    const all = await window.api.saveList();
    // 读取存档界面只列出还没死的存档
    savesList = all.filter(s => (s.hp || 0) > 0);
  }

  function serializeGame() {
    return {
      id: game.id,
      name: game.name,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
      playtime: game.playtime + playtimeAcc,
      seed: game.seed,
      // city: 重建即可，但保留 buildings 的 looted/cleared 状态
      cityBuildingsState: game.city.buildings.map(b => ({
        id: b.id, looted: b.looted, cleared: b.cleared
      })),
      player: {
        name: game.player.name,
        hp: game.player.hp, maxHp: game.player.maxHp,
        x: game.player.x, y: game.player.y,
        facing: game.player.facing,
        inv: game.player.inv,
        weapon: game.player.weapon,
        ammo: game.player.ammo,
        baseAtk: game.player.baseAtk,
        atkRange: game.player.atkRange,
        atkCd: game.player.atkCd
      },
      stats: game.stats,
      scene: game.scene,
      curBuildingId: game.curBuilding ? game.curBuilding.id : null,
      curFloor: game.curFloor,
      timeMs: game.timeMs || 0
    };
  }

  async function saveGame() {
    if (!game) return;
    if (game.netMode !== 'single') return; // 联机不存档
    activateScene(sceneOf(game.player)); // 确保序列化的是本地玩家所在场景
    const payload = serializeGame();
    const r = await window.api.writeSave(payload);
    if (r.ok) {
      game.updatedAt = r.updatedAt;
      if (!game.createdAt) game.createdAt = r.updatedAt;
      toastMsg('已保存：' + game.name, 1500);
    } else {
      toastMsg('保存失败', 2000);
    }
    game.needSave = false;
  }

  async function loadGameById(id) {
    const data = await window.api.loadSave(id);
    if (!data) { toastMsg('存档损坏', 2000); return false; }
    devMode = false;
    const city = generateCity(data.seed);
    // 还原 building 状态
    for (const bs of data.cityBuildingsState || []) {
      const b = city.buildings.find(x => x.id === bs.id);
      if (b) { b.looted = bs.looted || {}; b.cleared = bs.cleared || {}; }
    }
    game = {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      playtime: data.playtime || 0,
      seed: data.seed,
      city,
      player: Object.assign({
        // 这些是运行时字段，不进存档，读档时补默认值，避免 undefined/NaN
        walkPhase: 0,
        hurtFlash: 0,
        lastAtk: 0,
        lastShoot: 0
      }, data.player),
      stats: data.stats,
      scene: 'city',
      curBuilding: null, curFloor: 0, floor: null,
      cam: { x: 0, y: 0 },
      cityMonsters: [], nextCitySpawn: 0, fogIntensity: 0,
      bullets: [],
      netMode: 'single', remotePlayers: [],
      scenes: new Map(),
      needSave: false,
      timeMs: data.timeMs || 0
    };
    game.player.scene = 'city'; game.player.curBuilding = null; game.player.curFloor = 0;
    // 旧版存档兼容：子弹曾经放在 inv.ammo，现在统一到 p.ammo（开枪资源）
    // 每个旧子弹物品按 AMMO_PER_PICKUP 折算成发数
    if (game.player.inv && game.player.inv.ammo) {
      game.player.ammo = (game.player.ammo || 0) + game.player.inv.ammo * AMMO_PER_PICKUP;
      delete game.player.inv.ammo;
    }
    // 恢复场景
    if (data.scene === 'interior' && data.curBuildingId) {
      const b = city.buildings.find(x => x.id === data.curBuildingId);
      if (b) {
        enterBuilding(b, data.curFloor || 0); // 会设置 game.player.scene/curBuilding/curFloor
        // 覆盖玩家位置为存档位置
        game.player.x = data.player.x;
        game.player.y = data.player.y;
      } else {
        enterCity();
        game.player.scene = 'city'; game.player.curBuilding = null; game.player.curFloor = 0;
        game.player.x = data.player.x;
        game.player.y = data.player.y;
      }
    } else {
      enterCity();
      game.player.scene = 'city'; game.player.curBuilding = null; game.player.curFloor = 0;
      game.player.x = data.player.x;
      game.player.y = data.player.y;
    }
    // 同步激活场景到玩家所在场景，再校正位置
    activateScene(sceneOf(game.player));
    // 安全网：若存档位置卡在墙里（旧版存档或位置漂移），挪到最近的可走格
    nudgePlayerToWalkable();
    state = 'PLAYING';
    toastMsg('已载入：' + game.name, 1500);
    return true;
  }

  // 把卡在不可走格里的玩家挪到最近的可走格（螺旋向外搜索）
  function nudgePlayerToWalkable() {
    if (!game) return;
    const p = game.player;
    if (canWalk(p.x, p.y)) return;
    const W = game.scene === 'city' ? game.city.W : game.floor.W;
    const H = game.scene === 'city' ? game.city.H : game.floor.H;
    const tx0 = Math.floor(p.x / TILE);
    const ty0 = Math.floor(p.y / TILE);
    for (let r = 1; r < Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // 只查外圈
          const tx = tx0 + dx, ty = ty0 + dy;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (isWalkableTile(tx, ty)) {
            p.x = tx * TILE + TILE / 2;
            p.y = ty * TILE + TILE / 2;
            toastMsg('位置已校正', 1500);
            return;
          }
        }
      }
    }
    // 实在找不到，回 home 楼门口
    const home = game.city.buildings.find(b => b.isHome) || game.city.buildings[0];
    if (home) {
      game.scene = 'city';
      game.curBuilding = null; game.floor = null;
      p.x = home.door.x * TILE + TILE / 2;
      p.y = (home.door.y + 1) * TILE + TILE / 2;
      toastMsg('位置已校正', 1500);
    }
  }

  // ====================================================================
  //  更新逻辑
  // ====================================================================

  // 所有玩家（本地 + 远程），用于怪物寻路、拾取、渲染
  function allPlayers() {
    if (!game) return [];
    const arr = [game.player];
    if (game.remotePlayers) for (const rp of game.remotePlayers) arr.push(rp);
    return arr;
  }

  // ---------- 多场景（独立场景联机） ----------
  // game.scenes: Map<key, bundle>
  // bundle: { scene, curBuilding, curFloor, floor, cityMonsters, cityItems, bullets, fogIntensity }
  function sceneKeyOf(p) {
    if (!p) return 'city';
    if (p.scene === 'city' || !p.curBuilding) return 'city';
    return 'b:' + p.curBuilding.id + ':' + p.curFloor;
  }
  function sceneOf(p) {
    if (!game || !game.scenes) return null;
    return game.scenes.get(sceneKeyOf(p)) || null;
  }
  function activateScene(bundle) {
    if (!bundle) return;
    game.scene = bundle.scene;
    game.curBuilding = bundle.curBuilding;
    game.curFloor = bundle.curFloor;
    game.floor = bundle.floor;
    game.cityMonsters = bundle.cityMonsters;
    game.cityItems = bundle.cityItems;
    game.bullets = bundle.bullets;
    game.fogIntensity = bundle.fogIntensity || 0;
  }
  function syncBundle(bundle) {
    if (!bundle) return;
    bundle.curBuilding = game.curBuilding;
    bundle.curFloor = game.curFloor;
    bundle.floor = game.floor;
    bundle.cityMonsters = game.cityMonsters;
    bundle.cityItems = game.cityItems;
    bundle.bullets = game.bullets;
    bundle.fogIntensity = game.fogIntensity;
  }
  function ensureCityScene() {
    if (!game.scenes.has('city')) {
      game.scenes.set('city', {
        scene: 'city', curBuilding: null, curFloor: 0, floor: null,
        cityMonsters: game.cityMonsters || [], cityItems: game.cityItems || [],
        bullets: game.bullets || [], fogIntensity: 0
      });
    }
    return game.scenes.get('city');
  }
  function ensureInteriorScene(building, floorIdx) {
    const key = 'b:' + building.id + ':' + floorIdx;
    let bundle = game.scenes.get(key);
    if (!bundle) {
      const cleared = building.cleared[floorIdx];
      const floor = generateFloor(building, floorIdx, building.isHome, cleared);
      bundle = {
        scene: 'interior', curBuilding: building, curFloor: floorIdx, floor,
        cityMonsters: [], cityItems: [], bullets: [], fogIntensity: 0
      };
      game.scenes.set(key, bundle);
    }
    return bundle;
  }
  // 在当前激活场景里把玩家 p 放到 (ex,ey) 附近可走格
  function placePlayerNear(p, ex, ey) {
    const r = 5;
    const tryAt = (px, py) => px >= 0 && py >= 0 &&
      canWalk(px - r, py - r) && canWalk(px + r, py - r) &&
      canWalk(px - r, py + r) && canWalk(px + r, py + r);
    if (tryAt(ex, ey)) { p.x = ex; p.y = ey; return; }
    for (let rad = 1; rad < 14; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.abs(dx) !== rad && Math.abs(dy) !== rad) continue;
          const px = ex + dx * TILE, py = ey + dy * TILE;
          if (tryAt(px, py)) { p.x = px; p.y = py; return; }
        }
      }
    }
    p.x = ex; p.y = ey;
  }
  // 计算某楼层入口坐标（基于当前激活的 floor）
  function floorEntryPoint() {
    const f = game.floor;
    let ex = Math.floor(f.W/2) * TILE + TILE/2;
    let ey = (f.H - 3) * TILE + TILE/2;
    // 楼梯下进入
    if (game.curFloor > 0) {
      for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
        if (f.map[y*f.W+x] === 3) { ex = x*TILE + TILE/2; ey = (y+1)*TILE + TILE/2; }
      }
    }
    return { ex, ey };
  }

  function readLocalInput() {
    let mx = 0, my = 0;
    if (keys['ArrowLeft'] || keys['KeyA']) mx -= 1;
    if (keys['ArrowRight'] || keys['KeyD']) mx += 1;
    if (keys['ArrowUp'] || keys['KeyW']) my -= 1;
    if (keys['ArrowDown'] || keys['KeyS']) my += 1;
    if (mx !== 0 && my !== 0) { mx *= 0.7071; my *= 0.7071; }
    const aim = aimDir();
    const isClient = !!(game && game.netMode === 'client');
    // 客户端用边沿缓冲（keydown 写入，clientTick 发送时清空），主机/单机用 keyPressed（每帧读）
    let useItem = null;
    if (isClient) {
      useItem = party._edgeUseItem || null;
    } else {
      if (keyPressed['Digit1']) useItem = 'medkit';
      else if (keyPressed['Digit2']) useItem = 'bandage';
      else if (keyPressed['Digit3']) useItem = 'canned';
      else if (keyPressed['Digit4']) useItem = 'water';
    }
    return {
      mx, my,
      aimDx: aim.dx, aimDy: aim.dy,
      attack: !!(keys['Space'] || keys['KeyJ']),
      shoot: !!keys['KeyK'],
      interact: isClient ? !!party._edgeInteract : !!(keyPressed['KeyE'] || keyPressed['KeyF']),
      useItem,
      isLocal: true
    };
  }

  // 通用：推进一个玩家实体（本地或远程）
  function stepPlayerEntity(p, input, dt, isLocal) {
    const speed = 90;
    const nx = p.x + input.mx * speed * dt / 1000;
    const ny = p.y + input.my * speed * dt / 1000;
    if (canWalk(nx, p.y)) p.x = nx;
    if (canWalk(p.x, ny)) p.y = ny;

    if (input.attack || input.shoot) {
      p.facing = cardinalFromDir(input.aimDx, input.aimDy);
    } else if (input.mx < 0) p.facing = 1;
    else if (input.mx > 0) p.facing = 2;
    else if (input.my < 0) p.facing = 3;
    else if (input.my > 0) p.facing = 0;

    if (input.mx !== 0 || input.my !== 0) p.walkPhase = (p.walkPhase || 0) + dt / 100;

    // 互动 / 自动进门：所有被模拟的玩家都能触发自己的场景切换（独立场景）
    if (game.netMode !== 'client') {
      if (input.interact) interactAs(p);
      // 走到城市门上自动进入
      if (p.scene === 'city') {
        const tx = Math.floor(p.x / TILE);
        const ty = Math.floor(p.y / TILE);
        const t = game.city.map[ty*game.city.W + tx];
        if (t === 4 || t === 5) {
          const b = game.city.buildings.find(bb => bb.door.x === tx && bb.door.y === ty);
          if (b) enterBuildingAs(p, b, 0);
        }
      }
    }

    if (input.attack) attackForPlayer(p, input.aimDx, input.aimDy);
    if (input.shoot) shootForPlayer(p, input.aimDx, input.aimDy);
    if (input.useItem) useItemForPlayer(p, input.useItem);

    if ((p.hurtFlash || 0) > 0) p.hurtFlash = (p.hurtFlash || 0) - dt;
  }

  function update(dt) {
    if (state !== 'PLAYING' || !game) return;
    playtimeAcc += dt;
    game.timeMs = (game.timeMs || 0) + dt;

    // 1. 推进本地玩家（在本地玩家的场景里）
    activateScene(sceneOf(game.player));
    const localInput = readLocalInput();
    stepPlayerEntity(game.player, localInput, dt, true);

    // 2. 主机：推进远程玩家（各自场景）
    if (game.netMode === 'host' && game.remotePlayers) {
      for (const cp of game.remotePlayers) {
        activateScene(sceneOf(cp));
        const raw = party.clientInputs[cp.id] || { mx:0, my:0, aimDx:0, aimDy:1, attack:false, shoot:false, interact:false, useItem:null };
        // 边沿触发：interact / useItem 只在按下那一帧生效（输入会跨帧保留）
        const prevInt = cp._prevInteract || false;
        const prevUse = cp._prevUseItem || null;
        const inp = Object.assign({}, raw, {
          interact: raw.interact && !prevInt,
          useItem: (raw.useItem && raw.useItem !== prevUse) ? raw.useItem : null
        });
        cp._prevInteract = !!raw.interact;
        cp._prevUseItem = raw.useItem || null;
        stepPlayerEntity(cp, inp, dt, false);
        syncBundle(sceneOf(cp));
      }
    }
    // 注意：这里不要再 syncBundle(sceneOf(game.player))！
    // 上面远程玩家循环会把 game.* 切成最后一个客户端的场景（例如 city，floor=null），
    // 此时 syncBundle 主机场景会把主机 interior bundle 的 floor 覆盖成 null，
    // 随后第 3 步激活该被污染的 interior bundle，autoPickupAll 访问 game.floor.items 会抛异常，
    // 导致 update 崩溃、主机卡死、客户端收不到快照也一起卡住。
    // 主机自己的 bundle 由第 3 步逐场景模拟时 activateScene+syncBundle 正确同步。

    // 暂停 / 存档（仅本地）
    if (keyPressed['Escape']) state = 'PAUSED';
    if (keyPressed['KeyR'] && game.netMode === 'single') saveGame();

    // 3. 逐场景模拟（仅含玩家的场景）
    if (game.netMode !== 'client') {
      const scenePlayers = new Map();
      for (const pl of allPlayers()) {
        const k = sceneKeyOf(pl);
        if (!scenePlayers.has(k)) scenePlayers.set(k, []);
        scenePlayers.get(k).push(pl);
      }
      for (const [key, players] of scenePlayers) {
        const bundle = game.scenes.get(key);
        if (!bundle) continue;
        activateScene(bundle);
        updateMonsters(dt, players);
        updateBullets(dt);
        autoPickupAll(players);
        if (bundle.scene === 'city') updateCitySpawn(dt, players);
        // 雾气
        if (bundle.scene === 'city') game.fogIntensity = 0.25 + 0.2 * Math.sin(performance.now() / 9000);
        else game.fogIntensity = bundle.curBuilding && bundle.curBuilding.kind === 'fog' ? 0.35 : 0;
        // 清理死亡怪物
        if (game.scene === 'city') game.cityMonsters = game.cityMonsters.filter(m => m.alive);
        else if (game.floor) game.floor.monsters = game.floor.monsters.filter(m => m.alive);
        syncBundle(bundle);
      }
    }

    // 受伤闪烁（所有玩家）
    for (const pl of allPlayers()) {
      if ((pl.hurtFlash || 0) > 0) pl.hurtFlash = (pl.hurtFlash || 0) - dt;
      if (pl.hp <= 0) pl.hp = 0;
    }

    // 死亡判定（仅本地玩家在主机/单人下进入 DEAD）
    if (game.netMode !== 'client') {
      if (devMode) {
        // 开发者模式：血量无限，不会死亡
        game.player.hp = game.player.maxHp;
      } else if (game.player.hp <= 0) {
        game.player.hp = 0;
        state = 'DEAD';
        game.stats.deaths = (game.stats.deaths || 0) + 1;
        if (game.netMode === 'host') {
          partyHostBroadcastMsg({ type: 'kick', reason: '主机已死亡，派对结束' });
        }
      }
    }

    // 恢复主机场景 + 相机
    activateScene(sceneOf(game.player));
    updateCamera();

    // 主机：定时广播快照
    if (game.netMode === 'host') maybeBroadcastSnapshot();

    keyPressed = {};
  }

  function canWalk(px, py) {
    if (!game) return false;
    const r = 5; // 玩家半径
    const points = [
      [px - r, py - r], [px + r, py - r],
      [px - r, py + r], [px + r, py + r]
    ];
    for (const [x, y] of points) {
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (!isWalkableTile(tx, ty)) return false;
    }
    return true;
  }

  function isWalkableTile(tx, ty) {
    if (game.scene === 'city') {
      if (tx < 0 || ty < 0 || tx >= game.city.W || ty >= game.city.H) return false;
      const t = game.city.map[ty*game.city.W + tx];
      // 0 路面 / 1 人行道 / 4 楼房门 / 5 home 门 可走；3 楼墙不可走
      return t === 0 || t === 1 || t === 4 || t === 5;
    } else {
      const f = game.floor;
      if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) return false;
      const t = f.map[ty*f.W + tx];
      // 0 地板 / 2 楼梯上 / 3 楼梯下 / 4 出口 可走；1 墙不可走
      return t === 0 || t === 2 || t === 3 || t === 4;
    }
  }

  function interactAs(p) {
    if (!game || !p) return;
    // 切到该玩家的场景
    const bundle = sceneOf(p);
    if (!bundle) return;
    activateScene(bundle);
    if (p.scene === 'city') {
      const cx = Math.floor(p.x / TILE);
      const cy = Math.floor(p.y / TILE);
      const fx = Math.floor((p.x + dirX(p.facing) * 14) / TILE);
      const fy = Math.floor((p.y + dirY(p.facing) * 14) / TILE);
      const W = game.city.W;
      const candidates = [
        [cx, cy], [fx, fy],
        [cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]
      ];
      for (const [tx, ty] of candidates) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= game.city.H) continue;
        const t = game.city.map[ty*W + tx];
        if (t === 4 || t === 5) {
          const b = game.city.buildings.find(bb => bb.door.x === tx && bb.door.y === ty);
          if (b) { enterBuildingAs(p, b, 0); return; }
        }
      }
    } else {
      const f = game.floor;
      if (!f) return;
      const cx = Math.floor(p.x / TILE);
      const cy = Math.floor(p.y / TILE);
      const fx = Math.floor((p.x + dirX(p.facing) * 14) / TILE);
      const fy = Math.floor((p.y + dirY(p.facing) * 14) / TILE);
      const W = f.W;
      const tileAt = (tx, ty) => {
        if (tx < 0 || ty < 0 || tx >= W || ty >= f.H) return -1;
        return f.map[ty*W + tx];
      };
      let t = tileAt(cx, cy);
      if (t !== 2 && t !== 3 && t !== 4) t = tileAt(fx, fy);
      if (t === 2) {
        enterBuildingAs(p, p.curBuilding, p.curFloor + 1);
      } else if (t === 3) {
        if (p.curFloor > 0) enterBuildingAs(p, p.curBuilding, p.curFloor - 1);
      } else if (t === 4) {
        exitToCityAs(p);
      }
    }
  }
  function interact() { interactAs(game.player); }

  function dirX(f) { return f === 1 ? -1 : f === 2 ? 1 : 0; }
  function dirY(f) { return f === 0 ? 1 : f === 3 ? -1 : 0; }

  // 由鼠标位置算出瞄准方向（归一化）；存到 p.lastAim 供渲染挥拳方向
  function aimDir() {
    const p = game.player;
    const wx = mousePos.x + game.cam.x;
    const wy = mousePos.y + game.cam.y;
    let dx = wx - p.x, dy = wy - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return { dx: dirX(p.facing), dy: dirY(p.facing) };
    return { dx: dx/d, dy: dy/d };
  }
  // 把任意方向转成四向 facing（0下 1左 2右 3上）
  function cardinalFromDir(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 2 : 1;
    return dy > 0 ? 0 : 3;
  }

  function attackForPlayer(p, aimDx, aimDy) {
    const now = performance.now();
    if (now - (p.lastAtk || 0) < (p.atkCd || 380)) return;
    p.lastAtk = now;
    p.lastAim = { dx: aimDx, dy: aimDy };

    const range = p.atkRange || 22;
    const monsters = currentMonsters();
    let hit = false;
    for (const m of monsters) {
      if (!m.alive) continue;
      const mdx = m.x - p.x, mdy = m.y - p.y;
      const d = Math.hypot(mdx, mdy);
      if (d > range + 8) continue;
      if (d > 0.1) {
        const dot = (mdx*aimDx + mdy*aimDy) / d;
        if (dot < 0.3) continue;
      }
      m.hp -= (p.baseAtk || 12);
      m.hurtFlash = 120;
      game.stats.dmgDealt += (p.baseAtk || 12);
      hit = true;
      m.x += aimDx * 6; m.y += aimDy * 6;
      if (m.hp <= 0) {
        m.alive = false;
        game.stats.kills++;
        if (m.kind === 'fogman' && Math.random() < 0.5) spawnLootAt(m.x, m.y, 'ammo');
        else if (m.kind === 'zombie' && Math.random() < 0.25) spawnLootAt(m.x, m.y, choice(['canned','water','bandage']));
      }
    }
    if (hit) checkFloorCleared();
  }
  // 兼容旧调用
  function tryAttack() { attackForPlayer(game.player, aimDir().dx, aimDir().dy); }

  // ---------- 远程开枪 ----------
  const SHOOT_DMG = 25;
  const SHOOT_SPEED = 320;     // px/s
  const SHOOT_LIFE = 900;      // ms
  const SHOOT_CD = 240;        // ms
  function shootForPlayer(p, aimDx, aimDy) {
    if (!devMode || p !== game.player) {
      if ((p.ammo || 0) <= 0) {
        if (p.isLocal !== false) {
          if (!p._noAmmoToast || performance.now() - p._noAmmoToast > 1500) {
            toastMsg('没有子弹了！按 K 开枪，空格挥拳', 1200);
            p._noAmmoToast = performance.now();
          }
        }
        return;
      }
    }
    const now = performance.now();
    if (now - (p.lastShoot || 0) < SHOOT_CD) return;
    p.lastShoot = now;
    if (!devMode || p !== game.player) p.ammo -= 1;
    p.lastAim = { dx: aimDx, dy: aimDy };
    game.bullets.push({
      x: p.x + aimDx * 8,
      y: p.y + aimDy * 8,
      dx: aimDx, dy: aimDy,
      born: now,
      dmg: SHOOT_DMG
    });
  }
  function tryShoot() { shootForPlayer(game.player, aimDir().dx, aimDir().dy); }

  function updateBullets(dt) {
    if (!game.bullets || game.bullets.length === 0) return;
    const now = performance.now();
    const monsters = currentMonsters();
    const survivors = [];
    for (const b of game.bullets) {
      // 推进
      b.x += b.dx * SHOOT_SPEED * dt / 1000;
      b.y += b.dy * SHOOT_SPEED * dt / 1000;
      // 寿命
      if (now - b.born > SHOOT_LIFE) continue;
      // 撞墙
      const tx = Math.floor(b.x / TILE);
      const ty = Math.floor(b.y / TILE);
      if (!isWalkableTile(tx, ty)) continue;
      // 撞怪物
      let hitMonster = false;
      for (const m of monsters) {
        if (!m.alive) continue;
        if (dist2(b.x, b.y, m.x, m.y) <= 10*10) {
          m.hp -= b.dmg;
          m.hurtFlash = 120;
          game.stats.dmgDealt += b.dmg;
          // 击退
          const ddx = m.x - b.x, ddy = m.y - b.y;
          const d = Math.hypot(ddx, ddy) || 1;
          m.x += ddx/d * 4; m.y += ddy/d * 4;
          if (m.hp <= 0) {
            m.alive = false;
            game.stats.kills++;
            if (m.kind === 'fogman' && Math.random() < 0.5) {
              spawnLootAt(m.x, m.y, 'ammo');
            } else if (m.kind === 'zombie' && Math.random() < 0.25) {
              spawnLootAt(m.x, m.y, choice(['canned','water','bandage']));
            }
          }
          hitMonster = true;
          break;
        }
      }
      if (hitMonster) { checkFloorCleared(); continue; }
      survivors.push(b);
    }
    game.bullets = survivors;
  }

  function renderBullets() {
    if (!game.bullets || game.bullets.length === 0) return;
    const cam = game.cam;
    for (const b of game.bullets) {
      const sx = b.x - cam.x, sy = b.y - cam.y;
      // 弹头
      ctx.fillStyle = '#ffe070';
      ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 3, 3);
      // 尾焰
      ctx.fillStyle = 'rgba(255,160,40,0.6)';
      ctx.fillRect(Math.round(sx - b.dx*4) - 1, Math.round(sy - b.dy*4) - 1, 2, 2);
    }
  }

  function spawnLootAt(x, y, type) {
    if (game.scene === 'interior') {
      game.floor.items.push({ x, y, type, taken: false });
    } else {
      // 城市掉落：放到 cityMonsters 之外的简单 ground items
      if (!game.cityItems) game.cityItems = [];
      game.cityItems.push({ x, y, type, taken: false });
    }
  }

  function currentMonsters() {
    return game.scene === 'city' ? game.cityMonsters : (game.floor ? game.floor.monsters : []);
  }

  function checkFloorCleared() {
    if (game.scene !== 'interior') return;
    const alive = game.floor.monsters.some(m => m.alive);
    if (!alive) {
      game.curBuilding.cleared[game.curFloor] = true;
    }
  }

  function useItemForPlayer(p, type) {
    const def = ITEMS[type];
    if (!def) return;
    if (devMode && p === game.player) {
      // 开发者模式：本地玩家无限使用，不消耗
      if (def.heal > 0) {
        if (p.hp < p.maxHp) {
          p.hp = Math.min(p.maxHp, p.hp + def.heal);
          if (p === game.player) toastMsg('使用 ' + def.name + ' +' + def.heal + ' HP', 1000);
        } else if (p === game.player) {
          toastMsg('生命已满', 800);
        }
      } else if (def.kind === 'ammo') {
        p.ammo = (p.ammo || 0) + 10;
        if (p === game.player) toastMsg('+' + def.name + ' x10', 1000);
      }
      return;
    }
    if ((p.inv[type] || 0) <= 0) return;
    if (def.heal > 0) {
      if (p.hp >= p.maxHp) {
        if (p === game.player) toastMsg('生命已满', 1000);
        return;
      }
      p.hp = Math.min(p.maxHp, p.hp + def.heal);
      if (p === game.player) toastMsg('使用 ' + def.name + ' +' + def.heal + ' HP', 1200);
    } else if (def.kind === 'ammo') {
      p.ammo = (p.ammo || 0) + 10;
      if (p === game.player) toastMsg('+' + def.name + ' x10', 1200);
    }
    p.inv[type] -= 1;
    if (p.inv[type] <= 0) delete p.inv[type];
  }
  function useItem(type) { useItemForPlayer(game.player, type); }

  function updateMonsters(dt, players) {
    if (!players) players = allPlayers();
    const monsters = currentMonsters();
    const now = performance.now();
    for (const m of monsters) {
      if (!m.alive) continue;
      if (m.hurtFlash > 0) m.hurtFlash -= dt;
      const def = MON[m.kind];
      // 找最近的活着的玩家
      let target = null, bestD2 = Infinity;
      for (const pl of players) {
        if ((pl.hp || 0) <= 0) continue;
        const d2 = dist2(m.x, m.y, pl.x, pl.y);
        if (d2 < bestD2) { bestD2 = d2; target = pl; }
      }
      const p = target || players[0];
      const d2 = bestD2;
      const aggro = (m.kind === 'fogman') ? 280*280 : 220*220;
      if (target && d2 < aggro) {
        // 追击
        const dx = p.x - m.x, dy = p.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        // 朝向：水平方向决定左右
        if (Math.abs(dx) > 2) m.facing = dx > 0 ? 2 : 1;
        m.walkPhase = (m.walkPhase || 0) + dt / 170;   // 更慢，拖沓的步频
        let spd = def.speed * 60;
        if (m.kind === 'fogman' && game.fogIntensity > 0.3) spd *= 1.3;
        // 保持与玩家最小间距，避免直接重叠到玩家身上
        const MIN_GAP = 12;
        if (d > MIN_GAP) {
          stepMonsterToward(m, p.x, p.y, spd, dt, now);
        }
        if (d2 <= def.atkRange*def.atkRange && now - m.lastAtk > def.atkCd) {
          // 是否新一轮扑咬：距上次攻击超过 1.2s 视为新一次"从远处扑过来"
          const prevGap = now - (m.lastAtk || 0);
          const newEngage = prevGap > 1200;
          m.lastAtk = now;
          m.atkDx = dx / d; m.atkDy = dy / d;   // 记录扑咬方向
          // 只有新一轮且玩家在远处才真正"扑"过去；已贴身则原地蹲下啃，不再跳
          // 扑出距离 = 到玩家距离 - 间距，停在玩家前方不重叠
          m.pouncing = (newEngage && d > 20);
          m.atkDist = m.pouncing ? Math.max(8, Math.min(d - MIN_GAP, def.atkRange)) : 0;
          p.hp -= def.dmg;
          p.hurtFlash = 200;
          game.stats.dmgTaken += def.dmg;
          // 在玩家位置溅出血液（地板/墙上的血迹）
          spawnBloodSplat(p.x, p.y, sceneKeyOf(p));
        }
      } else {
        // 闲逛
        if (now > m.nextWander) {
          m.nextWander = now + rand(1500, 3500);
          m.wanderTx = m.x + rand(-60, 60);
          m.wanderTy = m.y + rand(-60, 60);
        }
        const dx = m.wanderTx - m.x, dy = m.wanderTy - m.y;
        const d = Math.hypot(dx, dy) || 1;
        if (Math.abs(dx) > 2) m.facing = dx > 0 ? 2 : 1;
        if (d > 4) m.walkPhase = (m.walkPhase || 0) + dt / 120;
        const spd = def.speed * 30;
        stepMonsterToward(m, m.wanderTx, m.wanderTy, spd, dt, now);
      }
    }
    if (game.scene === 'city') {
      game.cityMonsters = game.cityMonsters.filter(m => m.alive);
    } else {
      game.floor.monsters = game.floor.monsters.filter(m => m.alive);
    }
  }

  function canWalkMonster(m, px, py) {
    const r = 5;
    const points = [
      [px - r, py - r], [px + r, py - r],
      [px - r, py + r], [px + r, py + r]
    ];
    for (const [x, y] of points) {
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (!isWalkableTile(tx, ty)) return false;
    }
    return true;
  }

  // ---------- 僵尸寻路 ----------
  // BFS 在 tile 网格上 4 向搜索从 (startTx,startTy) 到 (goalTx,goalTy) 的路径。
  // 返回 tile 数组（不含起点，含终点）；找不到或超出预算返回 null。
  function findPathBFS(startTx, startTy, goalTx, goalTy, maxNodes) {
    const isCity = game.scene === 'city';
    const W = isCity ? game.city.W : game.floor.W;
    const H = isCity ? game.city.H : game.floor.H;
    if (goalTx < 0 || goalTy < 0 || goalTx >= W || goalTy >= H) return null;
    if (startTx === goalTx && startTy === goalTy) return [];
    const startIdx = startTy * W + startTx;
    const goalIdx = goalTy * W + goalTx;
    const visited = new Uint8Array(W * H);
    const cameFrom = new Int32Array(W * H).fill(-1);
    const queue = new Int32Array(W * H);
    let qHead = 0, qTail = 0;
    visited[startIdx] = 1;
    queue[qTail++] = startIdx;
    let count = 1;
    let found = false;
    while (qHead < qTail) {
      const idx = queue[qHead++];
      if (idx === goalIdx) { found = true; break; }
      const tx = idx % W, ty = (idx / W) | 0;
      // 右
      if (tx + 1 < W) {
        const n = idx + 1; if (!visited[n] && isWalkableTile(tx + 1, ty)) { visited[n] = 1; cameFrom[n] = idx; queue[qTail++] = n; if (++count > maxNodes) return null; }
      }
      // 左
      if (tx - 1 >= 0) {
        const n = idx - 1; if (!visited[n] && isWalkableTile(tx - 1, ty)) { visited[n] = 1; cameFrom[n] = idx; queue[qTail++] = n; if (++count > maxNodes) return null; }
      }
      // 下
      if (ty + 1 < H) {
        const n = idx + W; if (!visited[n] && isWalkableTile(tx, ty + 1)) { visited[n] = 1; cameFrom[n] = idx; queue[qTail++] = n; if (++count > maxNodes) return null; }
      }
      // 上
      if (ty - 1 >= 0) {
        const n = idx - W; if (!visited[n] && isWalkableTile(tx, ty - 1)) { visited[n] = 1; cameFrom[n] = idx; queue[qTail++] = n; if (++count > maxNodes) return null; }
      }
    }
    if (!found) return null;
    const path = [];
    let cur = goalIdx;
    while (cur !== startIdx) {
      if (cur < 0) return null;
      path.push({ tx: cur % W, ty: (cur / W) | 0 });
      cur = cameFrom[cur];
    }
    path.reverse();
    return path;
  }

  // 让怪物 m 沿寻路路径走向世界坐标 (targetX,targetY)。
  // 每隔 repathMs 或目标 tile 变化时重算路径；卡住时立即重算。
  function stepMonsterToward(m, targetX, targetY, spd, dt, now) {
    const ptx = Math.floor(targetX / TILE), pty = Math.floor(targetY / TILE);
    const mtx = Math.floor(m.x / TILE), mty = Math.floor(m.y / TILE);
    const needRepath = !m.path || m.pathTargetTx !== ptx || m.pathTargetTy !== pty || now > (m.repathAt || 0);
    if (needRepath) {
      m.path = findPathBFS(mtx, mty, ptx, pty, 3000);
      m.pathTargetTx = ptx; m.pathTargetTy = pty;
      m.repathAt = now + 700;
      m.pathIdx = 0;
    }
    const prevX = m.x, prevY = m.y;
    const step = spd * dt / 1000;
    if (m.path && m.path.length > 0) {
      if (m.pathIdx == null || m.pathIdx < 0) m.pathIdx = 0;
      // 跳过已经走过的路径点
      while (m.pathIdx < m.path.length) {
        const wp = m.path[m.pathIdx];
        const wpx = wp.tx * TILE + TILE / 2;
        const wpy = wp.ty * TILE + TILE / 2;
        if (Math.abs(wpx - m.x) > 5 || Math.abs(wpy - m.y) > 5) break;
        m.pathIdx++;
      }
      let aimX, aimY;
      if (m.pathIdx >= m.path.length) {
        aimX = targetX; aimY = targetY; // 路径走完，直奔目标
      } else {
        const wp = m.path[m.pathIdx];
        aimX = wp.tx * TILE + TILE / 2;
        aimY = wp.ty * TILE + TILE / 2;
      }
      const ddx = aimX - m.x, ddy = aimY - m.y;
      const dd = Math.hypot(ddx, ddy) || 1;
      const nx = m.x + ddx / dd * step;
      const ny = m.y + ddy / dd * step;
      if (canWalkMonster(m, nx, m.y)) m.x = nx;
      if (canWalkMonster(m, m.x, ny)) m.y = ny;
    } else {
      // 无路径（不可达或预算超限）：退回直接滑动
      const dx = targetX - m.x, dy = targetY - m.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = m.x + dx / d * step, ny = m.y + dy / d * step;
      if (canWalkMonster(m, nx, m.y)) m.x = nx;
      if (canWalkMonster(m, m.x, ny)) m.y = ny;
    }
    // 卡住检测：长时间没动就强制重算路径
    const moved = Math.hypot(m.x - prevX, m.y - prevY);
    if (moved < 0.3) {
      m.stuckTimer = (m.stuckTimer || 0) + dt;
      if (m.stuckTimer > 400) { m.repathAt = 0; m.stuckTimer = 0; }
    } else {
      m.stuckTimer = 0;
    }
  }

  function updateCamera() {
    if (!game) return;
    const p = game.player;
    const worldW = (game.scene === 'city' ? game.city.W : game.floor.W) * TILE;
    const worldH = (game.scene === 'city' ? game.city.H : game.floor.H) * TILE;
    let cx = p.x - VIEW_W/2;
    let cy = p.y - VIEW_H/2;
    cx = clamp(cx, 0, Math.max(0, worldW - VIEW_W));
    cy = clamp(cy, 0, Math.max(0, worldH - VIEW_H));
    game.cam.x = cx; game.cam.y = cy;
  }

  // ---------- 拾取 ----------
  const AMMO_PER_PICKUP = 3; // 每个子弹物品给 3 发
  function pickupForPlayer(p, items) {
    for (const it of items) {
      if (it.taken) continue;
      if (dist2(it.x, it.y, p.x, p.y) < 14*14) {
        const def = ITEMS[it.type];
        if (it.type === 'ammo') {
          p.ammo = (p.ammo || 0) + AMMO_PER_PICKUP;
          it.taken = true;
          game.stats.looted++;
          if (p === game.player) toastMsg('拾取 子弹 x' + AMMO_PER_PICKUP + '  (K 开枪)', 1100);
          continue;
        }
        const cap = def.stack || 99;
        if ((p.inv[it.type] || 0) >= cap) continue;
        it.taken = true;
        p.inv[it.type] = (p.inv[it.type] || 0) + 1;
        game.stats.looted++;
        if (p === game.player) toastMsg('拾取 ' + def.name, 1000);
      }
    }
  }
  function tryPickup() {
    if (!game) return;
    let items = null;
    if (game.scene === 'interior') items = game.floor.items;
    else items = game.cityItems || [];
    pickupForPlayer(game.player, items);
    if (game.scene === 'interior') game.floor.items = game.floor.items.filter(i => !i.taken);
    else game.cityItems = (game.cityItems || []).filter(i => !i.taken);
  }
  function autoPickupAll(players) {
    if (!game) return;
    if (!players) players = allPlayers();
    let items = null;
    if (game.scene === 'interior') items = game.floor.items;
    else items = game.cityItems || [];
    for (const pl of players) pickupForPlayer(pl, items);
    if (game.scene === 'interior') game.floor.items = game.floor.items.filter(i => !i.taken);
    else game.cityItems = (game.cityItems || []).filter(i => !i.taken);
  }
  // 兼容旧调用
  function autoPickup() { autoPickupAll(allPlayers()); }

  function updateCitySpawn(dt, players) {
    if (!players) players = allPlayers();
    const now = performance.now();
    if (now > game.nextCitySpawn && game.cityMonsters.length < 12) {
      const kind = Math.random() < 0.65 ? 'zombie' : 'fogman';
      let tx, ty, tries = 0;
      do {
        tx = randi(2, game.city.W-2); ty = randi(2, game.city.H-2); tries++;
      } while (game.city.map[ty*game.city.W+tx] > 1 && tries < 30);
      if (game.city.map[ty*game.city.W+tx] <= 1) {
        const sx = tx*TILE + TILE/2, sy = ty*TILE + TILE/2;
        let far = true;
        for (const pl of players) if (dist2(sx, sy, pl.x, pl.y) < 200*200) far = false;
        if (far) game.cityMonsters.push(makeMonster(kind, sx, sy));
      }
      game.nextCitySpawn = now + rand(12000, 25000);
    }
  }

  // ====================================================================
  //  渲染
  // ====================================================================

  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    if (state === 'MENU') { renderMenu(); return; }
    if (state === 'NAMING') { if (namingReturnState === 'SAVES') renderSaves(); else renderMenu(); renderToast(); return; }
    if (state === 'HOST_NAMING') { renderMenu(); renderToast(); return; }
    if (state === 'JOINING') { renderParty(); renderToast(); return; }
    if (state === 'PARTY') { renderParty(); renderToast(); return; }
    if (state === 'HOST_LOBBY' || state === 'CLIENT_LOBBY') { renderLobby(); renderToast(); return; }
    if (state === 'SAVES') { renderSaves(); return; }
    if (state === 'PAUSED') { renderWorld(); renderPause(); return; }
    if (state === 'DEAD') { renderWorld(); renderDead(); return; }
    if (state === 'PLAYING') { renderWorld(); renderHUD(); }
    renderToast();
  }

  function spawnBloodSplat(x, y, sceneKey) {
    if (!game) return;
    if (!game.bloodDecals) game.bloodDecals = [];
    // 一摊主血 + 几滴飞溅，随机偏移
    const dec = game.bloodDecals;
    dec.push({ x: Math.round(x), y: Math.round(y), scene: sceneKey, r: 3 + Math.random() * 2, big: true });
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 4 + Math.random() * 14;
      dec.push({
        x: Math.round(x + Math.cos(ang) * dist),
        y: Math.round(y + Math.sin(ang) * dist),
        scene: sceneKey,
        r: 1 + Math.random() * 1.5,
        big: false
      });
    }
    // 限制总数，避免无限增长
    if (dec.length > 240) dec.splice(0, dec.length - 240);
  }

  function renderBloodDecals() {
    if (!game || !game.bloodDecals || !game.bloodDecals.length) return;
    const cam = game.cam;
    const myKey = sceneKeyOf(game.player);
    for (const d of game.bloodDecals) {
      if (d.scene !== myKey) continue;
      const sx = d.x - cam.x, sy = d.y - cam.y;
      if (sx < -8 || sy < -8 || sx > VIEW_W + 8 || sy > VIEW_H + 8) continue;
      // 主血摊：暗红半透明圆斑；飞溅：小血滴
      ctx.fillStyle = d.big ? 'rgba(90,10,10,0.55)' : 'rgba(110,15,15,0.6)';
      ctx.fillRect(sx - d.r, sy - d.r, d.r * 2, d.r * 2);
      if (d.big) {
        // 血摊中心更深
        ctx.fillStyle = 'rgba(60,5,5,0.5)';
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
  }

  function renderWorld() {
    if (!game) return;
    // 渲染本地玩家所在场景
    activateScene(sceneOf(game.player));
    if (game.scene === 'city') renderCity();
    else renderInterior();
    // 地板上的血迹（在怪物/玩家之下）
    renderBloodDecals();
    // 怪物
    renderMonsters();
    // 子弹
    renderBullets();
    // 远程玩家：只渲染与本地玩家在同一场景的
    if (game.remotePlayers && game.remotePlayers.length) {
      const myKey = sceneKeyOf(game.player);
      for (const rp of game.remotePlayers) {
        if (sceneKeyOf(rp) === myKey) renderRemotePlayer(rp);
      }
    }
    // 本地玩家
    renderPlayer();
    // 雾
    if (game.fogIntensity > 0) renderFog(game.fogIntensity);
    // 昼夜光影（最上层）
    renderDayNight();
  }

  function renderCity() {
    const { W, H, map } = game.city;
    const cam = game.cam;
    const tx0 = Math.floor(cam.x / TILE);
    const ty0 = Math.floor(cam.y / TILE);
    for (let ty = ty0; ty < ty0 + VIEW_TH + 1; ty++) {
      for (let tx = tx0; tx < tx0 + VIEW_TW + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
          // 外部草地
          ctx.fillStyle = PAL.grassDark;
          ctx.fillRect(tx*TILE - cam.x, ty*TILE - cam.y, TILE, TILE);
          continue;
        }
        const t = map[ty*W + tx];
        const sx = tx*TILE - cam.x, sy = ty*TILE - cam.y;
        drawCityTile(t, sx, sy, tx, ty);
      }
    }
    // 城市掉落物
    const items = game.cityItems || [];
    for (const it of items) {
      if (it.taken) continue;
      drawItem(it, cam);
    }
  }

  function drawCityTile(t, sx, sy, tx, ty) {
    if (t === 0) {
      // 路面
      ctx.fillStyle = PAL.road;
      ctx.fillRect(sx, sy, TILE, TILE);
      // 路面斑点
      if ((tx*7 + ty*13) % 5 === 0) {
        ctx.fillStyle = PAL.asphalt;
        ctx.fillRect(sx+3, sy+4, 2, 2);
      }
      // 路面中央黄线
      if (ty % 6 === 3) {
        ctx.fillStyle = PAL.roadLine;
        ctx.fillRect(sx, sy + TILE/2 - 1, TILE, 2);
      }
    } else if (t === 1) {
      // 人行道
      ctx.fillStyle = PAL.sidewalk;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.asphalt2;
      ctx.fillRect(sx, sy, TILE, 1);
      ctx.fillRect(sx, sy+TILE-1, TILE, 1);
    } else if (t === 2) {
      ctx.fillStyle = PAL.grass;
      ctx.fillRect(sx, sy, TILE, TILE);
      if ((tx+ty) % 2 === 0) {
        ctx.fillStyle = PAL.grassDark;
        ctx.fillRect(sx+5, sy+6, 2, 2);
      }
    } else if (t === 3) {
      // 楼房外墙
      ctx.fillStyle = (tx + ty) % 2 === 0 ? PAL.buildingWall : PAL.buildingWall2;
      ctx.fillRect(sx, sy, TILE, TILE);
      // 窗户
      if ((tx % 3 === 1) && (ty % 3 === 1)) {
        ctx.fillStyle = ((tx*ty) % 7 === 0) ? PAL.buildingWinLit : PAL.buildingWin;
        ctx.fillRect(sx+3, sy+3, 10, 7);
        ctx.fillStyle = PAL.buildingWall2;
        ctx.fillRect(sx+7, sy+3, 1, 7);
      }
    } else if (t === 4) {
      // 普通楼门
      ctx.fillStyle = PAL.buildingWall;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.doorFrame;
      ctx.fillRect(sx+2, sy+1, 12, 14);
      ctx.fillStyle = PAL.door;
      ctx.fillRect(sx+3, sy+2, 10, 12);
      ctx.fillStyle = '#d0c040';
      ctx.fillRect(sx+10, sy+8, 2, 2);
    } else if (t === 5) {
      // home 门（绿色）
      ctx.fillStyle = PAL.buildingWall;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.doorFrame;
      ctx.fillRect(sx+2, sy+1, 12, 14);
      ctx.fillStyle = '#2a8a4a';
      ctx.fillRect(sx+3, sy+2, 10, 12);
      ctx.fillStyle = '#5ad07a';
      ctx.fillRect(sx+4, sy+3, 8, 1);
      ctx.fillStyle = '#d0c040';
      ctx.fillRect(sx+10, sy+8, 2, 2);
    }
  }

  function renderInterior() {
    const f = game.floor;
    const cam = game.cam;
    const tx0 = Math.floor(cam.x / TILE);
    const ty0 = Math.floor(cam.y / TILE);
    for (let ty = ty0; ty < ty0 + VIEW_TH + 1; ty++) {
      for (let tx = tx0; tx < tx0 + VIEW_TW + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) continue;
        const t = f.map[ty*f.W + tx];
        const sx = tx*TILE - cam.x, sy = ty*TILE - cam.y;
        drawInteriorTile(t, sx, sy, tx, ty);
      }
    }
    // 物品
    for (const it of f.items) {
      if (it.taken) continue;
      drawItem(it, cam);
    }
  }

  function drawInteriorTile(t, sx, sy, tx, ty) {
    // 地板
    ctx.fillStyle = (tx + ty) % 2 === 0 ? PAL.interiorFloor : PAL.interiorFloor2;
    ctx.fillRect(sx, sy, TILE, TILE);
    if (t === 1) {
      ctx.fillStyle = (tx + ty) % 2 === 0 ? PAL.interiorWall : PAL.interiorWall2;
      ctx.fillRect(sx, sy, TILE, TILE);
      // 墙顶亮边
      ctx.fillStyle = '#4a4a54';
      ctx.fillRect(sx, sy, TILE, 2);
    } else if (t === 2) {
      // 楼梯上
      ctx.fillStyle = PAL.stair;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.stairDark;
      for (let i = 0; i < 4; i++) ctx.fillRect(sx+1, sy+2+i*3, 14, 2);
      ctx.fillStyle = '#d0d040';
      ctx.fillRect(sx+6, sy+2, 4, 4);
    } else if (t === 3) {
      // 楼梯下
      ctx.fillStyle = PAL.stair;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.stairDark;
      for (let i = 0; i < 4; i++) ctx.fillRect(sx+1, sy+8-i*3, 14, 2);
      ctx.fillStyle = '#d0d040';
      ctx.fillRect(sx+6, sy+10, 4, 4);
    } else if (t === 4) {
      // 出口门
      ctx.fillStyle = PAL.interiorWall;
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = PAL.doorFrame;
      ctx.fillRect(sx+2, sy, 12, 16);
      ctx.fillStyle = '#2a6a8a';
      ctx.fillRect(sx+3, sy+1, 10, 14);
      ctx.fillStyle = '#d0c040';
      ctx.fillRect(sx+10, sy+8, 2, 2);
      // 出口标识
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(sx+5, sy+3, 6, 1);
    }
  }

  function drawItem(it, cam) {
    const def = ITEMS[it.type];
    const sx = it.x - cam.x, sy = it.y - cam.y;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(sx - 4, sy + 4, 8, 2);
    // 物品方块
    ctx.fillStyle = def.color;
    ctx.fillRect(sx - 4, sy - 4, 8, 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(sx - 4, sy - 4, 8, 1);
    ctx.fillRect(sx - 4, sy + 3, 8, 1);
    // 高亮闪烁
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    ctx.fillStyle = `rgba(255,255,200,${0.2 + 0.3*pulse})`;
    ctx.fillRect(sx - 5, sy - 5, 10, 1);
  }

  // 绘制单只僵尸：人形、恐怖嘴、不同衣着、腐烂、血迹，攻击时扑咬
  function drawZombie(m, sx, sy, def) {
    const flash = m.hurtFlash > 0;
    const cloth = m.clothColor || '#5a3a2a';
    const clothDark = '#2a2a2a';     // 裤子/阴影
    const skin = flash ? '#ffffff' : def.color;
    const skinDark = flash ? '#ffffff' : def.color2;
    const flesh = flash ? '#ffffff' : '#7a3a3a';   // 烂肉
    const blood = flash ? '#ffffff' : '#5a0a0a';   // 血迹
    const bone = flash ? '#ffffff' : '#c8c0a0';    // 露骨
    const mouth = '#2a0808';                        // 嘴腔
    const tooth = '#e8e0c0';                        // 牙
    const eye = def.eye;

    // 扑咬动画：参考生化危机——扑出去→落地→蹲下啃食（保持，不反复伸缩）
    const now = performance.now();
    const atkAge = now - (m.lastAtk || 0);
    const LUNGE_DUR = 720;   // 略大于 atkCd(700)，连续攻击间不会站起
    const t = atkAge / LUNGE_DUR;
    // 是否正在"扑"过来（贴身啃食时为 false，不前扑也不跳）
    const pouncing = !!m.pouncing;
    // fwd / lift 只在扑过来时起作用；贴身啃食时为 0
    let fwd, lift;
    if (pouncing) {
      if (t < 0.30) { const k = t / 0.30; fwd = 1 - Math.pow(1 - k, 2.2); } else fwd = 1;
      if (t < 0.35) { const leapAmt = Math.max(0, ((m.atkDist || 0) - 12)) / 26; lift = Math.sin(Math.PI * (t / 0.35)) * 7 * leapAmt; } else lift = 0;
    } else {
      fwd = 0; lift = 0;
    }
    // lean/crouch: 只在 lunging（t<1，最近攻击过）时才弯腰蹲下啃食；
    // 动画结束（t>=1，玩家逃脱不再攻击）则回到 0 站起，头抬高。
    // 连续攻击时 t 不会到 1（每 700ms 重置），所以保持弯腰不反复伸缩；停止攻击后才站起。
    const lunging = t < 1;
    let lean, crouch;
    if (!lunging) {
      lean = 0; crouch = 0;
    } else if (pouncing) {
      if (t < 0.20) { const k = t / 0.20; lean = 1 - Math.pow(1 - k, 2.2); } else lean = 1;
      if (t < 0.35) crouch = 0;
      else if (t < 0.45) { const k = (t - 0.35) / 0.10; crouch = 1 - Math.pow(1 - k, 2); }
      else crouch = 1;
    } else {
      // 贴身啃食：保持弯腰蹲下（不伸缩）
      lean = 1; crouch = 1;
    }
    // 蹲下啃食：头部快速摆动 + 嘴张合撕咬
    const gnawActive = t > 0.42 && t < 0.80;
    const gnaw = gnawActive ? Math.sin((t - 0.42) * 55) : 0;
    const gnawOpen = gnawActive ? (0.5 + 0.5 * Math.sin((t - 0.42) * 55)) : 0;
    const lungeEase = lean;   // 兼容下面用 lungeEase 的地方（弯腰/手臂/嘴）
    const adx = m.atkDx || 0, ady = m.atkDy || 0;
    // 扑咬方向的水平垂直分量（用于手臂向外张开）
    const perpX = -ady, perpY = adx;

    // 走路摆动：踉踉跄跄（参考植物大战僵尸）——身体和腿用同一个 phase 派生，节奏同步，不脱节
    const phase = Number.isFinite(m.walkPhase) ? m.walkPhase : 0;
    // 整个身体上下颠簸：每步一次（与腿同频）
    const bob = lunging ? 0 : Math.sin(phase) * 1.4;
    // 整个身体左右摇晃：每两步一次（phase*0.5，与腿 2:1 同步），应用到身体基点，腿和上身一起晃
    const sway = lunging ? 0 : Math.sin(phase * 0.5) * 1.6;
    // 步态：一前一后拖沓，幅度差（左腿大步迈、右腿拖），一瘸一拐
    const legA = lunging ? 0 : Math.sin(phase) * 4.5;        // 左腿大步迈
    const legB = lunging ? 0 : Math.sin(phase + 2.4) * 1.5;   // 右腿拖（幅度小、相位错开）
    // 偶尔的踉跄前倾（每两步一次，与摇晃同频，小幅）
    const lurch = lunging ? 0 : Math.max(0, Math.sin(phase * 0.5)) * 1.5;
    // 头部小幅滞后摆动（与身体同频）
    const headSway = lunging ? 0 : Math.sin(phase * 0.5 + 1.1) * 1.0;

    // 整个身体腾空扑向玩家（跳跃）——向前扑出后落地停在前方
    // 扑出距离 = 攻击时到玩家的实际距离，刚好扑到玩家位置（不乱跳）
    const leapPx = Math.max(8, Math.min(m.atkDist || 14, 38));
    // 侧向偏移：让多只僵尸扑到玩家周围不同位置，不重叠（嘴仍朝玩家）
    const spread = (m.atkSpread || 0) * 9 * fwd;
    const leapX = adx * leapPx * fwd + perpX * spread;
    const leapY = ady * leapPx * 0.5 * fwd + perpY * spread * 0.5;
    // 地面位置（影子落点）= 起跳后身体在地面上的投影
    const groundX = sx + leapX;
    const groundY = sy + leapY;
    // 行走方向（朝玩家）——提前算好，上身前倾和腿迈步都用它，保证同步
    let wdx = 0, wdy = 1;
    if (game && game.player) {
      const pdx = game.player.x - m.x, pdy = game.player.y - m.y;
      const pd = Math.hypot(pdx, pdy) || 1;
      wdx = pdx / pd; wdy = pdy / pd;
    }
    // 上身跟脚步同步前倾（以脚为轴倾斜，不是平移）：两脚交替前摆，每步一次前倾脉冲
    // max(0,sin) 取每条腿"前摆"的半周，两腿相加 → 每步一个前倾脉冲（交替腿）
    const stepLean = lunging ? 0 : (Math.max(0, Math.sin(phase)) + Math.max(0, Math.sin(phase + Math.PI + 0.5))) * 1.8;
    // 身体实际绘制位置 = 地面位置往上抬 lift 像素（落地时 lift=0）；蹲下时身体往下沉
    // 走路时整个身体基点一起左右摇晃（腿和上身一起晃，不脱节）
    const ox = groundX + sway;
    const oy = groundY - lift + bob + crouch * 3;
    // 上身以腰为轴前倾（弯腰），在跳跃基础上再前倾；走路时加跟脚步同步的前倾（每步脉冲）+ 小幅踉跄
    const LEAN_PX = 7;
    const leanX = adx * LEAN_PX * lean + wdx * stepLean + lurch * (m.facing === 1 ? -1 : 1);
    const leanY = ady * LEAN_PX * 0.45 * lean + wdy * stepLean * 0.5 + lurch * 0.5;
    const tx = ox + leanX;
    const ty = oy + leanY;
    // 头再额外前探+下扎（咬人的点，冲在最前最下）；蹲下啃食时头更低并摆动；
    // 走路时头跟着松散摆动 + 比上身前倾更多（以脚为轴前倾，头领先最多）
    const headLeadX = adx * 6 * lean + wdx * stepLean * 0.9 + (lunging ? 0 : headSway);
    const headLeadY = ady * 4 * lean + wdy * stepLean * 0.6 + (2 + crouch * 4) * lean + gnaw * 1.5;

    // ---- 扑咬运动残影（仅在向前扑的阶段 t<0.45 显示，身后拖尾）----
    if (t < 0.45 && fwd > 0.05) {
      const streaks = 3;
      for (let i = 1; i <= streaks; i++) {
        const k = (i / streaks) * fwd;
        ctx.fillStyle = `rgba(90,122,58,${0.16 * k})`;
        ctx.fillRect(tx - adx * i * 5 - 4, ty - ady * i * 3 - 5, 8, 10);
      }
    }

    // ---- 腾空影子（留在地面 groundX,groundY，身体被抬到影子上方，体现"跳起来"）----
    if (lift > 0.05) {
      ctx.fillStyle = `rgba(0,0,0,${0.30 * (lift / 7)})`;
      const sw = 10 - 4 * (lift / 7);   // 跳得越高影子越小越淡
      ctx.fillRect(groundX - sw / 2, groundY + 5, sw, 3);
    }

    // ---- 腿 ----
    ctx.fillStyle = clothDark;
    if (lift > 0.05) {
      // 腾空时双腿蜷起（屈膝前收），不是直直踩在地上
      const tuck = 3 * (lift / 7);
      ctx.fillRect(ox - 4, oy + 2, 3, 7 - tuck);   // 左腿屈起
      ctx.fillRect(ox + 1, oy + 2, 3, 7 - tuck);   // 右腿屈起
      // 脚（深色鞋）
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(ox - 5, oy + 8 - tuck, 4, 2);
      ctx.fillRect(ox + 1, oy + 8 - tuck, 4, 2);
    } else if (crouch > 0.05) {
      // 蹲下啃食：双腿屈膝外撇（蹲姿），身体压低
      const bend = crouch * 2;
      ctx.fillStyle = clothDark;
      ctx.fillRect(ox - 5, oy + 2, 3, 7 - bend);   // 左腿屈膝外撇
      ctx.fillRect(ox + 2, oy + 2, 3, 7 - bend);   // 右腿屈膝外撇
      // 脚
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(ox - 6, oy + 8 - bend, 4, 2);
      ctx.fillRect(ox + 2, oy + 8 - bend, 4, 2);
    } else if (lunging) {
      // 落地后双腿落地支撑（已停在前方）
      ctx.fillRect(ox - 4, oy + 2, 3, 7);
      ctx.fillRect(ox + 1, oy + 2, 3, 7);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(ox - 5, oy + 8, 4, 2);
      ctx.fillRect(ox + 1, oy + 8, 4, 2);
    } else {
      // 走路：关节式骨骼步态（髋→膝→脚，大腿+小腿两段，真实步态周期），再叠加僵尸拖沓
      // 行走方向 wdx,wdy 已在上面算好（上身前倾和腿迈步共用，保证同步）
      // 画一段骨骼（2px 粗，沿连线步进）
      const drawSeg = (x0, y0, x1, y1) => {
        const steps = 6;
        for (let i = 0; i <= steps; i++) {
          const k = i / steps;
          ctx.fillRect(Math.round(x0 + (x1 - x0) * k) - 1, Math.round(y0 + (y1 - y0) * k), 2, 1);
        }
      };
      // 画一条带关节的腿（大腿+小腿），沿行走方向迈步
      // lp: 该腿相位；drag: 拖沓系数（1=正常，<1=拖腿）
      const drawJointedLeg = (hipX, hipY, lp, drag) => {
        const thighLen = 4, shinLen = 5;
        const swing = Math.sin(lp) * drag;            // 大腿前后摆（沿行走方向），-1..1
        const kneeBend = Math.max(0, Math.sin(lp + 1.1)) * 2.0 * drag;  // 膝盖弯曲（摆动相抬腿时弯曲）
        // 大腿向量：主要向下，沿行走方向大幅前后摆（让后脚能迈到前脚前面）
        const thighDx = wdx * swing * 4.5;
        const thighDy = thighLen;
        const kneeX = hipX + thighDx;
        const kneeY = hipY + thighDy;
        // 小腿向量：从膝盖向下，膝盖弯曲时小腿往后收（抬脚）；前摆时小腿往前伸（迈出去）
        const shinDx = wdx * swing * 2.5 - wdx * kneeBend * 0.6;
        const shinDy = shinLen - kneeBend * 0.4;
        const footX = kneeX + shinDx;
        const footY = kneeY + shinDy;
        // 画大腿（髋→膝）
        ctx.fillStyle = clothDark;
        drawSeg(hipX, hipY, kneeX, kneeY);
        // 画小腿（膝→脚）
        drawSeg(kneeX, kneeY, footX, footY);
        // 膝盖关节点
        ctx.fillStyle = skinDark;
        ctx.fillRect(Math.round(kneeX) - 1, Math.round(kneeY), 2, 1);
        // 脚（深色鞋）
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(Math.round(footX) - 2, Math.round(footY), 4, 2);
        return { footX, footY };
      };
      // 左腿：正常迈步（相位 phase）；右腿：僵尸拖腿（相位错开 + 拖沓系数小，一瘸一拐）
      const lFoot = drawJointedLeg(ox - 2, oy + 2, phase, 1.0);
      const rFoot = drawJointedLeg(ox + 2, oy + 2, phase + Math.PI + 0.5, 0.55);
      // 右腿腐烂露骨（膝盖处）
      ctx.fillStyle = bone;
      ctx.fillRect(Math.round(ox + 2 + wdx * Math.sin(phase + Math.PI + 0.5) * 2.0) - 1, Math.round(oy + 2 + 4), 1, 1);
      // 脚边血迹（右脚拖过的痕迹）
      ctx.fillStyle = blood;
      ctx.fillRect(Math.round(rFoot.footX) - 2, Math.round(rFoot.footY) + 2, 4, 1);
    }

    // ---- 身体（衣着）—— 用上身基准 tx,ty（以腰为轴前倾）----
    ctx.fillStyle = cloth;
    ctx.fillRect(tx - 4, ty - 4, 8, 7);
    // 衣服下摆阴影
    ctx.fillStyle = skinDark;
    ctx.fillRect(tx - 4, ty + 1, 8, 2);
    // 腐烂露肉块
    ctx.fillStyle = flesh;
    ctx.fillRect(tx - 2, ty - 2, 3, 2);
    ctx.fillRect(tx + 2, ty + 1, 2, 2);
    // 血迹泼洒
    ctx.fillStyle = blood;
    ctx.fillRect(tx - 3, ty - 1, 3, 2);
    ctx.fillRect(tx + 1, ty + 2, 3, 1);
    ctx.fillRect(tx - 1, ty - 3, 1, 1);
    // 露出的肋骨
    ctx.fillStyle = bone;
    ctx.fillRect(tx - 1, ty - 3, 1, 3);
    ctx.fillRect(tx + 1, ty - 2, 1, 2);

    // ---- 手臂 ----
    ctx.fillStyle = skin;
    if (lunging) {
      // 扑咬：双臂沿扑咬方向前伸但向外张开（拥抱式抓取，不是出拳）
      // 头部才是咬人的主力，手臂只是抓
      const shY = ty - 2;   // 肩膀在躯干上部（脖子下方），手臂从躯干伸出，不是从头
      const reach = 2.5 + 1.2 * lungeEase;   // 手臂前伸很短，绝不超过头部前探距离，头始终冲在最前
      const drawGrabArm = (shoulderX, spreadSign) => {
        // 沿扑咬方向前伸，同时沿垂直方向向外张开（spreadSign = ±1）
        const dx = adx * reach + perpX * spreadSign * 1.2;
        const dy = ady * reach + perpY * spreadSign * 1.2;
        // 上臂（肩→肘）
        const ex = Math.round(shoulderX + dx * 0.5);
        const ey = Math.round(shY + dy * 0.5);
        ctx.fillRect(shoulderX, shY, 2, 2);
        ctx.fillRect(ex, ey, 2, 2);
        // 前臂（肘→爪）
        const hx = Math.round(shoulderX + dx);
        const hy = Math.round(shY + dy);
        ctx.fillRect(hx, hy, 2, 2);
        // 张开的爪（露骨，3 根指呈扇形）
        ctx.fillStyle = bone;
        ctx.fillRect(hx - 1, hy, 1, 1);
        ctx.fillRect(hx + 2, hy, 1, 1);
        ctx.fillRect(hx, hy + (ady >= 0 ? 2 : -1), 1, 1);
        ctx.fillStyle = skin;
      };
      drawGrabArm(tx - 3, -1);   // 左臂向左张
      drawGrabArm(tx + 1, 1);    // 右臂向右张
    } else {
      // 平时双臂垂下、略前伸（僵尸姿态）——从躯干两侧伸出，不在头部
      ctx.fillRect(tx - 5, ty - 1, 2, 5);
      ctx.fillRect(tx + 3, ty - 1, 2, 5);
      // 一只手露骨
      ctx.fillStyle = bone;
      ctx.fillRect(tx - 5, ty + 3, 2, 1);
      ctx.fillRect(tx + 3, ty + 3, 2, 1);
    }

    // ---- 头（扑咬时头部冲到最前最下，是咬人的主力）----
    // 头抬高一点，留出脖子，让头/身/腿层次清晰
    const hx = tx + headLeadX, hy = ty - 11 + headLeadY;
    // 脖子（连接头和身体，加粗让头身分离明显）
    ctx.fillStyle = skinDark;
    ctx.fillRect(tx - 2, ty - 6, 4, 3);
    // 下巴阴影（头底下一条暗线，强化头身分界）
    ctx.fillStyle = '#000';
    ctx.fillRect(tx - 3, ty - 6, 6, 1);
    // 头部朝向：以扑咬方向为准，五官画在朝玩家那一侧
    let faceDir;
    if (Math.abs(adx) >= Math.abs(ady)) faceDir = adx >= 0 ? 'right' : 'left';
    else faceDir = ady >= 0 ? 'down' : 'up';
    if (!lunging && !gnawActive) faceDir = 'down';  // 平时朝下
    const openAmt = gnawActive ? gnawOpen : (lunging ? 1 : 0.3);
    const mh = 1 + Math.round(openAmt * 2);   // 嘴张开度 1→3

    ctx.fillStyle = skin;
    ctx.fillRect(hx - 3, hy, 6, 5);
    // 头部腐烂斑
    ctx.fillStyle = flesh;
    ctx.fillRect(hx - 2, hy + 1, 2, 1);
    ctx.fillRect(hx + 1, hy + 3, 2, 1);
    // 稀疏头发（画在头顶，即脸的反方向）
    ctx.fillStyle = '#1a1a1a';
    if (faceDir === 'down') { ctx.fillRect(hx-3,hy,2,1); ctx.fillRect(hx+1,hy,2,1); }
    else if (faceDir === 'up') { ctx.fillRect(hx-3,hy+4,2,1); ctx.fillRect(hx+1,hy+4,2,1); }
    else if (faceDir === 'right') { ctx.fillRect(hx-3,hy,1,2); ctx.fillRect(hx-3,hy+3,1,2); }
    else { ctx.fillRect(hx+2,hy,1,2); ctx.fillRect(hx+2,hy+3,1,2); }

    // 眼睛（恐怖红）+ 眼眶暗影，按朝向放置
    ctx.fillStyle = '#000';
    if (faceDir === 'down' || faceDir === 'up') {
      ctx.fillRect(hx - 2, hy + 1, 1, 2);
      ctx.fillRect(hx + 1, hy + 1, 1, 2);
      ctx.fillStyle = eye;
      ctx.fillRect(hx - 2, hy + 2, 1, 1);
      ctx.fillRect(hx + 1, hy + 2, 1, 1);
    } else {
      ctx.fillRect(hx - 2, hy + 1, 2, 1);
      ctx.fillRect(hx - 2, hy + 3, 2, 1);
      ctx.fillStyle = eye;
      ctx.fillRect(hx - 1, hy + 1, 1, 1);
      ctx.fillRect(hx - 1, hy + 3, 1, 1);
    }

    // ---- 嘴（恐怖，按朝向画在朝玩家那一侧）----
    // 嘴腔 + 牙 + 獠牙 + 溅血，方向由 faceDir 决定
    if (faceDir === 'down') {
      ctx.fillStyle = mouth;
      ctx.fillRect(hx - 3, hy + 4, 6, mh);
      ctx.fillStyle = tooth;
      ctx.fillRect(hx - 3, hy + 4, 1, 1); ctx.fillRect(hx - 1, hy + 4, 1, 1);
      ctx.fillRect(hx + 1, hy + 4, 1, 1); ctx.fillRect(hx + 2, hy + 4, 1, 1);
      if (mh >= 2) { ctx.fillRect(hx-2,hy+4+mh-1,1,1); ctx.fillRect(hx,hy+4+mh-1,1,1); ctx.fillRect(hx+1,hy+4+mh-1,1,1); }
      ctx.fillStyle = bone; ctx.fillRect(hx-2,hy+5,1,1); ctx.fillRect(hx+2,hy+5,1,1);
      if (lunging||gnawActive){ctx.fillStyle=blood;ctx.fillRect(hx-3,hy+4+mh,1,1);ctx.fillRect(hx+3,hy+4+mh,1,1);ctx.fillRect(hx-1,hy+5+mh,2,1);}
    } else if (faceDir === 'up') {
      ctx.fillStyle = mouth;
      ctx.fillRect(hx - 3, hy, 6, mh);
      ctx.fillStyle = tooth;
      ctx.fillRect(hx - 3, hy + mh - 1, 1, 1); ctx.fillRect(hx - 1, hy + mh - 1, 1, 1);
      ctx.fillRect(hx + 1, hy + mh - 1, 1, 1); ctx.fillRect(hx + 2, hy + mh - 1, 1, 1);
      if (mh >= 2) { ctx.fillRect(hx-2,hy,1,1); ctx.fillRect(hx,hy,1,1); ctx.fillRect(hx+1,hy,1,1); }
      ctx.fillStyle = bone; ctx.fillRect(hx-2,hy+1,1,1); ctx.fillRect(hx+2,hy+1,1,1);
      if (lunging||gnawActive){ctx.fillStyle=blood;ctx.fillRect(hx-3,hy-1,1,1);ctx.fillRect(hx+3,hy-1,1,1);ctx.fillRect(hx-1,hy-1,2,1);}
    } else if (faceDir === 'right') {
      // 嘴在头右侧（朝玩家），竖向嘴
      ctx.fillStyle = mouth;
      ctx.fillRect(hx + 3 - mh, hy + 1, mh, 3);
      ctx.fillStyle = tooth;
      ctx.fillRect(hx + 2, hy + 1, 1, 1); ctx.fillRect(hx + 2, hy + 3, 1, 1);
      if (mh >= 2) { ctx.fillRect(hx+3-mh,hy+1,1,1); ctx.fillRect(hx+3-mh,hy+3,1,1); }
      ctx.fillStyle = bone; ctx.fillRect(hx + 2, hy + 2, 1, 1);
      if (lunging||gnawActive){ctx.fillStyle=blood;ctx.fillRect(hx+3,hy+1,1,1);ctx.fillRect(hx+3,hy+3,1,1);ctx.fillRect(hx+4,hy+2,1,1);}
    } else { // left
      ctx.fillStyle = mouth;
      ctx.fillRect(hx - 3, hy + 1, mh, 3);
      ctx.fillStyle = tooth;
      ctx.fillRect(hx - 3, hy + 1, 1, 1); ctx.fillRect(hx - 3, hy + 3, 1, 1);
      if (mh >= 2) { ctx.fillRect(hx-3+mh-1,hy+1,1,1); ctx.fillRect(hx-3+mh-1,hy+3,1,1); }
      ctx.fillStyle = bone; ctx.fillRect(hx - 3, hy + 2, 1, 1);
      if (lunging||gnawActive){ctx.fillStyle=blood;ctx.fillRect(hx-4,hy+1,1,1);ctx.fillRect(hx-4,hy+3,1,1);ctx.fillRect(hx-5,hy+2,1,1);}
    }
  }

  function renderMonsters() {
    const cam = game.cam;
    for (const m of currentMonsters()) {
      if (!m.alive) continue;
      const sx = m.x - cam.x, sy = m.y - cam.y;
      if (sx < -24 || sx > VIEW_W + 24 || sy < -24 || sy > VIEW_H + 24) continue;
      const def = MON[m.kind];
      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(sx - 5, sy + 5, 10, 2);
      if (m.kind === 'zombie') {
        drawZombie(m, sx, sy, def);
      } else {
        // 雾中人：保持原有简洁造型
        const flash = m.hurtFlash > 0;
        ctx.fillStyle = flash ? '#ffffff' : def.color;
        ctx.fillRect(sx - 4, sy - 5, 8, 10);
        ctx.fillStyle = flash ? '#ffffff' : def.color2;
        ctx.fillRect(sx - 4, sy + 1, 8, 4);
        ctx.fillStyle = flash ? '#ffffff' : def.color;
        ctx.fillRect(sx - 3, sy - 8, 6, 4);
        ctx.fillStyle = def.eye;
        ctx.fillRect(sx - 2, sy - 7, 1, 2);
        ctx.fillRect(sx + 1, sy - 7, 1, 2);
        // 雾中人周围雾
        ctx.fillStyle = 'rgba(180,190,210,0.18)';
        ctx.fillRect(sx - 10, sy - 12, 20, 22);
      }
      // 血条
      if (m.hp < m.maxHp) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx - 5, sy - 14, 10, 2);
        ctx.fillStyle = PAL.danger;
        ctx.fillRect(sx - 5, sy - 14, Math.ceil(10 * m.hp / m.maxHp), 2);
      }
    }
  }

  function renderPlayer() {
    const p = game.player;
    const cam = game.cam;
    const sx = p.x - cam.x, sy = p.y - cam.y;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(sx - 5, sy + 5, 10, 2);
    // 身体
    const flash = (p.hurtFlash || 0) > 0;
    const phase = Number.isFinite(p.walkPhase) ? p.walkPhase : 0;
    const bob = Math.sin(phase) * 1;
    ctx.fillStyle = flash ? '#ffffff' : '#3a5a8a';
    ctx.fillRect(sx - 4, sy - 4 + bob, 8, 8);
    // 头
    ctx.fillStyle = flash ? '#ffffff' : '#d0a070';
    ctx.fillRect(sx - 3, sy - 8 + bob, 6, 4);
    // 头发
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(sx - 3, sy - 8 + bob, 6, 2);
    // 眼睛
    ctx.fillStyle = '#000';
    if (p.facing === 0) { // 下
      ctx.fillRect(sx - 2, sy - 5 + bob, 1, 1);
      ctx.fillRect(sx + 1, sy - 5 + bob, 1, 1);
    } else if (p.facing === 1) { // 左
      ctx.fillRect(sx - 2, sy - 6 + bob, 1, 1);
    } else if (p.facing === 2) { // 右
      ctx.fillRect(sx + 1, sy - 6 + bob, 1, 1);
    } else { // 上
      // 看不见眼睛
    }
    // 腿（简单摆动）
    ctx.fillStyle = '#2a2a3a';
    const legSwing = Math.sin(p.walkPhase * 2) * 1;
    ctx.fillRect(sx - 3, sy + 4 + bob, 2, 3 + legSwing);
    ctx.fillRect(sx + 1, sy + 4 + bob, 2, 3 - legSwing);
    // 攻击挥砍动画（沿鼠标瞄准方向）
    const now = performance.now();
    if (now - p.lastAtk < 150) {
      const aim = p.lastAim || { dx: dirX(p.facing), dy: dirY(p.facing) };
      ctx.fillStyle = '#f0e0a0';
      ctx.fillRect(sx + aim.dx*8 - 2, sy + aim.dy*8 - 2, 4, 4);
      // 挥砍弧线
      ctx.fillStyle = 'rgba(240,224,160,0.5)';
      ctx.fillRect(sx + aim.dx*12 - 1, sy + aim.dy*12 - 1, 3, 3);
    }
  }

  // 远程玩家头像（不同颜色，带名字）
  const REMOTE_COLORS = ['#8a3a5a','#5a8a3a','#8a6a3a','#5a3a8a','#3a8a8a'];
  function renderRemotePlayer(p) {
    const cam = game.cam;
    const sx = p.x - cam.x, sy = p.y - cam.y;
    if (sx < -20 || sx > VIEW_W + 20 || sy < -20 || sy > VIEW_H + 20) return;
    const colIdx = (p.id || 0) % REMOTE_COLORS.length;
    const body = REMOTE_COLORS[colIdx];
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(sx - 5, sy + 5, 10, 2);
    const flash = (p.hurtFlash || 0) > 0;
    const phase = Number.isFinite(p.walkPhase) ? p.walkPhase : 0;
    const bob = Math.sin(phase) * 1;
    ctx.fillStyle = flash ? '#ffffff' : body;
    ctx.fillRect(sx - 4, sy - 4 + bob, 8, 8);
    ctx.fillStyle = flash ? '#ffffff' : '#d0a070';
    ctx.fillRect(sx - 3, sy - 8 + bob, 6, 4);
    ctx.fillStyle = '#2a2a1a';
    ctx.fillRect(sx - 3, sy - 8 + bob, 6, 2);
    ctx.fillStyle = '#000';
    if (p.facing === 0) { ctx.fillRect(sx - 2, sy - 5 + bob, 1, 1); ctx.fillRect(sx + 1, sy - 5 + bob, 1, 1); }
    else if (p.facing === 1) { ctx.fillRect(sx - 2, sy - 6 + bob, 1, 1); }
    else if (p.facing === 2) { ctx.fillRect(sx + 1, sy - 6 + bob, 1, 1); }
    ctx.fillStyle = '#2a2a3a';
    const legSwing = Math.sin((phase) * 2) * 1;
    ctx.fillRect(sx - 3, sy + 4 + bob, 2, 3 + legSwing);
    ctx.fillRect(sx + 1, sy + 4 + bob, 2, 3 - legSwing);
    // 攻击挥砍动画（沿瞄准方向），让主机也能看到远程玩家出拳
    const nowR = performance.now();
    if (p.lastAtk && nowR - p.lastAtk < 150) {
      const aim = p.lastAim || { dx: dirX(p.facing), dy: dirY(p.facing) };
      ctx.fillStyle = '#f0e0a0';
      ctx.fillRect(sx + aim.dx*8 - 2, sy + aim.dy*8 - 2, 4, 4);
      ctx.fillStyle = 'rgba(240,224,160,0.5)';
      ctx.fillRect(sx + aim.dx*12 - 1, sy + aim.dy*12 - 1, 3, 3);
    }
    // 名字 + HP 条
    ctx.fillStyle = '#fff';
    ctx.font = '9px Microsoft YaHei, Consolas, monospace';
    const nm = p.name || '玩家';
    ctx.textAlign = 'center';
    ctx.fillText(nm, sx, sy - 12);
    ctx.textAlign = 'left';
    const w = 14, hpw = Math.max(0, Math.min(1, (p.hp||0)/(p.maxHp||100))) * w;
    ctx.fillStyle = '#400';
    ctx.fillRect(sx - w/2, sy - 11, w, 2);
    ctx.fillStyle = hpw > 0 ? '#40c060' : '#c04040';
    ctx.fillRect(sx - w/2, sy - 11, hpw, 2);
  }

  function renderFog(intensity) {
    ctx.fillStyle = `rgba(154,160,176,${0.18 * intensity})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 雾中人时雾更浓的暗角
    if (game.scene === 'city' && game.cityMonsters.some(m => m.kind === 'fogman')) {
      const grd = ctx.createRadialGradient(VIEW_W/2, VIEW_H/2, 60, VIEW_W/2, VIEW_H/2, 360);
      grd.addColorStop(0, 'rgba(20,20,30,0)');
      grd.addColorStop(1, `rgba(20,20,30,${0.4 * intensity})`);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }

  // ---------- 昼夜循环 ----------
  // 10 分钟一轮：约 5 分钟白天 + 5 分钟夜晚，中间 20 秒过渡。仅影响视觉，不影响刷怪。
  const DAY_CYCLE_MS = 600000;
  const DAWN_LEN = 0.033;    // 黎明占周期的 3.3%（约 20s）
  const DUSK_START = 0.5;    // 黄昏从周期一半开始
  const DUSK_LEN = 0.033;    // 黄昏占 3.3%
  function getDarkness() {
    if (!game || game.timeMs == null) return 0;
    const t = (game.timeMs % DAY_CYCLE_MS) / DAY_CYCLE_MS;
    if (t < DAWN_LEN) return 1 - t / DAWN_LEN;                 // 黎明：1 -> 0
    if (t < DUSK_START) return 0;                              // 白天
    if (t < DUSK_START + DUSK_LEN) return (t - DUSK_START) / DUSK_LEN; // 黄昏：0 -> 1
    return 1;                                                   // 夜晚
  }
  // 当前时段名（用于 HUD）
  function timeOfDayLabel() {
    const d = getDarkness();
    if (d <= 0.05) return '白天';
    if (d >= 0.95) return '夜晚';
    return d < 0.5 ? '黄昏' : '黎明';
  }

  function renderDayNight() {
    const darkness = getDarkness();
    if (darkness <= 0.01) {
      // 白天：暖色阳光，从顶部洒下的柔光，整体明亮好看
      const sun = ctx.createRadialGradient(VIEW_W * 0.5, -30, 30, VIEW_W * 0.5, -30, 420);
      sun.addColorStop(0, 'rgba(255,236,170,0.12)');
      sun.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      // 极淡的暖色调
      ctx.fillStyle = 'rgba(255,246,214,0.03)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      return;
    }
    // 夜晚：冷色暗调 + 暗角 + 微红血月 + 轻微闪烁（恐怖感，但不太暗）
    const now = performance.now();
    const flicker = 0.92 + 0.05 * Math.sin(now / 130) + 0.03 * Math.sin(now / 47);
    // 基础暗蓝叠加（室内稍弱，有灯光）
    const indoorDamp = (game.scene === 'interior') ? 0.7 : 1;
    const baseA = 0.34 * darkness * indoorDamp;
    ctx.fillStyle = `rgba(8,10,30,${baseA})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 暗角 vignette
    const vg = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, 70, VIEW_W / 2, VIEW_H / 2, 380);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,10,${0.5 * darkness * flicker})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 血月微红（夜晚越深越明显）
    ctx.fillStyle = `rgba(50,0,4,${0.10 * darkness})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 远处偶发"闪电"白光（极低概率，恐怖惊吓）
    if (Math.random() < 0.0015) {
      ctx.fillStyle = 'rgba(220,220,255,0.18)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }

  // ---------- HUD ----------
  function renderHUD() {
    const p = game.player;
    // 顶部状态条
    ctx.fillStyle = PAL.uiBg;
    ctx.fillRect(0, 0, VIEW_W, 28);
    // [调试] 联机状态面板（默认开，按 F3 关）
    if (game.netMode && game.netMode !== 'single' && party.debugHud !== false) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 28, 360, 50);
      ctx.fillStyle = '#80d0ff';
      ctx.font = '9px Consolas, monospace';
      if (game.netMode === 'host') {
        ctx.fillText('HOST myId=' + party.myClientId + ' rp=[' + (game.remotePlayers||[]).map(r=>r.id).join(',') + '] inEvts=' + (party._inputEvents||0), 4, 40);
        const cks = Object.keys(party.clientInputs||{});
        let line2 = 'clientInputs=[' + cks.join(',') + ']';
        for (const id of cks) {
          const ci = party.clientInputs[id];
          const rp = (game.remotePlayers||[]).find(r=>r.id===Number(id));
          line2 += ' | #' + id + ' mv=(' + (ci?ci.mx:0) + ',' + (ci?ci.my:0) + ') pos=(' + (rp?Math.round(rp.x):'?') + ',' + (rp?Math.round(rp.y):'?') + ')';
        }
        ctx.fillText(line2, 4, 52);
        ctx.fillText('local pos=(' + Math.round(game.player.x) + ',' + Math.round(game.player.y) + ') scene=' + sceneKeyOf(game.player), 4, 64);
      } else {
        ctx.fillText('CLIENT myId=' + party.myClientId + ' snaps=' + (party._snapCount||0) + ' sent=' + (party._sentInputs||0) + ' sentAcc=' + Math.round(party.inputSendAcc), 4, 40);
        const lastSent = party._lastSentMv || {mx:0, my:0};
        ctx.fillText('lastSent mv=(' + lastSent.mx + ',' + lastSent.my + ') myPos=(' + Math.round(game.player.x) + ',' + Math.round(game.player.y) + ')', 4, 52);
        ctx.fillText('myScene=' + sceneKeyOf(game.player) + ' rp=[' + (game.remotePlayers||[]).map(r=>r.id).join(',') + ']', 4, 64);
      }
    }
    // HP
    ctx.fillStyle = '#000';
    ctx.fillRect(8, 8, 120, 12);
    ctx.fillStyle = PAL.danger;
    const hpW = Math.ceil(120 * p.hp / p.maxHp);
    ctx.fillRect(8, 8, hpW, 12);
    ctx.fillStyle = PAL.ui;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('HP ' + Math.ceil(p.hp) + '/' + p.maxHp, 12, 14);

    // 名字 / 场景
    ctx.fillStyle = PAL.ui;
    ctx.fillText(p.name, 140, 14);
    ctx.fillStyle = PAL.uiDim;
    const sceneName = game.scene === 'city' ? '城市街道'
                    : (game.curBuilding.isHome ? '安全屋' :
                       game.curBuilding.kind === 'zombie' ? '僵尸楼' :
                       game.curBuilding.kind === 'fog' ? '雾巢' : '未知楼')
                      + ' F' + (game.curFloor+1);
    ctx.fillText(sceneName, 240, 14);

    // 时段（白天/夜晚）
    const tod = timeOfDayLabel();
    const isNight = getDarkness() > 0.5;
    ctx.fillStyle = isNight ? '#9ab0ff' : '#ffd070';
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.fillText((isNight ? '🌙 ' : '☀ ') + tod, 330, 14);

    // 击杀
    ctx.fillStyle = PAL.uiDim;
    ctx.fillText('击杀 ' + (game.stats.kills || 0), 400, 14);

    // 子弹（醒目显示，因为它是远程武器资源）
    const ammo = game.player.ammo || 0;
    ctx.fillStyle = ammo > 0 ? '#ffe070' : PAL.uiDim;
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.fillText(devMode ? '子弹 ∞  [K 开枪]' : ('子弹 x' + ammo + '  [K 开枪]'), 475, 14);

    // 开发者模式标识（不显示按键）
    if (devMode) {
      ctx.fillStyle = '#ff6060';
      ctx.font = 'bold 10px Consolas, monospace';
      ctx.fillText('[ 开发者模式 ]', 595, 14);
    }

    // 物品栏（底部）
    const invY = VIEW_H - 28;
    ctx.fillStyle = PAL.uiBg;
    ctx.fillRect(0, invY, VIEW_W, 28);
    let xi = 8;
    const order = ['medkit','bandage','canned','water','ammo'];
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      // 子弹是直接资源，从 p.ammo 读取；其它从 inv 读取
      const n = (t === 'ammo') ? (p.ammo || 0) : (p.inv[t] || 0);
      const def = ITEMS[t];
      ctx.fillStyle = '#1a1a24';
      ctx.fillRect(xi, invY + 4, 24, 20);
      ctx.fillStyle = (t === 'ammo' && (n > 0 || devMode)) ? '#ffe070' : def.color;
      ctx.fillRect(xi + 2, invY + 6, 8, 8);
      ctx.fillStyle = PAL.ui;
      ctx.font = '8px Consolas, monospace';
      ctx.fillText(def.name, xi + 12, invY + 12);
      ctx.fillStyle = PAL.ui;
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(devMode ? '∞' : ('x' + n), xi + 2, invY + 20);
      // 快捷键（子弹格显示 K，其它显示数字）
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '8px Consolas, monospace';
      ctx.fillText((t === 'ammo') ? 'K' : ((i+1) + ''), xi + 20, invY + 22);
      xi += 30;
    }
    // 提示
    ctx.fillStyle = PAL.uiDim;
    ctx.font = '9px Consolas, monospace';
    const coop = game.netMode && game.netMode !== 'single';
    if (coop) {
      const line = game.netMode === 'host' ? '主机：WASD移动 鼠标瞄准 空格/J挥拳 K开枪 E进出建筑  ESC暂停'
                                          : '客户端：WASD移动 鼠标瞄准 空格/J挥拳 K开枪 E进出建筑  ESC暂停  (各自独立场景)';
      ctx.fillText(line, 8, invY - 6);
      // 队伍 HP（右上）—— 含各自场景标签
      const sceneTag = (pl) => pl.scene === 'city' ? '城' : ('F' + ((pl.curFloor||0)+1));
      let tx = VIEW_W - 8;
      ctx.textAlign = 'right';
      const team = [game.player].concat(game.remotePlayers || []);
      for (let i = team.length - 1; i >= 0; i--) {
        const mp = team[i];
        const nm = (mp.name || '?').slice(0, 6);
        const hpPct = Math.max(0, Math.min(1, (mp.hp||0)/(mp.maxHp||100)));
        ctx.fillStyle = mp === game.player ? '#ffe070' : PAL.ui;
        ctx.font = '9px Microsoft YaHei, Consolas, monospace';
        const label = nm + '[' + sceneTag(mp) + '] ' + Math.ceil(mp.hp||0);
        ctx.fillText(label, tx, 14);
        tx -= ctx.measureText(label).width + 14;
        ctx.fillStyle = '#400';
        ctx.fillRect(tx, 8, 30, 12);
        ctx.fillStyle = hpPct > 0.5 ? '#40c060' : hpPct > 0.2 ? '#e0c040' : '#c04040';
        ctx.fillRect(tx, 8, Math.ceil(30 * hpPct), 12);
        tx -= 36;
      }
      ctx.textAlign = 'left';
    } else {
      ctx.fillText('WASD移动  鼠标瞄准  空格/J挥拳  K开枪  E互动  1-4用物品  R保存  ESC暂停', 8, invY - 6);
    }

    // 鼠标准星
    if (state === 'PLAYING') {
      const mx = Math.round(mousePos.x), my = Math.round(mousePos.y);
      ctx.fillStyle = 'rgba(255,224,112,0.85)';
      ctx.fillRect(mx - 5, my, 3, 1);
      ctx.fillRect(mx + 3, my, 3, 1);
      ctx.fillRect(mx, my - 5, 1, 3);
      ctx.fillRect(mx, my + 3, 1, 3);
      ctx.fillStyle = 'rgba(255,224,112,0.5)';
      ctx.fillRect(mx, my, 1, 1);
    }
  }

  function renderToast() {
    if (!toast) return;
    const now = performance.now();
    if (now > toast.until) { toast = null; return; }
    ctx.fillStyle = PAL.uiBg;
    const w = ctx.measureText(toast.text).width + 16;
    ctx.font = '12px Microsoft YaHei, Consolas, monospace';
    const tw = ctx.measureText(toast.text).width + 16;
    ctx.fillRect(VIEW_W/2 - tw/2, 40, tw, 22);
    ctx.fillStyle = PAL.ui;
    ctx.textBaseline = 'middle';
    ctx.fillText(toast.text, VIEW_W/2 - tw/2 + 8, 51);
  }

  function toastMsg(text, ms) {
    toast = { text, until: performance.now() + ms };
  }

  // ---------- 开发者模式 ----------
  function toggleDevMode() {
    devMode = !devMode;
    if (devMode) {
      // 开启：补满血量，物品视为无限（不实际改 inv，使用时不消耗）
      game.player.hp = game.player.maxHp;
      toastMsg('开发者模式已开启', 1800);
    } else {
      // 关闭：物品清零（包括子弹），血量保留但不超过上限
      game.player.inv = {};
      game.player.ammo = 0;
      if (game.player.hp > game.player.maxHp) game.player.hp = game.player.maxHp;
      toastMsg('开发者模式已关闭，物品已清零', 1800);
    }
  }

  // ---------- 菜单 ----------
  const menuItems = [
    { label: '单人游戏', action: async () => { await refreshSaves(); state = 'SAVES'; saveCursor = -1; } },
    { label: '加入派对', action: () => { attachPartyEvents(); refreshDiscover(); state = 'PARTY'; } }
  ];

  function renderMenu() {
    // 标题背景：像素城市轮廓
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // 远景楼群剪影
    const t = performance.now() / 1000;
    for (let i = 0; i < 18; i++) {
      const bw = 30 + (i*37) % 30;
      const bh = 80 + (i*53) % 180;
      const bx = i * 36 - 10;
      const by = VIEW_H - bh - 60;
      ctx.fillStyle = i % 2 === 0 ? '#15152a' : '#101020';
      ctx.fillRect(bx, by, bw, bh);
      // 窗户
      ctx.fillStyle = ((i*7 + Math.floor(t)) % 11 === 0) ? '#7a8a4a' : '#1a2233';
      for (let wy = 0; wy < Math.floor(bh/14); wy++) {
        for (let wx = 0; wx < Math.floor(bw/10); wx++) {
          if ((wx + wy + i) % 3 !== 0)
            ctx.fillRect(bx + 3 + wx*9, by + 4 + wy*12, 4, 6);
        }
      }
    }
    // 月亮
    ctx.fillStyle = '#e0e0c0';
    ctx.beginPath(); ctx.arc(VIEW_W - 80, 70, 24, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#0a0a14';
    ctx.beginPath(); ctx.arc(VIEW_W - 70, 64, 22, 0, Math.PI*2); ctx.fill();

    // 标题
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 32px Microsoft YaHei, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('像素城市求生', VIEW_W/2 - 100, 120);
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = PAL.uiDim;
    ctx.fillText('PIXEL  CITY  SURVIVAL', VIEW_W/2 - 70, 140);

    // 菜单项
    ctx.font = '16px Microsoft YaHei, Consolas, monospace';
    const menuStartY = 230;
    const menuGap = 34;
    for (let i = 0; i < menuItems.length; i++) {
      const sel = i === menuSel;
      ctx.fillStyle = sel ? '#ffe070' : PAL.ui;
      const y = menuStartY + i * menuGap;
      ctx.fillText((sel ? '▶ ' : '  ') + menuItems[i].label, VIEW_W/2 - 80, y);
    }
    ctx.fillStyle = PAL.uiDim;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText('↑↓ 选择   Enter 确定   （或鼠标点击）', VIEW_W/2 - 90, VIEW_H - 30);
  }

  function menuInput() {
    if (keyPressed['ArrowUp'] || keyPressed['KeyW']) menuSel = (menuSel - 1 + menuItems.length) % menuItems.length;
    if (keyPressed['ArrowDown'] || keyPressed['KeyS']) menuSel = (menuSel + 1) % menuItems.length;
    if (keyPressed['Enter'] || keyPressed['Space']) menuItems[menuSel].action();
  }

  // ---------- 派对界面几何 ----------
  const PARTY_BTN_W = 200, PARTY_BTN_H = 40;
  const PARTY_CREATE = { x: VIEW_W/2 - PARTY_BTN_W - 16, y: 410, w: PARTY_BTN_W, h: PARTY_BTN_H, label: '创建派对' };
  const PARTY_JOIN   = { x: VIEW_W/2 + 16, y: 410, w: PARTY_BTN_W, h: PARTY_BTN_H, label: '加入派对' };
  const PARTY_BACK   = { x: VIEW_W/2 - 60, y: 470, w: 120, h: 28, label: '返回主菜单' };
  const LOBBY_START  = { x: VIEW_W/2 - 90, y: 420, w: 180, h: 40, label: '开始游戏' };
  const LOBBY_LEAVE  = { x: VIEW_W/2 - 70, y: 478, w: 140, h: 28, label: '离开派对' };

  function hitBtn(b, x, y) { return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }

  function renderParty() {
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 22px Microsoft YaHei, Consolas, monospace';
    ctx.fillText('派对', 20, 40);
    ctx.fillStyle = PAL.uiDim;
    ctx.font = '11px Consolas, monospace';
    ctx.fillText('局域网朋友：让对方点"创建派对"，你点列表或输入派对码', 20, 58);
    ctx.fillText('互联网朋友：让对方点"创建派对"，把"联机地址"发你，你输入 地址:端口', 20, 72);

    // 附近的派对
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 14px Microsoft YaHei, Consolas, monospace';
    ctx.fillText('附近的派对（局域网）', 20, 100);
    if (!party.discoverList || party.discoverList.length === 0) {
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '12px Microsoft YaHei, Consolas, monospace';
      ctx.fillText('（暂未发现附近派对…让对方先创建，或在搜索中）', 20, 124);
    } else {
      ctx.font = '12px Microsoft YaHei, Consolas, monospace';
      for (let i = 0; i < party.discoverList.length; i++) {
        const p = party.discoverList[i];
        const y = 116 + i * 30;
        ctx.fillStyle = 'rgba(255,224,112,0.08)';
        ctx.fillRect(20, y - 14, VIEW_W - 40, 26);
        ctx.strokeStyle = '#3a3a52'; ctx.lineWidth = 1;
        ctx.strokeRect(20, y - 14, VIEW_W - 40, 26);
        ctx.fillStyle = '#ffe070';
        ctx.font = 'bold 13px Consolas, monospace';
        ctx.fillText(p.code, 32, y);
        ctx.fillStyle = PAL.ui;
        ctx.font = '12px Microsoft YaHei, Consolas, monospace';
        ctx.fillText('主机：' + (p.hostName || p.name || '?'), 110, y);
        ctx.fillStyle = PAL.uiDim;
        ctx.fillText('玩家 ' + (p.players || 1) + ' 人', 300, y);
        ctx.fillText((p.ip || '') + ':' + (p.port || ''), 380, y);
        ctx.fillStyle = '#80d080';
        ctx.font = '11px Consolas, monospace';
        ctx.fillText('点击加入 ▶', VIEW_W - 92, y);
      }
    }

    // 两个按钮
    drawBigButton(PARTY_CREATE, false);
    drawBigButton(PARTY_JOIN, false);
    drawSmallButton(PARTY_BACK, false);

    // 公网IP提示
    ctx.fillStyle = PAL.uiDim;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText('提示：互联网联机需主机路由器支持 UPnP 或手动端口转发。', 20, VIEW_H - 16);
  }

  function renderLobby() {
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const isHost = party.role === 'host';
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 22px Microsoft YaHei, Consolas, monospace';
    ctx.fillText(isHost ? '派对大厅（你是主机）' : '派对大厅（等待主机开始）', 20, 40);

    if (isHost) {
      // 显示派对码 + 地址
      ctx.fillStyle = '#ffe070';
      ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillText('派对码（局域网）：' + (party.code || '?'), 20, 76);
      ctx.fillStyle = PAL.ui;
      ctx.font = '13px Consolas, monospace';
      let addrLine = '联机地址（互联网）：' + (party.addr || '?');
      const si = party.stateInfo;
      if (si && si.publicIp) addrLine = '联机地址（互联网）：' + si.publicIp + ':' + (si.port || (party.addr||'').split(':')[1]);
      ctx.fillText(addrLine, 20, 96);
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '11px Microsoft YaHei, Consolas, monospace';
      let upnpLine = 'UPnP 端口转发：';
      if (si && si.upnpOk) upnpLine += '已自动开启 ✓（朋友可直接用上面的地址）';
      else if (si && si.publicIp) upnpLine += '未自动开启。若朋友连不上，请在路由器把端口 ' + (si.port) + ' 转发到本机';
      else upnpLine += '检测中…';
      ctx.fillText(upnpLine, 20, 114);
      // 重新拉取状态（公网IP异步）
      if (!si || !si.publicIp) refreshPartyState();
    } else {
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '12px Microsoft YaHei, Consolas, monospace';
      ctx.fillText('已连接到主机：' + (party.hostName || '?'), 20, 76);
    }

    // 玩家列表
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 14px Microsoft YaHei, Consolas, monospace';
    ctx.fillText('玩家列表', 20, 150);
    ctx.font = '13px Microsoft YaHei, Consolas, monospace';
    const players = party.lobbyPlayers || [];
    for (let i = 0; i < players.length; i++) {
      const pl = players[i];
      const y = 174 + i * 26;
      ctx.fillStyle = pl.isHost ? '#ffe070' : PAL.ui;
      ctx.fillText((pl.isHost ? '★ ' : '• ') + (pl.name || '?') + (pl.isHost ? '  (主机)' : ''), 32, y);
    }
    if (players.length === 0) {
      ctx.fillStyle = PAL.uiDim;
      ctx.fillText('（暂无玩家）', 32, 174);
    }

    if (isHost) {
      drawBigButton(LOBBY_START, false);
      drawSmallButton(LOBBY_LEAVE, false);
    } else {
      drawSmallButton(LOBBY_LEAVE, false);
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '11px Microsoft YaHei, Consolas, monospace';
      ctx.fillText('等待主机点击"开始游戏"…', VIEW_W/2 - 80, 430);
    }
  }

  function drawBigButton(b, hover) {
    ctx.fillStyle = hover ? '#2a6a8a' : '#1a3a5a';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = hover ? '#5aaaca' : '#3a5a7a'; ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Microsoft YaHei, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w/2 - ctx.measureText(b.label).width/2, b.y + b.h/2);
    ctx.textBaseline = 'alphabetic';
  }
  function drawSmallButton(b, hover) {
    ctx.fillStyle = hover ? '#3a3a52' : '#222238';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = hover ? '#6a6a82' : '#3a3a4e';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = PAL.ui;
    ctx.font = '12px Microsoft YaHei, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w/2 - ctx.measureText(b.label).width/2, b.y + b.h/2);
    ctx.textBaseline = 'alphabetic';
  }

  function partyInput() {
    if (keyPressed['Escape']) { state = 'MENU'; }
    // 定期刷新附近派对
    party.discoverTimer = (party.discoverTimer || 0) + 1;
    if (party.discoverTimer > 30) { party.discoverTimer = 0; refreshDiscover(); }
  }

  function lobbyInput() {
    if (keyPressed['Escape']) { leaveParty(); state = 'MENU'; }
  }

  function promptNewSave() {
    // 已被命名对话框流程取代
    openNameDialog();
  }

  // ---------- 存档列表 ----------
  // 存档行几何
  const SAVE_ROW_X = 20, SAVE_ROW_W = VIEW_W - 40, SAVE_ROW_H = 50, SAVE_ROW_GAP = 56, SAVE_ROW_Y0 = 80;
  // 底部按钮
  const SAVE_BTN_Y = 444, SAVE_BTN_H = 30, SAVE_BTN_W = 150;
  const SAVE_BTN_ENTER = { x: VIEW_W/2 - SAVE_BTN_W - 10, y: SAVE_BTN_Y, w: SAVE_BTN_W, h: SAVE_BTN_H, label: '进入存档' };
  const SAVE_BTN_NEW   = { x: VIEW_W/2 + 10, y: SAVE_BTN_Y, w: SAVE_BTN_W, h: SAVE_BTN_H, label: '新建存档' };
  const SAVE_BTN_BACK  = { x: VIEW_W/2 - 60, y: SAVE_BTN_Y + SAVE_BTN_H + 6, w: 120, h: 22, label: '返回主菜单' };
  function saveRowAt(x, y) {
    if (x < SAVE_ROW_X || x > SAVE_ROW_X + SAVE_ROW_W) return -1;
    const rel = y - (SAVE_ROW_Y0 - 14);
    if (rel < 0) return -1;
    const i = Math.floor(rel / SAVE_ROW_GAP);
    if (i < 0 || i >= savesList.length) return -1;
    // 行内多余空隙不算
    if (rel - i * SAVE_ROW_GAP > SAVE_ROW_H) return -1;
    return i;
  }

  function renderSaves() {
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 20px Microsoft YaHei, Consolas, monospace';
    ctx.fillText('单人游戏', 20, 36);
    ctx.fillStyle = PAL.uiDim;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText('点击存档以选中 · ↑↓ 选择 · Enter 进入 · Delete 删除 · ESC 返回', 20, 54);

    const hasSel = saveCursor >= 0 && saveCursor < savesList.length;

    if (savesList.length === 0) {
      ctx.fillStyle = PAL.uiDim;
      ctx.font = '14px Microsoft YaHei, Consolas, monospace';
      ctx.fillText('（还没有存档，点击下方「新建存档」开始）', VIEW_W/2 - 170, VIEW_H/2 - 40);
    } else {
      ctx.font = '12px Microsoft YaHei, Consolas, monospace';
      for (let i = 0; i < savesList.length; i++) {
        const s = savesList[i];
        const sel = i === saveCursor;
        const hov = i === saveHover;
        const y = SAVE_ROW_Y0 + i * SAVE_ROW_GAP;
        let bg = 'rgba(255,255,255,0.04)';
        if (hov) bg = 'rgba(255,224,112,0.10)';
        if (sel) bg = 'rgba(255,224,112,0.18)';
        ctx.fillStyle = bg;
        ctx.fillRect(SAVE_ROW_X, y - 14, SAVE_ROW_W, SAVE_ROW_H);
        ctx.strokeStyle = sel ? '#ffe070' : (hov ? '#6a6a52' : '#2a2a3e');
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeRect(SAVE_ROW_X, y - 14, SAVE_ROW_W, SAVE_ROW_H);
        ctx.fillStyle = sel ? '#ffe070' : PAL.ui;
        ctx.font = 'bold 14px Microsoft YaHei, Consolas, monospace';
        ctx.fillText(s.name, 32, y);
        ctx.fillStyle = PAL.uiDim;
        ctx.font = '10px Consolas, monospace';
        const dt = new Date(s.updatedAt || s.createdAt);
        const dateStr = dt.toLocaleString('zh-CN');
        const mins = Math.floor((s.playtime || 0) / 60000);
        ctx.fillText('更新：' + dateStr + '   游玩：' + mins + '分', 32, y + 14);
        ctx.fillText('HP ' + (s.hp||0) + '/' + (s.maxHp||0) + '   击杀 ' + (s.kills||0) + '   场景 ' + (s.scene === 'city' ? '城市' : '楼内'), 32, y + 26);
      }
    }

    // 底部按钮
    drawSaveBtn(SAVE_BTN_ENTER, hasSel);
    drawSaveBtn(SAVE_BTN_NEW, true);
    drawSaveBtn(SAVE_BTN_BACK, true);
  }

  // 通用按钮绘制：enabled 控制亮/灰
  function drawSaveBtn(b, enabled) {
    const hov = hitBtn(b, mousePos.x, mousePos.y);
    ctx.fillStyle = enabled ? (hov ? 'rgba(255,224,112,0.22)' : 'rgba(255,224,112,0.10)') : 'rgba(255,255,255,0.04)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = enabled ? (hov ? '#ffe070' : '#8a8a52') : '#3a3a4e';
    ctx.lineWidth = hov && enabled ? 2 : 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = enabled ? (hov ? '#ffe070' : PAL.ui) : PAL.uiDim;
    ctx.font = 'bold 13px Microsoft YaHei, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + 14, b.y + b.h/2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  function savesInput() {
    if (savesList.length === 0) {
      if (keyPressed['Escape']) state = 'MENU';
      return;
    }
    if (saveCursor >= savesList.length) saveCursor = savesList.length - 1;
    if (keyPressed['ArrowUp'] || keyPressed['KeyW']) saveCursor = saveCursor < 0 ? 0 : (saveCursor - 1 + savesList.length) % savesList.length;
    if (keyPressed['ArrowDown'] || keyPressed['KeyS']) saveCursor = saveCursor < 0 ? 0 : (saveCursor + 1) % savesList.length;
    if ((keyPressed['Enter'] || keyPressed['Space']) && saveCursor >= 0) loadGameById(savesList[saveCursor].id);
    if ((keyPressed['Delete'] || keyPressed['KeyX']) && saveCursor >= 0) {
      const s = savesList[saveCursor];
      window.api.confirm('确定删除存档「' + s.name + '」吗？').then(async (ok) => {
        if (ok) {
          await window.api.deleteSave(s.id);
          await refreshSaves();
          if (saveCursor >= savesList.length) saveCursor = Math.max(-1, savesList.length - 1);
        }
      });
    }
    if (keyPressed['Escape']) state = 'MENU';
  }

  // ---------- 暂停 ----------
  const PAUSE_RESUME = { x: VIEW_W/2 - 80, y: VIEW_H/2 + 14, w: 160, h: 38, label: '返回游戏' };
  function renderPause() {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = PAL.ui;
    ctx.font = 'bold 24px Microsoft YaHei, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('暂停', VIEW_W/2 - 30, VIEW_H/2 - 30);
    // 返回游戏按钮
    drawBigButton(PAUSE_RESUME, hitBtn(PAUSE_RESUME, mousePos.x, mousePos.y));
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = PAL.uiDim;
    const coop = game && game.netMode && game.netMode !== 'single';
    if (coop) ctx.fillText('M 离开派对并返回主菜单', VIEW_W/2 - 110, VIEW_H/2 + 70);
    else ctx.fillText('R 保存    M 返回主菜单', VIEW_W/2 - 90, VIEW_H/2 + 70);
  }

  function pauseInput() {
    const coop = game && game.netMode && game.netMode !== 'single';
    if (keyPressed['Escape']) state = 'PLAYING';
    if (keyPressed['KeyR'] && !coop) { saveGame(); state = 'PLAYING'; }
    if (keyPressed['KeyM']) {
      if (!coop && game) saveGame();
      if (coop) leaveParty();
      state = 'MENU';
      game = null;
    }
  }

  // ---------- 死亡 ----------
  function renderDead() {
    ctx.fillStyle = 'rgba(60,0,0,0.65)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = PAL.danger;
    ctx.font = 'bold 32px Microsoft YaHei, Consolas, monospace';
    ctx.fillText('你死了', VIEW_W/2 - 50, VIEW_H/2 - 20);
    ctx.fillStyle = PAL.ui;
    ctx.font = '12px Consolas, monospace';
    ctx.fillText('击杀 ' + (game.stats.kills||0) + '   拾取 ' + (game.stats.looted||0), VIEW_W/2 - 70, VIEW_H/2 + 10);
    ctx.fillStyle = PAL.uiDim;
    ctx.fillText('Enter 返回主菜单', VIEW_W/2 - 60, VIEW_H/2 + 40);
  }

  function deadInput() {
    if (keyPressed['Enter'] || keyPressed['Escape']) {
      const coop = game && game.netMode && game.netMode !== 'single';
      if (!coop && game) saveGame();
      if (coop) leaveParty();
      state = 'MENU';
      game = null;
    }
  }

  // ---------- 鼠标点击 ----------
  function handleClick(x, y) {
    if (state === 'MENU') {
      // 菜单项区域
      const menuStartY = 230, menuGap = 34;
      for (let i = 0; i < menuItems.length; i++) {
        const rowY = menuStartY - 14 + i * menuGap;
        if (y >= rowY && y < rowY + 30 && x > VIEW_W/2 - 120 && x < VIEW_W/2 + 120) {
          menuSel = i;
          menuItems[i].action();
          return;
        }
      }
    } else if (state === 'SAVES') {
      const i = saveRowAt(x, y);
      if (i >= 0) { saveCursor = i; return; } // 仅选中，不立即载入
      const hasSel = saveCursor >= 0 && saveCursor < savesList.length;
      if (hasSel && hitBtn(SAVE_BTN_ENTER, x, y)) { loadGameById(savesList[saveCursor].id); return; }
      if (hitBtn(SAVE_BTN_NEW, x, y)) { openNameDialog(); return; }
      if (hitBtn(SAVE_BTN_BACK, x, y)) { state = 'MENU'; return; }
    } else if (state === 'PARTY') {
      // 附近派对点击
      for (let i = 0; i < (party.discoverList||[]).length; i++) {
        const ry = 116 + i * 30 - 14;
        if (y >= ry && y < ry + 26 && x > 20 && x < VIEW_W - 20) {
          const p = party.discoverList[i];
          attachPartyEvents();
          window.api.partyJoin({ addr: (p.ip) + ':' + (p.port), name: party.myName || ('玩家'+randi(100,999)) })
            .then((r) => {
              if (!r.ok) { toastMsg('加入失败：' + (r.error||''), 3000); return; }
              party.role = 'client';
              state = 'CLIENT_LOBBY';
              toastMsg('已连接，等待主机开始游戏', 2000);
            });
          return;
        }
      }
      if (hitBtn(PARTY_CREATE, x, y)) { attachPartyEvents(); openHostNameDialog(); return; }
      if (hitBtn(PARTY_JOIN, x, y)) { attachPartyEvents(); openJoinDialog(); return; }
      if (hitBtn(PARTY_BACK, x, y)) { state = 'MENU'; return; }
    } else if (state === 'HOST_LOBBY') {
      if (hitBtn(LOBBY_START, x, y)) { hostStartGame(); return; }
      if (hitBtn(LOBBY_LEAVE, x, y)) { leaveParty(); state = 'MENU'; return; }
    } else if (state === 'CLIENT_LOBBY') {
      if (hitBtn(LOBBY_LEAVE, x, y)) { leaveParty(); state = 'MENU'; return; }
    } else if (state === 'PAUSED') {
      if (hitBtn(PAUSE_RESUME, x, y)) { state = 'PLAYING'; return; }
    } else if (state === 'DEAD') {
      // 死亡：联机下先离开派对
      if (party.role) leaveParty();
      if (game) saveGame();
      state = 'MENU';
      game = null;
    }
  }

  // ====================================================================
  //  主循环
  // ====================================================================

  function loop(t) {
    const dt = Math.min(50, t - lastTime || 16);
    lastTime = t;

    if (state === 'MENU') menuInput();
    else if (state === 'SAVES') savesInput();
    else if (state === 'NAMING' || state === 'HOST_NAMING' || state === 'JOINING') { /* 输入由 HTML 对话框处理 */ }
    else if (state === 'PARTY') partyInput();
    else if (state === 'HOST_LOBBY' || state === 'CLIENT_LOBBY') lobbyInput();
    else if (state === 'PAUSED') pauseInput();
    else if (state === 'DEAD') deadInput();
    else if (state === 'PLAYING') {
      if (game && game.netMode === 'client') {
        clientTick(dt);   // 客户端：发输入，渲染靠快照
      } else {
        update(dt);
      }
    }

    render();
    keyPressed = {};   // 每帧清空单次按键，避免暂停/恢复时同一按键跨帧重复触发
    requestAnimationFrame(loop);
  }
  // 启动时订阅派对事件
  attachPartyEvents();
  // 订阅主进程的 F12 开发者模式切换
  if (window.api && window.api.onDevToggle) {
    window.api.onDevToggle(() => {
      if (state === 'PLAYING' && game && game.netMode === 'single') toggleDevMode();
    });
  }
  requestAnimationFrame(loop);

})();
