/* 또랑또랑 — 판소리 연습장
   Supabase를 source of truth로, IndexedDB를 로컬 캐시(오프라인 지원)로 하이브리드 저장 */

(() => {
  'use strict';

  /* ========== IndexedDB 래퍼 (로컬 캐시) ========== */
  const DB_NAME = 'ttorang';
  const DB_VER = 1;
  let dbPromise;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(stores, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const result = fn(t);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const localStore = {
    async saveTrack(track) {
      return tx('tracks', 'readwrite', (t) => t.objectStore('tracks').put(track));
    },
    async saveAudio(id, blob) {
      return tx('audio', 'readwrite', (t) => t.objectStore('audio').put({ id, blob }));
    },
    async allTracks() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction('tracks').objectStore('tracks').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },
    async getAudio(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction('audio').objectStore('audio').get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => reject(req.error);
      });
    },
    async deleteTrack(id) {
      return tx(['tracks', 'audio'], 'readwrite', (t) => {
        t.objectStore('tracks').delete(id);
        t.objectStore('audio').delete(id);
      });
    },
  };

  /* ========== Supabase 클라이언트 ========== */
  const CFG = window.APP_CONFIG || {};
  const sb = window.supabase && CFG.SUPABASE_URL
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY)
    : null;
  const BUCKET = CFG.AUDIO_BUCKET || 'audio-files';

  // 로컬 track 객체(camelCase, createdAt=ms) ↔ Supabase row(snake_case, created_at=ISO) 변환
  function trackToRow(t) {
    return {
      id: t.id,
      title: t.title,
      file_name: t.fileName || null,
      mime: t.mime || null,
      duration: t.duration || 0,
      created_at: new Date(t.createdAt || Date.now()).toISOString(),
      lyrics: t.lyrics || [],
      memos: t.memos || [],
      ab: t.ab || { a: null, b: null, on: false },
      repeat_all: !!t.repeatAll,
      standalone_analysis: t.standaloneAnalysis || null,
      audio_path: t.audioPath || t.id,
    };
  }
  function rowToTrack(r) {
    return {
      id: r.id,
      title: r.title,
      fileName: r.file_name,
      mime: r.mime,
      duration: Number(r.duration) || 0,
      createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      lyrics: r.lyrics || [],
      memos: r.memos || [],
      ab: r.ab || { a: null, b: null, on: false },
      repeatAll: !!r.repeat_all,
      standaloneAnalysis: r.standalone_analysis || null,
      audioPath: r.audio_path || r.id,
    };
  }

  /* ========== 업로드 전 자동 압축 (Supabase 50MB 상한 대응) ========== */
  const COMPRESS_THRESHOLD = 40 * 1024 * 1024; // 40MB 넘으면 압축

  async function maybeCompressForUpload(file) {
    if (file.size <= COMPRESS_THRESHOLD) return file;
    if (!window.lamejs) {
      console.warn('[compress] lamejs 미로드, 원본 그대로');
      return file;
    }
    try {
      toast('큰 파일이라 압축 중... (잠시만요)');
      const arrayBuf = await file.arrayBuffer();
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const probeCtx = new Ctx(1, 1, 44100);
      const srcBuf = await probeCtx.decodeAudioData(arrayBuf);

      // 모노 24kHz로 다운샘플
      const TARGET_SR = 24000;
      const length = Math.max(1, Math.ceil(srcBuf.duration * TARGET_SR));
      const dsCtx = new Ctx(1, length, TARGET_SR);
      const src = dsCtx.createBufferSource();
      src.buffer = srcBuf;
      src.connect(dsCtx.destination);
      src.start();
      const monoBuf = await dsCtx.startRendering();
      const pcm = monoBuf.getChannelData(0);

      // Float32 → Int16 PCM
      const samples = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // 길이에 맞춰 bitrate 선택 (목표: 45MB 아래)
      const targetKbps = Math.floor((45 * 1024 * 1024 * 8) / srcBuf.duration / 1000);
      const bitrate = Math.max(24, Math.min(64, targetKbps));

      // lamejs로 MP3 인코드
      const encoder = new window.lamejs.Mp3Encoder(1, TARGET_SR, bitrate);
      const CHUNK = 1152;
      const mp3Data = [];
      for (let i = 0; i < samples.length; i += CHUNK) {
        const chunk = samples.subarray(i, Math.min(i + CHUNK, samples.length));
        const mp3buf = encoder.encodeBuffer(chunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
      }
      const tail = encoder.flush();
      if (tail.length > 0) mp3Data.push(tail);

      const blob = new Blob(mp3Data, { type: 'audio/mp3' });
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
      const origMB = (file.size / 1024 / 1024).toFixed(1);
      toast(`압축 완료: ${origMB}MB → ${sizeMB}MB`);
      return new File([blob], file.name.replace(/\.[^.]+$/, '.mp3'), { type: 'audio/mp3' });
    } catch (err) {
      console.error('[compress] 실패:', err);
      toast('압축 실패, 원본 유지');
      return file;
    }
  }

  /* ========== 하이브리드 store: Supabase 우선, IndexedDB 캐시 폴백 ========== */
  const store = {
    async saveTrack(track) {
      await localStore.saveTrack(track); // 즉시 로컬 반영 (UX)
      if (!sb) return;
      try {
        const { error } = await sb.from('tracks').upsert(trackToRow(track));
        if (error) throw error;
      } catch (e) {
        console.warn('[sync] saveTrack 원격 실패, 로컬만 저장:', e.message || e);
      }
    },

    async saveAudio(id, blob) {
      await localStore.saveAudio(id, blob); // 로컬 캐시 선반영
      if (!sb) return;
      try {
        const { error } = await sb.storage.from(BUCKET).upload(id, blob, {
          upsert: true,
          contentType: blob.type || 'audio/mp4',
        });
        if (error) throw error;
      } catch (e) {
        console.warn('[sync] saveAudio 원격 실패, 로컬만 캐시:', e.message || e);
      }
    },

    async allTracks() {
      if (sb) {
        try {
          const { data, error } = await sb.from('tracks').select('*');
          if (error) throw error;
          const tracks = (data || []).map(rowToTrack);
          // 로컬 캐시도 동기화
          for (const t of tracks) await localStore.saveTrack(t);
          return tracks;
        } catch (e) {
          console.warn('[sync] allTracks 원격 실패, 로컬 캐시 사용:', e.message || e);
        }
      }
      return localStore.allTracks();
    },

    async getAudio(id) {
      // 로컬 캐시 우선 (즉시 재생, 오프라인 지원)
      const cached = await localStore.getAudio(id);
      if (cached) return cached;
      if (!sb) return null;
      // 원격에서 다운로드 → 로컬 캐시 → 반환
      try {
        const { data, error } = await sb.storage.from(BUCKET).download(id);
        if (error) throw error;
        await localStore.saveAudio(id, data);
        return data;
      } catch (e) {
        console.warn('[sync] getAudio 원격 실패:', e.message || e);
        return null;
      }
    },

    async deleteTrack(id) {
      await localStore.deleteTrack(id);
      if (!sb) return;
      try {
        await sb.from('tracks').delete().eq('id', id);
        await sb.storage.from(BUCKET).remove([id]);
      } catch (e) {
        console.warn('[sync] deleteTrack 원격 실패:', e.message || e);
      }
    },
  };

  /* ========== 유틸 ========== */
  const $ = (sel) => document.querySelector(sel);
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 1800);
  }

  /* ========== 상태 ========== */
  const audio = $('#audio');
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;

  let current = null;      // 현재 열린 track
  let objectUrl = null;    // 현재 오디오 objectURL
  let syncMode = false;    // 가사 탭싱크 모드
  let syncIndex = 0;       // 싱크로 찍을 다음 줄 index
  let adjustMode = false;  // 찍어둔 사설 시간 미세조정 모드

  /* ========== 화면 전환 ========== */
  function showLibrary() {
    $('#player-view').classList.remove('active');
    $('#library-view').classList.add('active');
    stopAudio();
    renderLibrary();
  }
  function showPlayer() {
    $('#library-view').classList.remove('active');
    $('#player-view').classList.add('active');
    window.scrollTo(0, 0);
  }

  /* ========== 목록 렌더 ========== */
  async function renderLibrary() {
    const tracks = (await store.allTracks()).sort((a, b) => b.createdAt - a.createdAt);
    const list = $('#track-list');
    list.innerHTML = '';
    $('#empty-state').hidden = tracks.length > 0;

    for (const tr of tracks) {
      const li = document.createElement('li');
      li.className = 'track-item';
      const date = new Date(tr.createdAt);
      const dateStr = `${date.getMonth() + 1}.${date.getDate()}`;
      const lyricsCnt = tr.lyrics ? tr.lyrics.filter((l) => l.time != null).length : 0;
      li.innerHTML = `
        <div class="track-thumb">🎵</div>
        <div class="track-info">
          <div class="track-name"></div>
          <div class="track-meta">${dateStr} · ${fmt(tr.duration || 0)}${
            lyricsCnt ? ` · 사설 ${lyricsCnt}줄 싱크` : ''
          }${tr.memos && tr.memos.length ? ` · 메모 ${tr.memos.length}` : ''}</div>
        </div>`;
      li.querySelector('.track-name').textContent = tr.title;
      li.addEventListener('click', () => openTrack(tr.id));
      list.appendChild(li);
    }
  }

  /* ========== 파일 불러오기 ========== */
  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const originalFile = e.target.files[0];
    e.target.value = '';
    if (!originalFile) return;

    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const title = originalFile.name.replace(/\.[^.]+$/, '');
    const duration = await probeDuration(originalFile);

    // 브라우저 자동 압축은 55MB+에서 메모리 부족으로 뻗어서 당장은 OFF.
    // 큰 파일은 ffmpeg로 미리 압축 후 업로드 권장 (plans/나중에_할일.md 참조).
    const uploadFile = originalFile;
    if (originalFile.size > 48 * 1024 * 1024) {
      toast('⚠ 50MB 넘어 클라우드 업로드 안 됨. 로컬엔 저장됨 (ffmpeg로 미리 압축 권장)');
    }

    const track = {
      id, title, fileName: uploadFile.name, mime: uploadFile.type,
      createdAt: Date.now(), duration,
      lyrics: [], memos: [], ab: { a: null, b: null },
    };
    // 로컬에 먼저 저장(즉시) → 플레이어 바로 열기 → Supabase 업로드는 백그라운드
    await localStore.saveAudio(id, uploadFile);
    await localStore.saveTrack(track);
    toast('불러왔어요 (클라우드 업로드 중...)');
    openTrack(id);
    // 백그라운드 업로드
    (async () => {
      try {
        await store.saveAudio(id, uploadFile);
        await store.saveTrack(track);
        toast('클라우드 업로드 완료');
      } catch (e) {
        console.warn('[upload] background upload failed:', e.message || e);
        toast('클라우드 업로드 실패 (로컬엔 저장됨)');
      }
    })();
  });

  function probeDuration(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      a.src = url;
    });
  }

  /* ========== 트랙 열기 ========== */
  async function openTrack(id) {
    const tracks = await store.allTracks();
    current = tracks.find((t) => t.id === id);
    if (!current) return toast('찾을 수 없어요');

    const blob = await store.getAudio(id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.playbackRate = 1;
    setActiveSpeed(1);

    $('#track-title').value = current.title;
    renderRepeatAll();
    renderAB();
    renderLyrics();
    renderMemos();
    restoreAnalysisUI();
    syncMode = false;
    adjustMode = false;
    $('#sync-banner').hidden = true;

    showPlayer();
  }

  function stopAudio() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  async function persist() {
    if (current) await store.saveTrack(current);
  }

  /* ========== 재생 컨트롤 ========== */
  const playBtn = $('#play-btn');
  const seek = $('#seek');
  let seeking = false;

  playBtn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  audio.addEventListener('play', () => (playBtn.textContent = '❚❚'));
  audio.addEventListener('pause', () => (playBtn.textContent = '▶'));

  audio.addEventListener('loadedmetadata', () => {
    seek.max = audio.duration || 0;
    $('#dur-time').textContent = fmt(audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    if (!seeking) seek.value = audio.currentTime;
    $('#cur-time').textContent = fmt(audio.currentTime);
    handleABLoop();
    highlightCurrentLine();
  });

  seek.addEventListener('input', () => {
    seeking = true;
    $('#cur-time').textContent = fmt(seek.value);
  });
  seek.addEventListener('change', () => {
    audio.currentTime = parseFloat(seek.value);
    seeking = false;
  });

  $('#back5').addEventListener('click', () => (audio.currentTime = Math.max(0, audio.currentTime - 5)));
  $('#fwd5').addEventListener('click', () => (audio.currentTime = Math.min(audio.duration, audio.currentTime + 5)));

  /* ========== 배속 ========== */
  function setActiveSpeed(rate) {
    document.querySelectorAll('#speed-buttons button').forEach((b) => {
      b.classList.toggle('active', parseFloat(b.dataset.rate) === rate);
    });
  }
  $('#speed-buttons').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const rate = parseFloat(btn.dataset.rate);
    audio.playbackRate = rate;
    audio.preservesPitch = true; // 음정 유지
    setActiveSpeed(rate);
  });

  /* ========== 전체 반복 (한 곡 무한 반복) ========== */
  const repeatAllBtn = $('#repeat-all');
  function renderRepeatAll() {
    const on = !!current.repeatAll;
    audio.loop = on;
    repeatAllBtn.classList.toggle('active', on);
    repeatAllBtn.setAttribute('aria-pressed', String(on));
  }
  repeatAllBtn.addEventListener('click', () => {
    current.repeatAll = !current.repeatAll;
    renderRepeatAll();
    persist();
    toast(current.repeatAll ? '전체 반복 켜짐' : '전체 반복 꺼짐');
  });

  /* ========== A-B 구간 반복 ========== */
  function renderAB() {
    const { a, b } = current.ab;
    $('#a-time').textContent = a != null ? fmt(a) : '–';
    $('#b-time').textContent = b != null ? fmt(b) : '–';
    $('#ab-toggle').classList.toggle('active', !!current.ab.on);
  }
  $('#set-a').addEventListener('click', () => {
    current.ab.a = audio.currentTime;
    if (current.ab.b != null && current.ab.b <= current.ab.a) current.ab.b = null;
    renderAB(); persist(); toast('A 지점 설정');
  });
  $('#set-b').addEventListener('click', () => {
    if (current.ab.a == null) return toast('A 지점을 먼저 정해주세요');
    if (audio.currentTime <= current.ab.a) return toast('B는 A보다 뒤여야 해요');
    current.ab.b = audio.currentTime;
    renderAB(); persist(); toast('B 지점 설정');
  });
  $('#ab-toggle').addEventListener('click', () => {
    if (current.ab.a == null || current.ab.b == null) return toast('A·B 지점을 먼저 정해주세요');
    current.ab.on = !current.ab.on;
    renderAB(); persist();
    if (current.ab.on) { audio.currentTime = current.ab.a; audio.play(); }
  });
  $('#ab-clear').addEventListener('click', () => {
    current.ab = { a: null, b: null, on: false };
    renderAB(); persist(); toast('구간 반복 해제');
  });
  function handleABLoop() {
    const { a, b, on } = current?.ab || {};
    if (on && a != null && b != null && audio.currentTime >= b) {
      audio.currentTime = a;
    }
  }

  function loopLine(index) {
    const lines = current.lyrics;
    const a = lines[index].time;
    if (a == null) return;
    // 다음으로 시간이 찍힌 줄, 없으면 끝
    let b = audio.duration;
    for (let i = index + 1; i < lines.length; i++) {
      if (lines[i].time != null) { b = lines[i].time; break; }
    }
    current.ab = { a, b, on: true };
    renderAB(); persist();
    audio.currentTime = a; audio.play();
    toast('이 줄만 반복');
  }

  /* ========== 가사(사설) ========== */
  $('#save-lyrics-btn').addEventListener('click', () => {
    const raw = $('#lyrics-input').value;
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    // 기존 시간 정보는 버리고 새로 (텍스트가 바뀌었을 수 있으므로)
    current.lyrics = lines.map((text) => ({ text, time: null }));
    persist();
    renderLyrics();
    toast(lines.length ? `${lines.length}줄 저장` : '사설을 지웠어요');
  });

  $('#edit-lyrics-btn').addEventListener('click', () => {
    adjustMode = false;
    $('#lyrics-input').value = current.lyrics.map((l) => l.text).join('\n');
    $('#lyrics-editor').hidden = false;
    $('#lyrics-list').hidden = true;
    $('#lyrics-tools').hidden = true;
  });

  $('#adjust-sync-btn').addEventListener('click', () => {
    if (syncMode) return;
    adjustMode = !adjustMode;
    renderLyrics();
    toast(adjustMode ? '줄별 시간을 조정하세요' : '시간 조정 완료');
  });

  function renderLyrics() {
    const list = $('#lyrics-list');
    const hasLyrics = current.lyrics && current.lyrics.length > 0;

    $('#lyrics-editor').hidden = hasLyrics;
    $('#lyrics-list').hidden = !hasLyrics;
    $('#lyrics-tools').hidden = !hasLyrics;
    $('#adjust-sync-btn').classList.toggle('active', adjustMode);
    $('#adjust-sync-btn').textContent = adjustMode ? '완료' : '시간 조정';
    if (!hasLyrics) { list.innerHTML = ''; return; }

    list.innerHTML = '';
    current.lyrics.forEach((line, i) => {
      const li = document.createElement('li');
      li.className = 'lyrics-line' + (line.time != null ? ' has-time' : '') + (adjustMode ? ' adjusting' : '');
      li.dataset.index = i;

      const stamp = document.createElement('span');
      stamp.className = 'line-stamp';
      stamp.textContent = line.time != null ? fmt(line.time) : '';

      const text = adjustMode ? createLineTextInput(line, i) : document.createElement('span');
      text.className = 'line-text';
      if (!adjustMode) text.textContent = line.text;

      li.appendChild(stamp);
      li.appendChild(text);

      if (adjustMode) {
        const controls = document.createElement('div');
        controls.className = 'line-adjust';
        controls.appendChild(adjustButton('-0.5', () => nudgeLineTime(i, -0.5)));
        controls.appendChild(adjustButton('지금', () => setLineTime(i, audio.currentTime)));
        controls.appendChild(adjustButton('+0.5', () => nudgeLineTime(i, 0.5)));
        li.appendChild(controls);
      } else if (line.time != null) {
        const loop = document.createElement('button');
        loop.className = 'line-loop';
        loop.textContent = '🔁';
        loop.title = '이 줄만 반복';
        loop.addEventListener('click', (e) => { e.stopPropagation(); loopLine(i); });
        li.appendChild(loop);
      }

      li.addEventListener('click', () => onLineClick(i));
      list.appendChild(li);
    });
  }

  function createLineTextInput(line, index) {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `lyric-text-${index}`;
    input.name = `lyric-text-${index}`;
    input.value = line.text;
    input.setAttribute('aria-label', `${index + 1}번째 사설`);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', () => updateLineText(index, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = current.lyrics[index].text;
        input.blur();
      }
    });
    return input;
  }

  function updateLineText(index, value) {
    const text = value.trim();
    if (!text) {
      renderLyrics();
      toast('사설은 비워둘 수 없어요');
      return;
    }
    current.lyrics[index].text = text;
    persist();
    toast('사설 수정 완료');
  }

  function adjustButton(label, action) {
    const btn = document.createElement('button');
    btn.className = 'adjust-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    return btn;
  }

  function setLineTime(i, time) {
    const duration = audio.duration || current.duration || Infinity;
    current.lyrics[i].time = Math.max(0, Math.min(duration, time));
    normalizeLyricTimes();
    persist();
    renderLyrics();
  }

  function nudgeLineTime(i, delta) {
    const base = current.lyrics[i].time != null ? current.lyrics[i].time : audio.currentTime;
    setLineTime(i, base + delta);
  }

  function normalizeLyricTimes() {
    current.lyrics.forEach((line, i) => {
      if (line.time == null) return;
      const prev = findPrevLyricTime(i);
      const next = findNextLyricTime(i);
      if (prev != null && line.time <= prev) line.time = prev + 0.1;
      if (next != null && line.time >= next) line.time = Math.max(0, next - 0.1);
    });
  }

  function findPrevLyricTime(index) {
    for (let i = index - 1; i >= 0; i--) {
      if (current.lyrics[i].time != null) return current.lyrics[i].time;
    }
    return null;
  }

  function findNextLyricTime(index) {
    for (let i = index + 1; i < current.lyrics.length; i++) {
      if (current.lyrics[i].time != null) return current.lyrics[i].time;
    }
    return null;
  }

  function onLineClick(i) {
    if (syncMode) {
      // 싱크 모드: 이 줄에 현재 시간 찍기
      current.lyrics[i].time = audio.currentTime;
      persist();
      renderLyrics();
      // 다음 줄을 대기 표시
      syncIndex = i + 1;
      markSyncNext();
      if (audio.paused) audio.play();
    } else {
      // 일반: 시간 찍힌 줄이면 그 지점으로 점프
      const t = current.lyrics[i].time;
      if (t != null) { audio.currentTime = t; if (audio.paused) audio.play(); }
    }
  }

  // 싱크 모드
  $('#sync-btn').addEventListener('click', () => {
    syncMode = true;
    adjustMode = false;
    syncIndex = 0;
    $('#sync-banner').hidden = false;
    $('#lyrics-tools').hidden = true;
    renderLyrics();
    markSyncNext();
    audio.currentTime = 0;
    audio.play();
    toast('재생하며 줄을 탭하세요');
  });
  $('#sync-done').addEventListener('click', () => {
    syncMode = false;
    $('#sync-banner').hidden = true;
    $('#lyrics-tools').hidden = false;
    document.querySelectorAll('.lyrics-line.sync-next').forEach((el) => el.classList.remove('sync-next'));
    persist();
    renderLyrics();
    toast('싱크 완료. 어긋난 줄은 시간 조정에서 다듬으세요');
  });
  function markSyncNext() {
    document.querySelectorAll('.lyrics-line.sync-next').forEach((el) => el.classList.remove('sync-next'));
    const el = document.querySelector(`.lyrics-line[data-index="${syncIndex}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (el) el.classList.add('sync-next');
  }

  // 현재 재생 줄 하이라이트
  let lastLine = -1;
  function highlightCurrentLine() {
    if (syncMode || !current || !current.lyrics.length) return;
    const t = audio.currentTime;
    let idx = -1;
    for (let i = 0; i < current.lyrics.length; i++) {
      const lt = current.lyrics[i].time;
      if (lt != null && lt <= t) idx = i; else if (lt != null && lt > t) break;
    }
    if (idx === lastLine) return;
    lastLine = idx;
    document.querySelectorAll('.lyrics-line.current').forEach((el) => el.classList.remove('current'));
    if (idx >= 0) {
      const el = document.querySelector(`.lyrics-line[data-index="${idx}"]`);
      if (el) {
        el.classList.add('current');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ========== 타임스탬프 메모 ========== */
  $('#add-memo-btn').addEventListener('click', () => {
    const text = prompt('이 지점(' + fmt(audio.currentTime) + ')에 남길 메모', '');
    if (text == null || !text.trim()) return;
    current.memos.push({
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
      time: audio.currentTime, text: text.trim(),
    });
    current.memos.sort((a, b) => a.time - b.time);
    persist();
    renderMemos();
  });

  function renderMemos() {
    const list = $('#memo-list');
    list.innerHTML = '';
    if (!current.memos.length) {
      list.innerHTML = '<li class="memo-empty">아직 메모가 없어요. 재생 중 원하는 지점에서 “＋”를 눌러보세요.</li>';
      return;
    }
    for (const m of current.memos) {
      const li = document.createElement('li');
      li.className = 'memo-item';

      const time = document.createElement('span');
      time.className = 'memo-time';
      time.textContent = fmt(m.time);
      time.addEventListener('click', () => { audio.currentTime = m.time; if (audio.paused) audio.play(); });

      const text = document.createElement('span');
      text.className = 'memo-text';
      text.textContent = m.text;

      const del = document.createElement('button');
      del.className = 'memo-del';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        current.memos = current.memos.filter((x) => x.id !== m.id);
        persist(); renderMemos();
      });

      li.appendChild(time); li.appendChild(text); li.appendChild(del);
      list.appendChild(li);
    }
  }

  /* ========== 제목 편집 / 삭제 / 뒤로 ========== */
  $('#track-title').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v) { current.title = v; persist(); }
    else e.target.value = current.title;
  });

  $('#delete-btn').addEventListener('click', async () => {
    if (!confirm(`“${current.title}” 을(를) 삭제할까요? 사설·메모도 함께 지워져요.`)) return;
    await store.deleteTrack(current.id);
    toast('삭제했어요');
    showLibrary();
  });

  $('#back-btn').addEventListener('click', showLibrary);

  /* ========== PIN 잠금 ========== */
  function initPinGate() {
    const gate = $('#pin-gate');
    const input = $('#pin-input');
    const submit = $('#pin-submit');
    const err = $('#pin-error');
    const expected = String(CFG.PIN || '');

    // PIN 미설정이면 그냥 통과
    if (!expected) { gate.hidden = true; return Promise.resolve(); }

    // 로컬에 이미 잠금 해제된 상태 → 통과
    if (localStorage.getItem('ttorang_unlocked') === expected) {
      gate.hidden = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const tryUnlock = () => {
        if (input.value === expected) {
          localStorage.setItem('ttorang_unlocked', expected);
          gate.hidden = true;
          resolve();
        } else {
          err.hidden = false;
          input.value = '';
          input.focus();
        }
      };
      submit.addEventListener('click', tryUnlock);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') tryUnlock();
        if (!err.hidden) err.hidden = true;
      });
      // 모달이 보이는 동안 input focus
      setTimeout(() => input.focus(), 50);
    });
  }

  /* ========== 마이그레이션: 로컬 IDB → Supabase ========== */
  async function checkMigrationNeeded() {
    if (!sb) return;
    const btn = $('#migrate-btn');
    const status = $('#sync-status');
    try {
      const localTracks = await localStore.allTracks();
      if (!localTracks.length) return;
      const { data, error } = await sb.from('tracks').select('id');
      if (error) throw error;
      const remoteIds = new Set((data || []).map((r) => r.id));
      const unsynced = localTracks.filter((t) => !remoteIds.has(t.id));
      if (!unsynced.length) return;
      btn.hidden = false;
      btn.textContent = `⬆︎ 기존 로컬 데이터 ${unsynced.length}개 Supabase로 올리기`;
      btn.onclick = () => migrateToSupabase(unsynced);
    } catch (e) {
      console.warn('[migrate] 체크 실패:', e.message || e);
    }
  }

  async function migrateToSupabase(tracks) {
    const btn = $('#migrate-btn');
    const status = $('#sync-status');
    btn.disabled = true;
    status.hidden = false;
    let done = 0, failed = 0;
    const renderProgress = (currentTitle) => {
      const pct = Math.round((done / tracks.length) * 100);
      status.innerHTML = `
        <div>업로드 중 ${done + 1} / ${tracks.length}${currentTitle ? ` — ${currentTitle}` : ''}</div>
        <span class="sync-progress"><span class="sync-progress-bar" style="width:${pct}%"></span></span>
      `;
    };
    for (const t of tracks) {
      renderProgress(t.title);
      try {
        const blob = await localStore.getAudio(t.id);
        if (blob) {
          // 50MB 초과면 Supabase 거부. 자동 압축은 당장 OFF — 트랙 메타만 올림.
          if (blob.size > 48 * 1024 * 1024) {
            console.warn('[migrate] 크기 초과, 메타만 업로드:', t.title, blob.size);
          } else {
            await store.saveAudio(t.id, blob);
          }
        }
        await store.saveTrack(t);
        done++;
      } catch (e) {
        console.error('[migrate] 실패:', t.title, e);
        failed++;
      }
    }
    status.innerHTML = `<div>✅ ${done}/${tracks.length} 업로드 완료${failed ? ` (${failed}개 실패)` : ''}</div>`;
    btn.hidden = true;
    setTimeout(() => { status.hidden = true; }, 4000);
    renderLibrary();
  }

  /* ========== 시작 ========== */
  (async () => {
    await initPinGate();
    renderLibrary();
    checkMigrationNeeded();
  })();

  /* ========== 가사 분석 (오디오 자동 표기) ========== */
  const FRAME = 2048;
  const HOP = 512;
  // 피치 검출은 다운샘플 후 별도 파라미터로 — YIN이 O(N²)이므로 SR·N 줄이면 크게 빨라짐
  const PITCH_TARGET_SR = 16000;
  const PITCH_FRAME = 1024;
  const PITCH_HOP = 512;
  let pcmCache = { trackId: null, audioBuffer: null };

  async function decodeAudioToBuffer(blob) {
    if (pcmCache.trackId === current.id && pcmCache.audioBuffer) return pcmCache.audioBuffer;
    const arrayBuf = await blob.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, 44100);
    const buf = await ctx.decodeAudioData(arrayBuf);
    pcmCache = { trackId: current.id, audioBuffer: buf };
    return buf;
  }

  function toMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;
    return mono;
  }

  function sliceMono(mono, sampleRate, startSec, endSec) {
    const s = Math.max(0, Math.floor(startSec * sampleRate));
    const e = Math.min(mono.length, Math.floor(endSec * sampleRate));
    return mono.subarray(s, e);
  }

  function median(arr) {
    if (!arr.length) return 0;
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeRMSContour(pcm) {
    const nFrames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
    const out = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      let sum = 0;
      const start = i * HOP;
      for (let j = 0; j < FRAME; j++) sum += pcm[start + j] * pcm[start + j];
      out[i] = Math.sqrt(sum / FRAME);
    }
    return out;
  }

  function detectOnsets(rmsContour, sampleRate, offsetSec) {
    const onsets = [];
    const nonZero = Array.from(rmsContour).filter((v) => v > 0.001);
    const noiseFloor = (nonZero.length ? median(nonZero) : 0.01) * 0.5;
    const minGapFrames = Math.max(1, Math.floor(0.08 * sampleRate / HOP));
    let lastOnsetFrame = -minGapFrames;
    for (let i = 2; i < rmsContour.length - 2; i++) {
      const cur = rmsContour[i];
      if (cur < noiseFloor * 1.5) continue;
      const rising = cur > rmsContour[i - 1] && cur > rmsContour[i - 2];
      const peak = cur >= rmsContour[i + 1] && cur >= rmsContour[i + 2];
      if (rising && peak && i - lastOnsetFrame > minGapFrames) {
        onsets.push(offsetSec + (i * HOP) / sampleRate);
        lastOnsetFrame = i;
      }
    }
    return onsets;
  }

  // YIN pitch detection (De Cheveigné & Kawahara 2002)
  // 경량 자체 구현 — 프레임 하나 → 기본 주파수(Hz) 또는 null
  function yinPitch(frame, sampleRate, threshold) {
    const N = frame.length;
    const halfN = Math.floor(N / 2);
    const yinBuf = new Float32Array(halfN);
    // Step 1-2: difference function + cumulative mean normalized
    yinBuf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfN; tau++) {
      let sum = 0;
      for (let j = 0; j + tau < N; j++) {
        const d = frame[j] - frame[j + tau];
        sum += d * d;
      }
      yinBuf[tau] = sum;
      runningSum += sum;
      yinBuf[tau] = runningSum > 0 ? sum * tau / runningSum : 1;
    }
    // Step 3: absolute threshold — find first tau below threshold, then local min
    const th = threshold || 0.15;
    let tauEstimate = -1;
    for (let tau = 2; tau < halfN; tau++) {
      if (yinBuf[tau] < th) {
        while (tau + 1 < halfN && yinBuf[tau + 1] < yinBuf[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate < 0) return null;
    // Step 4: parabolic interpolation for sub-sample accuracy
    let betterTau = tauEstimate;
    if (tauEstimate > 0 && tauEstimate < halfN - 1) {
      const s0 = yinBuf[tauEstimate - 1];
      const s1 = yinBuf[tauEstimate];
      const s2 = yinBuf[tauEstimate + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
    }
    return sampleRate / betterTau;
  }

  // 정수배 다운샘플 (음성용, low-pass 없이 간단 평균 — 판소리 피치 대역 60-1200Hz엔 충분)
  function downsampleForPitch(pcm, sourceSR, targetSR) {
    if (sourceSR <= targetSR + 100) return { pcm, sr: sourceSR };
    const ratio = Math.max(1, Math.round(sourceSR / targetSR));
    const outLen = Math.floor(pcm.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let sum = 0;
      const base = i * ratio;
      for (let j = 0; j < ratio; j++) sum += pcm[base + j] || 0;
      out[i] = sum / ratio;
    }
    return { pcm: out, sr: sourceSR / ratio };
  }

  async function detectPitchContour(pcm, sampleRate, onProgress) {
    const { pcm: dsPcm, sr } = downsampleForPitch(pcm, sampleRate, PITCH_TARGET_SR);
    const nFrames = Math.max(0, Math.floor((dsPcm.length - PITCH_FRAME) / PITCH_HOP) + 1);
    const out = new Array(nFrames);
    const frame = new Float32Array(PITCH_FRAME);
    for (let i = 0; i < nFrames; i++) {
      const start = i * PITCH_HOP;
      for (let j = 0; j < PITCH_FRAME; j++) frame[j] = dsPcm[start + j];
      let energy = 0;
      for (let j = 0; j < PITCH_FRAME; j++) energy += frame[j] * frame[j];
      if (energy / PITCH_FRAME < 1e-6) { out[i] = null; continue; }
      const hz = yinPitch(frame, sr, 0.15);
      out[i] = hz && hz > 60 && hz < 1200 ? hz : null;
      // 500프레임마다 UI에 양보
      if (onProgress && i > 0 && i % 500 === 0) {
        onProgress(i / nFrames);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return { pitches: out, framesPerSec: sr / PITCH_HOP };
  }

  function hzToCents(hz, refHz) {
    if (!hz) return null;
    return 1200 * Math.log2(hz / (refHz || 440));
  }

  function splitKoreanSyllables(text) {
    return text.replace(/[\s.,!?"';:()\[\]{}\-·]/g, '').split('');
  }

  // 완성형 한글 유니코드를 초성/중성/종성 인덱스로 분해. 한글이 아니면 null.
  function decomposeHangul(char) {
    const code = char.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return null;
    const idx = code - 0xac00;
    return {
      cho: Math.floor(idx / 588),          // 초성 (0-18)
      jung: Math.floor(idx / 28) % 21,     // 중성 (0-20)
      jong: idx % 28,                       // 종성 (0-27, 0이면 받침 없음)
    };
  }

  function composeHangul(cho, jung, jong) {
    return String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong);
  }

  // 중성 → 두 번째 글자에 들어갈 파생 모음.
  // 이중/복합모음은 후반부만 뽑아 자연스러운 연음이 되도록.
  // 인덱스 순서: ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ
  //             0  1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
  const SECOND_VOWEL_MAP = {
    0: 0,   // ㅏ → ㅏ
    1: 1,   // ㅐ → ㅐ
    2: 0,   // ㅑ → ㅏ
    3: 1,   // ㅒ → ㅐ
    4: 4,   // ㅓ → ㅓ
    5: 5,   // ㅔ → ㅔ
    6: 4,   // ㅕ → ㅓ  (쳐 → 쳐어)
    7: 5,   // ㅖ → ㅔ
    8: 8,   // ㅗ → ㅗ
    9: 0,   // ㅘ (ㅗ+ㅏ) → ㅏ  (관 → 과안)
    10: 1,  // ㅙ (ㅗ+ㅐ) → ㅐ
    11: 20, // ㅚ (ㅗ+ㅣ) → ㅣ
    12: 8,  // ㅛ (ㅣ+ㅗ) → ㅗ
    13: 13, // ㅜ → ㅜ
    14: 4,  // ㅝ (ㅜ+ㅓ) → ㅓ  (원 → 워언)
    15: 5,  // ㅞ (ㅜ+ㅔ) → ㅔ
    16: 20, // ㅟ (ㅜ+ㅣ) → ㅣ
    17: 13, // ㅠ (ㅣ+ㅜ) → ㅜ
    18: 18, // ㅡ → ㅡ
    19: 20, // ㅢ (ㅡ+ㅣ) → ㅣ
    20: 20, // ㅣ → ㅣ
  };

  // duration factor → 틸드 개수. 사용자 예시 재현:
  //   factor 8 (예: 4초짜리, 중앙값 500ms) → 9개 → `워~~~~~~~~~언`
  function computeTildeCount(factor) {
    if (factor <= 1.5) return 0;
    const n = Math.round((factor - 1) * 1.3);
    return Math.max(1, Math.min(15, n));
  }

  // 늘어남 표기 (판소리 스타일):
  //   받침 있는 음절: (초성+중성) + ~×n + (ㅇ+파생모음+종성)  예) 원 → 워~~언, 산 → 사안
  //   받침 없는 음절: 원음절     + ~×n + (ㅇ+파생모음)         예) 아 → 아~~아, 버 → 버어, 쳐 → 쳐어
  function elongateSyllable(char, factor) {
    const parts = decomposeHangul(char);
    if (!parts) return char;
    const nTildes = computeTildeCount(factor);
    if (nTildes === 0 && parts.jong === 0) return char; // 늘어남 없음 (받침 없는 짧은 음절은 그대로)
    // 받침 있어도 factor 1.5 이하면 분리 안 함
    if (nTildes === 0) return char;
    const secondJung = SECOND_VOWEL_MAP[parts.jung] ?? parts.jung;
    const tildes = '~'.repeat(nTildes);
    if (parts.jong !== 0) {
      // 받침이 있으면: 종성 없는 앞부분 + 틸드 + ㅇ+파생모음+종성
      const firstPart = composeHangul(parts.cho, parts.jung, 0);
      const secondPart = composeHangul(11, secondJung, parts.jong); // ㅇ = 11
      return firstPart + tildes + secondPart;
    }
    // 받침이 없으면: 원음절 + 틸드 + ㅇ+파생모음
    const secondPart = composeHangul(11, secondJung, 0);
    return char + tildes + secondPart;
  }

  // 각 줄에 [startSec, endSec] 시간 범위가 주어질 때, 그 안에 떨어지는 온셋만 그 줄로 배정
  function distributeOnsetsToLines(allOnsets, lineTimeRanges) {
    return lineTimeRanges.map(([s, e]) => allOnsets.filter((o) => o >= s && o < e));
  }

  // 리딩·트레일링 무음 구간을 잘라내 실제 발화 시작·끝을 찾는다
  function trimSilence(rmsContour, sampleRate, offsetSec) {
    const nonZero = Array.from(rmsContour).filter((v) => v > 0.001);
    if (!nonZero.length) return { startSec: offsetSec, endSec: offsetSec + rmsContour.length * HOP / sampleRate };
    const threshold = median(nonZero) * 0.35;
    let first = 0, last = rmsContour.length - 1;
    while (first < rmsContour.length && rmsContour[first] < threshold) first++;
    while (last > first && rmsContour[last] < threshold) last--;
    return {
      startSec: offsetSec + (first * HOP) / sampleRate,
      endSec: offsetSec + (last * HOP) / sampleRate,
    };
  }

  function computeLineBoundaries(nSyll, lineOnsets, lineStartSec, lineEndSec) {
    const boundaries = new Array(nSyll + 1);
    boundaries[0] = lineStartSec;
    boundaries[nSyll] = lineEndSec;
    const evenDur = (lineEndSec - lineStartSec) / nSyll;
    if (lineOnsets.length >= nSyll - 1 && lineOnsets.length > 0) {
      const step = Math.max(1, lineOnsets.length / nSyll);
      for (let i = 1; i < nSyll; i++) {
        const oIdx = Math.min(lineOnsets.length - 1, Math.floor(i * step));
        boundaries[i] = lineOnsets[oIdx];
      }
    } else {
      for (let i = 1; i < nSyll; i++) boundaries[i] = lineStartSec + i * evenDur;
    }
    for (let i = 1; i < nSyll; i++) {
      if (boundaries[i] <= boundaries[i - 1]) boundaries[i] = boundaries[i - 1] + 0.02;
      if (boundaries[i] >= lineEndSec) boundaries[i] = lineEndSec - 0.02;
    }
    return boundaries;
  }

  function computeSyllableFeatures(syllables, boundaries, offsetSec, pitchContour, rmsContour, rmsFramesPerSec, pitchFramesPerSec) {
    const feats = [];
    for (let i = 0; i < syllables.length; i++) {
      const startSec = boundaries[i];
      const endSec = boundaries[i + 1];
      const durationMs = (endSec - startSec) * 1000;
      const rmsStart = Math.max(0, Math.floor((startSec - offsetSec) * rmsFramesPerSec));
      const rmsEnd = Math.min(rmsContour.length, Math.floor((endSec - offsetSec) * rmsFramesPerSec));
      const pitchStart = Math.max(0, Math.floor((startSec - offsetSec) * pitchFramesPerSec));
      const pitchEnd = Math.min(pitchContour.length, Math.floor((endSec - offsetSec) * pitchFramesPerSec));
      const syllPitches = pitchContour.slice(pitchStart, pitchEnd).filter((v) => v != null);
      const rmsSlice = rmsContour.slice(rmsStart, rmsEnd);
      const meanRMS = rmsSlice.length ? rmsSlice.reduce((a, b) => a + b, 0) / rmsSlice.length : 0;
      const cents = syllPitches.map((hz) => hzToCents(hz));
      const meanCents = cents.length ? cents.reduce((a, b) => a + b, 0) / cents.length : null;
      const pitchSlope = cents.length > 6 ? cents[cents.length - 1] - cents[0] : 0;
      feats.push({ startSec, endSec, durationMs, meanRMS, meanCents, pitchSlope });
    }
    return feats;
  }

  // 판소리 스타일 늘어남 + 인라인 강조 + 시간 표시.
  // 반환: { tokens: [{text, accent, durationSec}...], hints: ['음 내려가지 않게'...] }
  //   accent: RMS 피크(1.5×↑) 음절 → 인라인 '!' + 굵게
  //   durationSec >= 3 → 렌더러가 뒤에 ⟨약 N초⟩ 붙임
  function annotateLine(syllables, feats, medians) {
    // 1) RMS 피크(강조 대상) 찾기
    let peakIdx = -1, peakRatio = 0;
    if (medians.rms > 0) {
      for (let i = 0; i < feats.length; i++) {
        const r = feats[i].meanRMS / medians.rms;
        if (r > peakRatio) { peakRatio = r; peakIdx = i; }
      }
      if (peakRatio <= 1.5) peakIdx = -1;
    }

    // 2) 음절별 토큰 생성
    const tokens = [];
    for (let i = 0; i < syllables.length; i++) {
      const f = feats[i];
      const factor = medians.duration > 0 ? f.durationMs / medians.duration : 1;
      const text = factor > 1.5 ? elongateSyllable(syllables[i], factor) : syllables[i];
      tokens.push({
        text,
        accent: i === peakIdx,
        durationSec: f.durationMs / 1000,
      });
    }

    // 3) 힌트 — 피치 하강만 (강하게는 인라인으로 이동됨)
    const candidates = [];
    for (let i = 0; i < feats.length; i++) {
      if (feats[i].pitchSlope < -120) {
        candidates.push({
          kind: 'pitch-down',
          score: -feats[i].pitchSlope / 100,
          text: `${i + 1}음절: 음 내려가지 않게`,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const hints = [];
    const seenKinds = new Set();
    for (const c of candidates) {
      if (seenKinds.has(c.kind)) continue;
      hints.push(c.text);
      seenKinds.add(c.kind);
      if (hints.length >= 2) break;
    }

    return { tokens, hints };
  }

  function parseTimeInput(v) {
    if (!v) return null;
    const m = v.trim().match(/^(\d+):(\d+(\.\d+)?)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  }

  async function analyzeStandalone() {
    if (!current) return;
    const inputText = $('#analysis-input').value.trim();
    if (!inputText) return toast('가사를 입력해주세요');
    const lines = inputText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return toast('가사를 입력해주세요');

    const segMode = document.querySelector('input[name="seg-mode"]:checked').value;
    let startSec = 0, endSec = audio.duration || current.duration || 0;
    if (segMode === 'ab') {
      if (current.ab.a == null || current.ab.b == null) return toast('A-B 지점을 먼저 정하세요');
      startSec = current.ab.a; endSec = current.ab.b;
    } else if (segMode === 'custom') {
      startSec = parseTimeInput($('#seg-start').value);
      endSec = parseTimeInput($('#seg-end').value);
      if (startSec == null || endSec == null || endSec <= startSec) return toast('시작·끝 시각(mm:ss)을 확인하세요');
    }
    if (endSec - startSec < 0.5) return toast('구간이 너무 짧아요');

    $('#analysis-loading').hidden = false;
    $('#analysis-loading-text').textContent = '오디오 디코드 중...';

    try {
      const blob = await store.getAudio(current.id);
      if (!blob) throw new Error('오디오 파일 없음');
      const audioBuffer = await decodeAudioToBuffer(blob);
      const sr = audioBuffer.sampleRate;
      $('#analysis-loading-text').textContent = '오디오 특징 추출 중...';
      await new Promise((r) => setTimeout(r, 10));

      const mono = toMono(audioBuffer);
      const slice = sliceMono(mono, sr, startSec, endSec);
      const rmsFramesPerSec = sr / HOP;

      $('#analysis-loading-text').textContent = '에너지·온셋 계산 중...';
      await new Promise((r) => setTimeout(r, 0));
      const rmsContour = computeRMSContour(slice);

      // 리딩·트레일링 무음 잘라내기 — 실제 발화 구간을 [singStart, singEnd]로
      const { startSec: singStart, endSec: singEnd } = trimSilence(rmsContour, sr, startSec);
      const effStart = Math.max(startSec, singStart);
      const effEnd = Math.min(endSec, Math.max(singEnd, singStart + 0.5));

      const allOnsets = detectOnsets(rmsContour, sr, startSec);

      $('#analysis-loading-text').textContent = '피치 분석 중... (0%)';
      await new Promise((r) => setTimeout(r, 0));
      const { pitches: pitchContour, framesPerSec: pitchFramesPerSec } = await detectPitchContour(
        slice,
        sr,
        (frac) => { $('#analysis-loading-text').textContent = `피치 분석 중... (${Math.round(frac * 100)}%)`; }
      );

      $('#analysis-loading-text').textContent = '가사 정렬 및 힌트 생성 중...';
      await new Promise((r) => setTimeout(r, 0));

      const linesSyllables = lines.map(splitKoreanSyllables);
      const syllableCounts = linesSyllables.map((s) => s.length);
      const totalSyll = syllableCounts.reduce((a, b) => a + b, 0);

      // 줄별 시간 범위를 먼저 정한 뒤, 온셋을 시간 위치로 각 줄에 배정
      const lineTimeRanges = [];
      let cursor = effStart;
      const effDur = Math.max(0.01, effEnd - effStart);
      for (let li = 0; li < lines.length; li++) {
        const lineDur = totalSyll ? effDur * (syllableCounts[li] / totalSyll) : effDur;
        lineTimeRanges.push([cursor, cursor + lineDur]);
        cursor += lineDur;
      }
      const perLineOnsets = distributeOnsetsToLines(allOnsets, lineTimeRanges);

      const linePasses = [];
      const allDurs = [];
      const allRMS = [];
      for (let li = 0; li < lines.length; li++) {
        const syllables = linesSyllables[li];
        if (!syllables.length) { linePasses.push(null); continue; }
        const [ls, le] = lineTimeRanges[li];
        const boundaries = computeLineBoundaries(syllables.length, perLineOnsets[li], ls, le);
        const feats = computeSyllableFeatures(syllables, boundaries, startSec, pitchContour, rmsContour, rmsFramesPerSec, pitchFramesPerSec);
        linePasses.push({ syllables, feats, lineStart: ls, lineEnd: le });
        feats.forEach((f) => {
          if (f.durationMs > 0) allDurs.push(f.durationMs);
          if (f.meanRMS > 0) allRMS.push(f.meanRMS);
        });
      }

      const medians = {
        duration: median(allDurs) || 200,
        rms: median(allRMS.filter((r) => r > 0.001)) || 0.01,
      };

      const results = [];
      for (let li = 0; li < linePasses.length; li++) {
        if (!linePasses[li]) {
          results.push({ i: li, original: lines[li], tokens: [], hints: [] });
          continue;
        }
        const { syllables, feats } = linePasses[li];
        const { tokens, hints } = annotateLine(syllables, feats, medians);
        results.push({ i: li, original: lines[li], tokens, hints });
      }

      current.standaloneAnalysis = {
        inputText,
        segment: { mode: segMode, startSec, endSec },
        showAnnotated: true,
        results,
        analyzedAt: Date.now(),
      };
      await persist();
      renderStandaloneAnalysis();
      toast('분석 완료');
    } catch (err) {
      console.error(err);
      toast('분석 오류: ' + (err.message || err));
    } finally {
      $('#analysis-loading').hidden = true;
    }
  }

  function renderStandaloneAnalysis() {
    const analysis = current?.standaloneAnalysis;
    const resultsEl = $('#analysis-results');
    const toolsEl = $('#analysis-tools');
    const inputEl = $('#analysis-input');
    if (!analysis) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      toolsEl.hidden = true;
      return;
    }
    inputEl.value = analysis.inputText;
    const seg = analysis.segment;
    const radio = document.querySelector(`input[name="seg-mode"][value="${seg.mode}"]`);
    if (radio) radio.checked = true;
    updateSegmentCustomVisibility();
    if (seg.mode === 'custom') {
      $('#seg-start').value = fmt(seg.startSec);
      $('#seg-end').value = fmt(seg.endSec);
    }
    toolsEl.hidden = false;
    $('#analysis-toggle-btn').textContent = analysis.showAnnotated ? '원문' : '분석';
    resultsEl.hidden = false;
    resultsEl.innerHTML = '';
    analysis.results.forEach((res) => {
      const line = document.createElement('div');
      line.className = 'result-line';

      const textEl = document.createElement('div');
      textEl.className = 'result-text';
      if (analysis.showAnnotated) {
        // 새 스키마: tokens 있으면 인라인 렌더, 없으면 문자열 폴백 (기존 저장 데이터 호환)
        if (res.tokens && res.tokens.length) {
          renderTokens(textEl, res.tokens);
        } else {
          textEl.textContent = res.annotated || res.original;
        }
      } else {
        textEl.textContent = res.original;
      }
      line.appendChild(textEl);

      if (analysis.showAnnotated && res.hints && res.hints.length) {
        const hintEl = document.createElement('div');
        hintEl.className = 'result-hints';
        const arrow = document.createElement('span');
        arrow.className = 'hint-arrow';
        arrow.textContent = '↳';
        hintEl.appendChild(arrow);
        res.hints.forEach((h) => {
          const span = document.createElement('span');
          span.className = 'hint-item';
          span.textContent = h;
          hintEl.appendChild(span);
        });
        line.appendChild(hintEl);
      }
      resultsEl.appendChild(line);
    });
  }

  function renderTokens(container, tokens) {
    tokens.forEach((tok, idx) => {
      if (tok.accent) {
        const strong = document.createElement('strong');
        strong.className = 'syl-accent';
        strong.textContent = '!' + tok.text;
        container.appendChild(strong);
      } else {
        const span = document.createElement('span');
        span.className = 'syl';
        span.textContent = tok.text;
        container.appendChild(span);
      }
      if (tok.durationSec >= 3) {
        const dur = document.createElement('span');
        dur.className = 'syl-duration';
        // 0.5초 단위 반올림
        const rounded = Math.round(tok.durationSec * 2) / 2;
        const label = rounded % 1 === 0 ? `${rounded | 0}초` : `${rounded}초`;
        dur.textContent = `⟨약 ${label}⟩`;
        container.appendChild(dur);
      }
      // 마지막 토큰이 아니면 공백 추가
      if (idx < tokens.length - 1) container.appendChild(document.createTextNode(' '));
    });
  }

  function updateSegmentCustomVisibility() {
    const mode = document.querySelector('input[name="seg-mode"]:checked')?.value;
    $('#segment-custom').hidden = mode !== 'custom';
  }

  function restoreAnalysisUI() {
    pcmCache = { trackId: null, audioBuffer: null };
    $('#analysis-input').value = '';
    $('#analysis-results').hidden = true;
    $('#analysis-results').innerHTML = '';
    $('#analysis-tools').hidden = true;
    $('#analysis-loading').hidden = true;
    const full = document.querySelector('input[name="seg-mode"][value="full"]');
    if (full) full.checked = true;
    $('#seg-start').value = '';
    $('#seg-end').value = '';
    updateSegmentCustomVisibility();
    if (current?.standaloneAnalysis) renderStandaloneAnalysis();
  }

  $('#analyze-start-btn').addEventListener('click', analyzeStandalone);
  $('#analysis-toggle-btn').addEventListener('click', () => {
    if (!current?.standaloneAnalysis) return;
    current.standaloneAnalysis.showAnnotated = !current.standaloneAnalysis.showAnnotated;
    persist();
    renderStandaloneAnalysis();
  });
  $('#analysis-reset-btn').addEventListener('click', () => {
    if (!current) return;
    if (!confirm('가사 분석 결과와 입력을 초기화할까요?')) return;
    current.standaloneAnalysis = null;
    persist();
    restoreAnalysisUI();
    toast('초기화 완료');
  });
  document.querySelectorAll('input[name="seg-mode"]').forEach((r) => {
    r.addEventListener('change', updateSegmentCustomVisibility);
  });

  /* ========== 서비스워커 (PWA/오프라인) ========== */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
