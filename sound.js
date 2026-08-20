/* ============================================================
   공용 사운드 — 효과음을 그 자리에서 만들어 냅니다 (음원 파일 없음)
   ============================================================
   사용법: nav.js 바로 다음 줄에

     <script src="sound.js"></script>

   · 토글 버튼은 이 파일이 상단 네비에 알아서 끼워 넣습니다.
     그래서 이 스크립트를 부른 페이지에만 버튼이 생깁니다.

   · 기본은 꺼짐입니다. 브라우저는 사용자가 화면을 누르기 전까지
     소리를 막는데(스크롤은 '누름'으로 쳐 주지 않습니다), 토글을
     누르는 행위 자체가 그 '누름'이 되므로 차단을 정면으로 피합니다.
     자동으로 켜려는 시도는 하지 않습니다.

   · 소리를 늘리려면 아래 SFX 에 함수 하나만 더하면 됩니다.
     쓸 땐 어디서든  Sound.play('이름')  — 꺼져 있으면 조용히 지나갑니다.

   · 지금은 전부 합성음입니다. 나중에 실제 음원으로 바꿀 땐
     SFX 안쪽만 갈아끼우면 되고, 부르는 쪽은 그대로 둡니다.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'kimplog:sound';
  var MIN_GAP = 45;        // 같은 소리를 이 간격(ms) 안에 겹쳐 내지 않는다 (기본값)
  var WOBBLE = 0.06;       // 재생할 때마다 음 높이를 ±6% 흔든다.
                           // 말풍선이 한 번 읽는 동안 30번 넘게 울리는데,
                           // 매번 똑같으면 귀가 다음 소리를 예측해서 금방 질린다.

  var ctx = null, master = null, noise = null, btn = null;
  var enabled = false;
  var chosen = false;      // 사용자가 켜든 끄든 한 번이라도 정한 적이 있는가
  var lastAt = {};         // 소리 이름별 마지막 '요청' 시각
  var playedAt = {};       // 소리 이름별 마지막 '실제로 울린' 시각

  // ══════════════════════════════════════════════════════════
  // 소리를 만드는 도구
  // ══════════════════════════════════════════════════════════

  // 오디오 장치는 처음 필요할 때 만든다. 미리 만들어 두면 브라우저가 막는다.
  function ready() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // 잡음 한 덩이는 만들어 두고 계속 재사용한다 (바람소리·후레쉬의 재료)
  function noiseBuf() {
    if (!noise) {
      var n = Math.floor(ctx.sampleRate * 0.4);
      noise = ctx.createBuffer(1, n, ctx.sampleRate);
      var d = noise.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  // 소리 하나의 부피 곡선 — 짧게 솟았다가 사그라든다.
  // 0 에서 시작하면 지수 곡선을 못 쓰므로 아주 작은 값에서 출발한다.
  function envelope(t, attack, decay, peak) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(master);
    return g;
  }

  // 음 하나. f1 을 주면 그 높이까지 미끄러진다.
  function beep(t, type, f0, f1, attack, decay, peak) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    o.connect(envelope(t, attack, decay, peak));
    o.start(t);
    o.stop(t + attack + decay + 0.02);
  }

  // 스치는 소리. 잡음을 필터로 훑어서 만든다.
  function swish(t, filter, f0, f1, q, attack, decay, peak) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf();
    var bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    bq.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
    s.connect(bq);
    bq.connect(envelope(t, attack, decay, peak));
    s.start(t);
    s.stop(t + attack + decay + 0.02);
  }

  // ══════════════════════════════════════════════════════════
  // 소리 목록
  // ══════════════════════════════════════════════════════════
  var SFX = {
    // 말풍선이 바뀔 때. 한 번 보는 동안 열 번 넘게 울리므로 아주 작고 짧게.
    talk: function (t) {
      beep(t, 'triangle', 900, 560, 0.004, 0.075, 0.058);
    },

    // 보따리가 커질 때 — 동전답게 두 음을 이어 올린다
    coin: function (t) {
      beep(t, 'square', 780, 780, 0.003, 0.085, 0.120);
      beep(t + 0.06, 'square', 1170, 1170, 0.003, 0.13, 0.110);
    },


    // 마지막 후레쉬 — 밝게 터지고 아래로 떨어진다 (siren.wav 의 대비책)
    siren: function (t) {
      swish(t, 'highpass', 1800, 5200, 0.7, 0.005, 0.18, 0.112);
      beep(t, 'sine', 1500, 300, 0.005, 0.30, 0.043);
    }
  };

  // ══════════════════════════════════════════════════════════
  // 음원 파일 — 켰을 때만 받아온다 (기본이 꺼짐이라 평소엔 안 받는다)
  // ══════════════════════════════════════════════════════════
  //   이름: [파일, 음량]. SFX 에 같은 이름이 있으면 파일이 우선이고,
  //   못 받아왔을 땐 합성음으로 알아서 되돌아간다.
  //   이름: [파일, 게인, 최소간격(ms)]
  //   게인은 '파일이 가진 최대 진폭'을 아래 목표치로 끌어내리는 값이다.
  //
  //     배경 0.07  발소리          — 거의 안 들릴 만큼
  //     대화 0.18  말풍선          — 32번 울린다
  //     행동 0.22  김프랫 달리기
  //     사건 0.45~0.50  돈이 오가는 순간
  //     절정 0.55~0.62  포돌이 · 사이렌
  //
  //   자주 울리는 것일수록 조용해야 층이 무너지지 않는다.
  var FILES = {
    'say-frog': ['assets/sfx/say-frog.wav', 2.20, 90],   // 김프로그 말풍선 (원본이 작게 녹음돼 있어 키운다)
    'say-rat':  ['assets/sfx/say-rat.wav',  2.20, 90],   // 김프랫 말풍선 (say-frog 와 같은 파일 세기라 게인도 같이)
    step:       ['assets/sfx/step.wav',     1.90, 120],  // 걷는 발소리 (배경음악에 묻혀서 올림)
    dash:       ['assets/sfx/dash.wav',     0.95, 60],   // 김프랫 달리기 (연타)
    stamp:      ['assets/sfx/stamp.wav',    1.16, 200],  // 도장이 쿵 찍힐 때
    pay:        ['assets/sfx/pay.wav',      0.68, 200],  // 보따리가 커질 때
    coin:       ['assets/sfx/coin.wav',     0.66, 200],  // Sell!
    splat:      ['assets/sfx/splat.wav',    0.60, 300],  // 접시를 엎을 때
    dread:      ['assets/sfx/dread.wav',    0.70, 400],  // 포돌이 등장
    siren:      ['assets/sfx/siren.wav',    0.75, 400]   // 마지막 후레쉬
  };
  var buffers = {}, fetching = {}, waiting = {};

  // 다 받아 온 순간 기다리던 재생을 흘려 보낸다
  function flush(name) {
    var q = waiting[name]; waiting[name] = null;
    if (q) for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
  }

  function load(name, done) {
    if (!FILES[name]) return;
    if (buffers[name] !== undefined) { if (done) done(); return; }
    if (done) (waiting[name] = waiting[name] || []).push(done);
    if (fetching[name]) return;
    fetching[name] = true;
    fetch(FILES[name][0])
      .then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then(function (b) {
        return new Promise(function (ok, no) { ctx.decodeAudioData(b, ok, no); });
      })
      .then(function (buf) { buffers[name] = buf; flush(name); })
      .catch(function () { buffers[name] = null; flush(name); });   // 실패하면 합성음으로 간다
  }
  function loadAll() { if (ready()) Object.keys(FILES).forEach(load); }

  function playFile(name, t, rate) {
    playedAt[name] = Date.now();
    var s = ctx.createBufferSource();
    s.buffer = buffers[name];
    // 배속은 음 높이도 같이 바꾼다. 부를 때 준 값에 매번 조금씩 흔들림을 더한다.
    s.playbackRate.value = (rate || 1) * (1 - WOBBLE + Math.random() * WOBBLE * 2);
    var g = ctx.createGain();
    g.gain.value = FILES[name][1];
    s.connect(g); g.connect(master);
    s.start(t);
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // 바깥에서 쓰는 것
  // ══════════════════════════════════════════════════════════
  //   rate 를 주면 그 배속으로 낸다. 김프랫이 빨라질수록 발소리도 빨라지고,
  //   도장은 0.7배로 늘어져 '쿵' 이 된다.
  function play(name, rate) {
    if (!enabled || !ready()) return;
    if (!SFX[name] && !FILES[name]) return;
    var gap = (FILES[name] && FILES[name][2]) || MIN_GAP;
    var now = Date.now();
    if (now - (lastAt[name] || 0) < gap) return;   // 스크롤을 휙 내려도 소리가 뭉치지 않게
    lastAt[name] = now;
    // 소리 하나가 실패했다고 화면이 멈추면 안 된다.
    // 대신 마지막 오류는 남겨 둔다 — 콘솔에서 Sound.lastError 로 확인.
    try {
      var t = ctx.currentTime + 0.005;
      if (buffers[name]) { playFile(name, t, rate); return; }
      if (FILES[name]) {
        // 아직 안 받았으면 받아 두고, 준비되는 대로 울린다.
        // 소리를 켜자마자 누르면 파일이 아직 안 와 있어서 그냥 지나가 버린다.
        // 다만 너무 늦게 도착한 건 이미 지나간 장면의 소리라 버린다.
        var asked = Date.now();
        load(name, function () {
          if (!enabled || !buffers[name]) return;
          if (Date.now() - asked > 1500) return;
          // 받아오는 동안 쌓인 요청이 한꺼번에 터지지 않게, 울리기 직전에 한 번 더 잰다.
          // 위에서 잰 간격은 '요청' 기준이라 대기열이 동시에 풀리는 걸 막지 못한다.
          if (Date.now() - (playedAt[name] || 0) < gap) return;
          playFile(name, ctx.currentTime + 0.005, rate);
        });
        return;
      }
      if (SFX[name]) SFX[name](t);                      // 파일이 아예 없는 것만 합성음으로
    } catch (e) { api.lastError = e; }
  }

  function setOn(v, fromUser) {
    enabled = !!v;
    chosen = true;         // 한 번 정하면 더는 권하지 않는다
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) {}
    if (enabled) loadAll();
    paint();
    // 음악도 이 토글 하나에 묶인다. 끄면 멈추고, 켜면 원래 틀려던 곡부터 다시.
    if (enabled) { if (wantTrack) { crossfade(wantTrack, wantRestart); wantRestart = false; } }
    else stopMusic();
    if (enabled && fromUser) play('say-frog');   // 켠 순간 소리로 확인시켜 준다
  }

  // ══════════════════════════════════════════════════════════
  // 토글 버튼
  // ══════════════════════════════════════════════════════════
  function paint() {
    if (!btn) return;
    var label = enabled ? '소리 끄기' : '소리 켜기';
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.classList.toggle('is-on', enabled);
    // 아직 한 번도 정한 적이 없으면 버튼이 스스로 눈짓을 한다
    btn.classList.toggle('is-ask', !chosen);
  }

  function mount() {
    if (btn) return true;
    // topnav-inner 안에 넣지 않는다 — 탭 버튼들의 x좌표가 이 버튼 유무에 따라
    // 페이지마다 달라지는 걸 막기 위해, 화면에 독립적으로 떠 있는 버튼으로 둔다.
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sound-fab';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path class="spk" d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/>' +
        '<path class="wave" d="M15.3 9.4a3.7 3.7 0 0 1 0 5.2"/>' +
        '<path class="wave" d="M17.9 6.9a7.3 7.3 0 0 1 0 10.2"/>' +
        '<path class="slash" d="M15.6 9.6l5 4.8m0-4.8l-5 4.8"/>' +
      '</svg>';
    btn.addEventListener('click', function () { setOn(!enabled, true); });
    document.body.appendChild(btn);
    paint();
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // 시작
  // ══════════════════════════════════════════════════════════
  try {
    var saved = localStorage.getItem(KEY);
    chosen = (saved === '0' || saved === '1');
    enabled = saved === '1';
  } catch (e) {}

  // 저장된 설정이 '켜짐'이어도 브라우저는 첫 조작 전까지 소리를 막는다.
  // 그래서 아무거나 처음 누를 때 딱 한 번 오디오를 깨워 둔다.
  //   효과음뿐 아니라 배경음악도 여기서 다시 시도한다. 페이지가 열리자마자 부른
  //   music() 은 조작 전이라 거절당하는데, 그대로 두면 곡이 바뀌는 순간까지
  //   음악이 아예 없다.
  if (enabled) {
    var offWake = function () {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
    };
    var wakePending = false;            // 앞선 시도의 결과를 아직 기다리는 중인가
    var wake = function () {
      ready();
      // 기다리는 중이면 아무것도 하지 않는다. curTrack 은 play() 를 부르는 순간
      // 이미 차므로, 여기서 그냥 넘어가면 리스너를 떼 버리고 나중에 그 약속이
      // 거절됐을 때 다시 걸 기회가 사라진다.
      if (wakePending) return;
      if (wantTrack && !curTrack) {
        var started = crossfade(wantTrack, wantRestart);
        var mySeq = playSeq;              // 방금 그 요청의 세대
        wantRestart = false;
        // 첫 조작에서도 거절될 수 있다(자동재생 말고도 로드 실패·미지원 형식).
        // 그때 리스너를 떼면 다음 조작에서 다시 걸 기회가 사라진다.
        if (started && started.then) {
          wakePending = true;
          started.then(
            function () { wakePending = false; if (mySeq === playSeq) offWake(); },
            function () { wakePending = false; /* 실패 — 다음 조작을 기다린다 */ }
          );
          return;
        }
      }
      offWake();
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
  }

  // 다른 탭으로 가면 소리를 멈춘다
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (ctx) ctx.suspend();
      Object.keys(els).forEach(function (k) { els[k].pause(); });
    } else if (enabled) {
      if (ctx) ctx.resume();
      if (curTrack && els[curTrack]) {
        var p = els[curTrack].play(); if (p && p.catch) p.catch(function () {});
      }
    }
  });

  // ══════════════════════════════════════════════════════════
  // 배경음악 — 효과음과 달리 길어서 <audio> 로 흘려 보낸다.
  //   · 토글 하나로 효과음과 함께 켜고 꺼진다.
  //   · 곡을 바꿀 땐 겹쳐 페이드한다. 이전 곡은 멈춘 자리를 기억했다가
  //     돌아올 때 이어서 튼다 — 처음부터 다시 틀면 리셋된 느낌이 난다.
  // ══════════════════════════════════════════════════════════
  //   [파일, 음량, 들어올 때 페이드(ms)]. 페이드가 0이면 곧바로 제 음량으로 시작한다.
  var TRACKS = {
    main: ['assets/bgm/main.m4a', 0.12, 900],   // 시작화면부터 끝까지 깔리는 곡 (효과음 자리를 내주려고 낮춤)
    rat:  ['assets/bgm/rat.m4a',  0.13, 0]      // 김프랫 구간 — 바로 시작
  };
  var FADE = 900;                          // 기본으로 겹치는 시간(ms)
  var QUICK_OUT = 250;                     // 새 곡이 바로 시작할 땐 옛 곡을 빨리 뺀다
  var els = {}, curTrack = null, fadeTimer = null;
  // 재생 요청 세대 번호. play() 의 약속은 늦게 도착할 수 있어서, 그 사이 새 요청이
  // 들어왔으면 지난 요청의 뒤처리가 최신 상태를 덮어쓰면 안 된다.
  // (후레쉬에서 music(null) 하고 1.5초 뒤 music('main') 하는 구간이 그렇다)
  var playSeq = 0;

  function trackEl(name) {
    if (els[name]) return els[name];
    var a = new Audio();
    a.src = TRACKS[name][0];
    a.loop = true;
    a.preload = 'none';
    a.volume = 0;
    els[name] = a;
    return a;
  }

  // from 을 줄이면서 to 를 키운다. to 가 없으면 그냥 줄여서 멈춘다.
  //   재생이 실제로 붙었는지는 비동기로 판가름 나므로, play() 의 약속을 돌려준다.
  function crossfade(to, restart) {
    var seq = ++playSeq;
    clearInterval(fadeTimer);
    var from = curTrack && curTrack !== to ? els[curTrack] : null;
    var next = to ? trackEl(to) : null;
    var goal = to ? TRACKS[to][1] : 0;
    var started = null;
    if (next) {
      if (restart) { try { next.currentTime = 0; } catch (e) {} }
      next.volume = next.volume || 0;
      var p = next.play();
      started = p;
      if (p && p.catch) p.catch(function (e) {
        if (seq !== playSeq) return;      // 이미 지난 요청 — 최신 상태를 건드리지 않는다
        api.lastError = e;
        // 조작 전에는 브라우저가 재생을 막는다(NotAllowedError). 여기서 포기하면
        // 다음에 눌러도 영영 안 붙으므로, '아직 못 틀었다' 로 남겨 둔다.
        // wake() 가 첫 조작 때 이 자리를 보고 다시 시도한다.
        if (curTrack === to) curTrack = null;
      });
    }
    curTrack = to;
    // 새 곡이 곧바로 들어오는 경우엔 제 음량을 바로 얹고, 옛 곡만 빠르게 뺀다.
    var inMs = to && TRACKS[to][2] !== undefined ? TRACKS[to][2] : FADE;
    var outMs = inMs === 0 ? QUICK_OUT : FADE;
    if (next && inMs === 0) next.volume = goal;
    var t0 = Date.now(), v0 = from ? from.volume : 0, w0 = next ? next.volume : 0;
    fadeTimer = setInterval(function () {
      var now = Date.now() - t0;
      if (from) from.volume = Math.max(0, v0 * (1 - Math.min(now / outMs, 1)));
      if (next && inMs > 0) {
        var k = Math.min(now / inMs, 1);
        next.volume = Math.min(1, w0 + (goal - w0) * k);
      }
      if (now >= Math.max(inMs, outMs)) {
        clearInterval(fadeTimer); fadeTimer = null;
        if (from) from.pause();                 // currentTime 은 그대로 — 돌아올 때 이어진다
      }
    }, 40);
    return started;
  }

  // 바깥에서 부르는 것. 이름을 주면 그 곡으로, null 이면 음악을 끈다.
  //   restart 를 주면 이어서가 아니라 처음부터 다시 튼다
  function music(name, restart) {
    if (!enabled) { wantTrack = name; wantRestart = !!restart; return; }
    if (name === curTrack && !restart) return;
    wantTrack = name; wantRestart = false;
    crossfade(name, restart);
  }
  var wantTrack = null, wantRestart = false;

  function stopMusic() {
    clearInterval(fadeTimer); fadeTimer = null;
    Object.keys(els).forEach(function (k) { els[k].pause(); els[k].volume = 0; });
    curTrack = null;
  }

  var api = {
    play: play,
    music: music,
    load: loadAll,
    isOn: function () { return enabled; },
    chosen: function () { return chosen; },   // 아직 안 정했으면 켜라고 권할 수 있다
    set: setOn,
    names: function () { return Object.keys(SFX); },
    lastError: null
  };
  window.Sound = api;

  if (!mount()) document.addEventListener('DOMContentLoaded', mount);
})();
