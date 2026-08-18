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
  var MIN_GAP = 45;        // 같은 소리를 이 간격(ms) 안에 겹쳐 내지 않는다

  var ctx = null, master = null, noise = null, btn = null;
  var enabled = false;
  var chosen = false;      // 사용자가 켜든 끄든 한 번이라도 정한 적이 있는가
  var lastAt = {};         // 소리 이름별 마지막 재생 시각

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

    // 김프랫이 달려갈 때 — 낮은 데서 높은 데로 스치는 바람
    dash: function (t) {
      swish(t, 'bandpass', 420, 2400, 0.9, 0.04, 0.2, 0.38);
    },

    // 마지막 후레쉬 — 밝게 터지고 아래로 떨어진다
    flash: function (t) {
      swish(t, 'highpass', 1800, 5200, 0.7, 0.005, 0.18, 0.112);
      beep(t, 'sine', 1500, 300, 0.005, 0.30, 0.043);
    }
  };

  // ══════════════════════════════════════════════════════════
  // 바깥에서 쓰는 것
  // ══════════════════════════════════════════════════════════
  function play(name) {
    if (!enabled || !SFX[name] || !ready()) return;
    var now = Date.now();
    if (now - (lastAt[name] || 0) < MIN_GAP) return;   // 스크롤을 휙 내려도 소리가 뭉치지 않게
    lastAt[name] = now;
    // 소리 하나가 실패했다고 화면이 멈추면 안 된다.
    // 대신 마지막 오류는 남겨 둔다 — 콘솔에서 Sound.lastError 로 확인.
    try { SFX[name](ctx.currentTime + 0.005); } catch (e) { api.lastError = e; }
  }

  function setOn(v, fromUser) {
    enabled = !!v;
    chosen = true;         // 한 번 정하면 더는 권하지 않는다
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) {}
    if (enabled) ready();
    paint();
    if (enabled && fromUser) play('talk');   // 켠 순간 소리로 확인시켜 준다
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
    var bar = document.querySelector('.topnav-inner');
    if (!bar) return false;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topnav-sound';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path class="spk" d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/>' +
        '<path class="wave" d="M15.3 9.4a3.7 3.7 0 0 1 0 5.2"/>' +
        '<path class="wave" d="M17.9 6.9a7.3 7.3 0 0 1 0 10.2"/>' +
        '<path class="slash" d="M15.6 9.6l5 4.8m0-4.8l-5 4.8"/>' +
      '</svg>';
    btn.addEventListener('click', function () { setOn(!enabled, true); });
    bar.appendChild(btn);
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
    isOn: function () { return enabled; },
    chosen: function () { return chosen; },   // 아직 안 정했으면 켜라고 권할 수 있다
    set: setOn,
    names: function () { return Object.keys(SFX); },
    lastError: null
  };
  window.Sound = api;

  if (!mount()) document.addEventListener('DOMContentLoaded', mount);
})();
