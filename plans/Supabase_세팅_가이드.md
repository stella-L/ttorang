# Supabase 세팅 가이드 (시은이 할 일)

예상 소요: **15~20분**. 끝나면 URL 2개랑 anon key 1개만 저한테 주시면 돼요.

## 1. 계정 만들기

1. https://supabase.com 접속 → 우상단 **Start your project** 클릭
2. GitHub 계정으로 로그인 (가장 간단) 또는 이메일 가입

## 2. 프로젝트 생성

1. 로그인 후 **New project** 클릭
2. 입력 항목:
   - **Name**: `ttorang` (또는 아무 이름)
   - **Database Password**: 아무거나 16자 이상 (안 쓸 거예요, 아무거나 OK)
   - **Region**: `Northeast Asia (Seoul)` 선택 ← 중요 (한국에서 가장 빠름)
   - **Pricing Plan**: `Free` (0.5GB DB, 1GB Storage, 2GB bandwidth/월)
3. **Create new project** 클릭 → 1~2분 대기

## 3. 테이블·보안 정책 생성 (SQL 한 번 실행)

프로젝트 생성 끝나면:

1. 왼쪽 사이드바에서 **SQL Editor** 클릭 → **New query**
2. 아래 SQL **전부 복사 → 붙여넣기 → Run** (오른쪽 아래 녹색 버튼):

```sql
-- 트랙 메타 테이블
create table tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  file_name text,
  mime text,
  duration numeric default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  lyrics jsonb default '[]'::jsonb,
  memos jsonb default '[]'::jsonb,
  ab jsonb default '{"a":null,"b":null,"on":false}'::jsonb,
  repeat_all boolean default false,
  standalone_analysis jsonb,
  audio_path text
);

-- RLS 활성화 + 익명 전체 허용 (혼자 쓸 거라 OK, PIN은 앱 레벨에서 거는 중)
alter table tracks enable row level security;
create policy "allow all for anon" on tracks for all using (true) with check (true);

-- updated_at 자동 갱신 트리거
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger tracks_updated_at
  before update on tracks
  for each row execute function set_updated_at();
```

"Success. No rows returned" 뜨면 됐어요.

## 4. 오디오 파일 저장소 만들기

1. 왼쪽 사이드바에서 **Storage** 클릭
2. **New bucket** 클릭
3. 입력:
   - **Name**: `audio-files` (정확히 이렇게)
   - **Public bucket**: ✅ 체크 (public이어야 앱에서 재생 가능)
4. **Create bucket** 클릭

생성 후 버킷 설정에서:
1. 생성된 `audio-files` 버킷 클릭 → 오른쪽 상단 **...** → **Edit bucket**
2. **File size limit**: `100 MB` 로 수정 (기본 50MB라 레슨 녹음 안 들어감)
3. **Save**

### Storage 정책도 열어주기

왼쪽 사이드바 **Storage** → **Policies** 탭:

1. **audio-files** 옆 **New policy** → **For full customization**
2. 아래 4개 각각 하나씩 추가 (이름 아무거나, Policy definition에 `true` 만 입력):
   - **SELECT (download)**: `true`
   - **INSERT (upload)**: `true`
   - **UPDATE**: `true`
   - **DELETE**: `true`

또는 SQL Editor에서 한 번에:

```sql
create policy "anon upload" on storage.objects for insert to anon with check (bucket_id = 'audio-files');
create policy "anon read"   on storage.objects for select to anon using (bucket_id = 'audio-files');
create policy "anon update" on storage.objects for update to anon using (bucket_id = 'audio-files');
create policy "anon delete" on storage.objects for delete to anon using (bucket_id = 'audio-files');
```

## 5. URL과 anon key 복사

1. 왼쪽 사이드바 **Project Settings** (톱니바퀴) → **API**
2. 아래 두 개를 복사해서 저한테 주세요:
   - **Project URL** (예: `https://xxxxx.supabase.co`)
   - **anon public** key (아주 긴 문자열, `eyJ...`로 시작)

> `service_role` key는 절대 공유하지 마세요. 저도 안 받을 거예요. `anon` 키만 필요해요.

## 6. 저한테 전달

다음 형식으로 알려주세요:

```
URL: https://xxxxx.supabase.co
anon key: eyJhbGciOiJIUzI1NiIsIn.....

PIN은 뭐로 할까: (4~8자리 숫자, 예: 2026)
```

PIN은 접속할 때 1번 입력하면 돼요. 틀리면 접근 차단.

---

## 끝. 이게 전부예요

이거 다 되면 저는:
1. 앱 코드에 Supabase URL/key 꽂음
2. PIN 입력 모달 추가
3. 기존 IndexedDB → Supabase 자동 업로드 버튼 추가
4. 저장소 레이어를 Supabase 중심으로 교체 (오프라인 캐시는 유지)

작업 끝나면 어느 브라우저·기기든 `http://localhost:8765/` (또는 Vercel 배포 URL) 접속 → PIN 입력 → 모든 트랙·사설·분석 다 보이게 돼요.
