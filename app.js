/* 또랑또랑 — 판소리 연습장 (1단계 MVP)
   서버 없이 브라우저 IndexedDB에 로컬 저장 · GitHub Pages 배포용 */

(() => {
  'use strict';

  /* ========== IndexedDB 래퍼 ========== */
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

  const store = {
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
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const title = file.name.replace(/\.[^.]+$/, '');
    const duration = await probeDuration(file);

    const track = {
      id, title, fileName: file.name, mime: file.type,
      createdAt: Date.now(), duration,
      lyrics: [], memos: [], ab: { a: null, b: null },
    };
    await store.saveAudio(id, file);
    await store.saveTrack(track);
    toast('불러왔어요');
    openTrack(id);
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

  /* ========== 시작 ========== */
  renderLibrary();

  /* ========== 서비스워커 (PWA/오프라인) ========== */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
