/* ============================================================
 * 심사 웹앱 — 기본 설정
 *
 * 행사명·심사위원·평가항목은 관리자 화면(?admin=...)에서 자유롭게
 * 수정합니다. 아래 DEFAULTS는 "처음 실행했을 때"의 기본값일 뿐입니다.
 * ============================================================ */
const CONFIG = {
  /* Supabase — 비워두면 체험 모드(이 컴퓨터에만 저장)로 동작합니다.
     실전: Supabase 프로젝트 생성 → supabase.sql 실행 → 아래 두 값 입력 */
  SUPABASE_URL: 'https://tckrahbzaiiipfmewbbl.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Gpvs-3LZ2lykLtWgS_c7OQ_TDwJMAq6',

  /* 관리자(설정·취합) 페이지 접속: index.html?admin=아래값 */
  ADMIN_TOKEN: 'admin-7k2p9x',

  /* 최초 실행 시 기본값 — 관리자 화면에서 언제든 변경 가능 */
  DEFAULTS: {
    active: true,   // 공개 여부 (관리자 화면에서 전환)
    eventTitle: '2026 강원 AI 에듀톤 예선 심사표(위원별)',
    category: '예비교원(초등)',
    dateText: '2026.8.3',
    dateLine: '2026년  8월  3일',
    teamCount: 20,
    /* phone: 전화번호 뒤 4자리 — 첫 화면 로그인에 사용 (관리자 화면에서 입력) */
    judges: [
      { id: 1, name: '황광민', role: '심사위원장', token: 'hg-4m7k2q', phone: '' },
      { id: 2, name: '신범주', role: '심사위원',   token: 'sb-9t3w6e', phone: '' },
      { id: 3, name: '윤한얼', role: '심사위원',   token: 'yh-2r8n5c', phone: '' },
      { id: 4, name: '이재경', role: '심사위원',   token: 'lj-6p1z4v', phone: '' },
      { id: 5, name: '정원조', role: '심사위원',   token: 'jw-8d5s7b', phone: '' },
      { id: 6, name: '최우혁', role: '심사위원',   token: 'cw-3f9h1m', phone: '' },
    ],
    criteria: [
      {
        name: '창의성', max: 30,
        desc: [
          '아이디어가 독창적인가?',
          '기존 사례와 차별성이 있는가?',
          '문제 해결 방식이 창의적인가?',
          '향후 확장 및 발전 가능성이 있는가?',
          '아이디어가 사회적으로 영향력/파급력이 있는가?',
        ],
      },
      {
        name: '기술성', max: 30,
        desc: [
          'AI·SW 기술을 적절히 활용하였는가?',
          '구현 난이도가 높은가?',
          '기술 구현 수준이 우수한가?',
          '핵심 기능을 직접 구현하였는가?',
        ],
      },
      {
        name: '완성도', max: 30,
        desc: [
          '기능 구현이 충실한가?',
          '사용자 관점에서 완성도가 높은가?',
          '실제 현장에서 활용 가능한 수준인가?',
        ],
      },
      {
        name: '발표능력', max: 10,
        desc: [
          '발표가 일관된 흐름으로 전개되며 논리적인가?',
          '발표자료가 보기 쉽고 시각자료 등이 효과적으로 활용되었는가?',
          '발표시간을 준수하였는가?',
        ],
      },
    ],
  },
};
