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
    'say-frog': ['assets/sfx/say-frog.wav', 1.00, 90],   // 김프로그 말풍선
    'say-rat':  ['assets/sfx/say-rat.wav',  1.00, 90],   // 김프랫 말풍선
    step:       ['assets/sfx/step.wav',     1.27, 120],  // 걷는 발소리
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
  if (enabled) {
    var wake = function () {
      ready();
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
  }

  // 다른 탭으로 가면 소리를 멈춘다
  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (enabled) ctx.resume();
  });

  var api = {
    play: play,
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
