/* ============================================================
   전역 챗봇 플로팅 위젯 — index/dashboard/pattern/simulator 공용
   ============================================================ */

(function () {
  // 로컬 개발 중엔 로컬 백엔드로, 배포된 곳에서는 Render에 올라간 실제 백엔드로.
  const API_BASE_URL =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://127.0.0.1:8010'
      : 'https://kimchi-premium.onrender.com';

  const SESSION_KEY = 'kimplog_chat_session_id';

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'sess_' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  // ── 마크업 삽입 ──────────────────────────────────────────
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'chat-fab';
  fab.setAttribute('aria-label', '김프로그 챗봇 열기');
  fab.innerHTML = '<img src="../../assets/face-smile.svg" alt="">';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.innerHTML =
    '<div class="chat-panel-head">' +
      '<button type="button" class="chat-panel-close" aria-label="닫기">✕</button>' +
      '<div class="chat-panel-mascot-wrap"><img class="chat-panel-mascot" src="../../assets/body.svg" alt=""></div>' +
      '<div class="chat-panel-greeting">개굴! 도움이 필요하신가요?</div>' +
      '<div class="chat-panel-sub">김치프리미엄, 편하게 물어보세요</div>' +
    '</div>' +
    '<div class="chat-messages" id="chatMessages"></div>' +
    '<form class="chat-input-row" id="chatForm">' +
      '<input class="chat-input" id="chatInput" type="text" placeholder="궁금한 걸 물어보세요" autocomplete="off" maxlength="500">' +
      '<button class="chat-send" type="submit" aria-label="전송">➤</button>' +
    '</form>';
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('#chatMessages');
  const formEl = panel.querySelector('#chatForm');
  const inputEl = panel.querySelector('#chatInput');
  const sendBtn = panel.querySelector('.chat-send');
  const closeBtn = panel.querySelector('.chat-panel-close');

  function addMessage(text, cls) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + cls;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function openPanel() {
    panel.classList.add('is-open');
    fab.classList.add('is-open');
    if (!messagesEl.dataset.greeted) {
      addMessage('안녕하세요! 김치프리미엄이 왜 이런지, 지금 수치가 무슨 의미인지 궁금하면 뭐든 물어보세요.', 'bot');
      messagesEl.dataset.greeted = '1';
    }
    setTimeout(function () { inputEl.focus(); }, 120);
  }

  function closePanel() {
    panel.classList.remove('is-open');
    fab.classList.remove('is-open');
  }

  fab.addEventListener('click', function () {
    panel.classList.contains('is-open') ? closePanel() : openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  formEl.addEventListener('submit', async function (e) {
    e.preventDefault();
    const message = inputEl.value.trim();
    if (!message) return;

    addMessage(message, 'user');
    inputEl.value = '';

    inputEl.disabled = true;
    sendBtn.disabled = true;
    const pending = addMessage('생각하는 중...', 'pending');

    try {
      const res = await fetch(API_BASE_URL + '/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': getSessionId(),
        },
        body: JSON.stringify({ message: message }),
      });
      const data = await res.json().catch(function () { return {}; });
      pending.remove();

      if (!res.ok) {
        addMessage(data.detail || '죄송해요, 잠시 문제가 생겼어요. 다시 시도해 주세요.', 'error');
      } else {
        addMessage(data.reply, 'bot');
      }
    } catch (err) {
      pending.remove();
      addMessage('서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'error');
    } finally {
      inputEl.disabled = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  });
})();
