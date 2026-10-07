/* 또랑또랑 설정 템플릿
   실제 config.js는 .gitignore에 있어서 레포엔 안 올라감.
   로컬 개발 시: 이 파일을 config.js로 복사하고 아래 값들 채우기.
   배포 시: GitHub Actions가 Secrets에서 config.js를 자동 생성 (.github/workflows/deploy.yml 참조). */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_KEY: 'sb_publishable_YOUR_KEY_HERE',
  AUDIO_BUCKET: 'audio-files',
  PIN: '0000',
};
