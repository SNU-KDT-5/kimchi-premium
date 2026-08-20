/* ============================================================
   공용 상단 네비게이션 — index/dashboard/pattern/simulator 공용
   ============================================================
   사용법: <body> 시작 직후에 아래 두 줄 넣기

     <div id="topnav-root"></div>
     <script src="../../shared/nav.js"></script>

   탭 목록/문구/로고/마스코트를 바꿀 땐 이 파일만 수정하면 모든 페이지에 반영됩니다.
   스타일은 shared.css의 .topnav 계열 클래스를 그대로 사용.
   경로는 모든 페이지가 pages/<topic>/<file>.html 형태로 루트에서 두 단계 아래 있다는
   가정 하에 상대경로(../../)로 적는다.
   ============================================================ */
(function () {
  const TABS = [
    { href: '../../pages/index/index.html', label: '홈' },
    { href: '../../pages/pattern/pattern.html', label: '패턴분석' },
    { href: '../../pages/dashboard/dashboard.html', label: '대시보드' },
    { href: '../../pages/simulator/simulator.html', label: '시뮬레이터' },
  ];

  const root = document.getElementById('topnav-root');
  if (!root) return;

  const current = location.pathname.split('/').pop() || 'index.html';

  const tabsHtml = TABS.map(function (t) {
    const active = t.href.split('/').pop() === current;
    return '<a href="' + t.href + '" class="topnav-tab' + (active ? ' active' : '') + '">' + t.label + '</a>';
  }).join('');

  root.innerHTML =
    '<nav class="topnav">' +
      '<div class="topnav-inner">' +
        '<a href="../../pages/index/index.html" class="topnav-logo">' +
          '<img class="topnav-mascot-slot" src="../../assets/face-smile.svg" alt="" aria-hidden="true">' +
          'KIMPLOG' +
        '</a>' +
        '<div class="topnav-tabs">' + tabsHtml + '</div>' +
      '</div>' +
    '</nav>';
})();
