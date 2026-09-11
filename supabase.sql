-- ============================================================
-- 심사 웹앱 — Supabase 스키마 (다중 프로젝트)
-- Supabase 대시보드 → SQL Editor → 전체 붙여넣기 → Run
-- (judge-app 프로젝트에는 2026-09-09 이미 적용됨)
-- ============================================================

-- 심사 프로젝트 (설정 전체를 jsonb로 저장)
create table if not exists projects (
  id   text primary key,
  data jsonb not null
);

-- 팀 명단 (unit=개인/단체, name=대표자 성명, pname=프로젝트명)
create table if not exists teams (
  project_id text not null,
  no         int  not null,
  unit       text default '',
  name       text default '',
  pname      text default '',
  primary key (project_id, no)
);
-- 기존 DB에 pname 열 추가용:
alter table teams add column if not exists pname text default '';

-- 위원별 점수
create table if not exists scores (
  project_id text not null,
  judge_id   int  not null,
  team_no    int  not null,
  vals       jsonb default '[]',
  comment    text default '',
  updated_at timestamptz default now(),
  primary key (project_id, judge_id, team_no)
);

-- 서명 (투명 PNG + 서명 일시/기기)
create table if not exists signatures (
  project_id text not null,
  judge_id   int  not null,
  png        text not null,
  signed_at  timestamptz default now(),
  ua         text default '',
  primary key (project_id, judge_id)
);

-- 익명 키로 읽기/쓰기 허용 (행사용 간이 설정)
alter table projects   enable row level security;
alter table teams      enable row level security;
alter table scores     enable row level security;
alter table signatures enable row level security;

create policy anon_all_projects   on projects   for all using (true) with check (true);
create policy anon_all_teams      on teams      for all using (true) with check (true);
create policy anon_all_scores     on scores     for all using (true) with check (true);
create policy anon_all_signatures on signatures for all using (true) with check (true);

-- 관리자 화면 실시간 반영 (Supabase Realtime)
alter publication supabase_realtime add table scores;
alter publication supabase_realtime add table signatures;
alter publication supabase_realtime add table teams;
