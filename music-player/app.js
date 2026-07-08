// ---------- Мини хранилище IndexedDB для FileSystemDirectoryHandle ----------
const DB_NAME = 'reel-player';
const STORE = 'handles';

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Состояние ----------
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm|opus)$/i;
const supportsFSAccess = 'showDirectoryPicker' in window;

let tracks = [];        // {name, getFile: async ()=>File}
let currentIndex = -1;
let currentURL = null;
let shuffleOn = false;
let repeatMode = 'off'; // off | all | one
let shuffleOrder = [];

// ---------- Элементы ----------
const $ = id => document.getElementById(id);
const audio = $('audio');
const addFolderBtn = $('addFolderBtn');
const folderInputFS = $('folderInputFS');
const folderInputFallback = $('folderInputFallback');
const trackTitleEl = $('trackTitle');
const trackArtistEl = $('trackArtist');
const timeCurrentEl = $('timeCurrent');
const timeTotalEl = $('timeTotal');
const scrub = $('scrub');
const playBtn = $('playBtn');
const playIcon = $('playIcon');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const shuffleBtn = $('shuffleBtn');
const repeatBtn = $('repeatBtn');
const repeatOneDot = $('repeatOneDot');
const tracklistEl = $('tracklist');
const emptyState = $('emptyState');
const libraryCount = $('libraryCount');
const reelsEl = $('reels');
const platformNote = $('platformNote');

platformNote.textContent = supportsFSAccess
  ? 'Файлы читаются напрямую с устройства. Ничего никуда не загружается.'
  : 'Твой браузер не поддерживает постоянный доступ к папке — при перезапуске выбери файлы ещё раз.';

// ---------- Разбор имени файла на артиста/название ----------
function parseName(filename){
  const base = filename.replace(AUDIO_EXT, '');
  const m = base.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: 'Локальная библиотека', title: base };
}

function fmtTime(sec){
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ---------- Сбор файлов из FileSystemDirectoryHandle ----------
async function collectFromDirHandle(dirHandle, path = ''){
  const found = [];
  for await (const [name, handle] of dirHandle.entries()){
    if (handle.kind === 'file'){
      if (AUDIO_EXT.test(name)){
        found.push({
          name,
          getFile: () => handle.getFile()
        });
      }
    } else if (handle.kind === 'directory'){
      const nested = await collectFromDirHandle(handle, path + name + '/');
      found.push(...nested);
    }
  }
  return found;
}

async function loadFromDirHandle(dirHandle){
  const perm = await dirHandle.queryPermission({ mode: 'read' });
  if (perm !== 'granted'){
    const req = await dirHandle.requestPermission({ mode: 'read' });
    if (req !== 'granted') return false;
  }
  const found = await collectFromDirHandle(dirHandle);
  found.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  tracks = found;
  renderTracklist();
  return true;
}

// ---------- Восстановление сохранённой папки при запуске ----------
(async function restore(){
  if (!supportsFSAccess) return;
  try{
    const handle = await idbGet('dirHandle');
    if (handle) await loadFromDirHandle(handle);
  }catch(e){ /* нет доступа — попросим выбрать заново */ }
})();

// ---------- Выбор папки / файлов ----------
addFolderBtn.addEventListener('click', async () => {
  if (supportsFSAccess){
    try{
      const dirHandle = await window.showDirectoryPicker();
      await idbSet('dirHandle', dirHandle);
      await loadFromDirHandle(dirHandle);
    }catch(e){ /* пользователь отменил выбор */ }
  } else {
    folderInputFallback.click();
  }
});

folderInputFallback.addEventListener('change', () => {
  const files = Array.from(folderInputFallback.files).filter(f => AUDIO_EXT.test(f.name));
  files.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  tracks = files.map(f => ({ name: f.name, getFile: async () => f }));
  renderTracklist();
});

// ---------- Отрисовка списка треков ----------
function renderTracklist(){
  tracklistEl.innerHTML = '';
  emptyState.hidden = tracks.length > 0;
  libraryCount.textContent = tracks.length ? `${tracks.length} треков` : '';
  prevBtn.disabled = nextBtn.disabled = playBtn.disabled = tracks.length === 0;

  tracks.forEach((t, i) => {
    const { artist, title } = parseName(t.name);
    const li = document.createElement('li');
    li.className = 'track-item' + (i === currentIndex ? ' active' : '');
    li.innerHTML = `
      <span class="t-index">${String(i+1).padStart(2,'0')}</span>
      <span class="t-meta">
        <span class="t-name">${title}</span>
        <span class="t-sub">${artist}</span>
      </span>`;
    li.addEventListener('click', () => playIndex(i));
    tracklistEl.appendChild(li);
  });
}

// ---------- Воспроизведение ----------
async function playIndex(i){
  if (i < 0 || i >= tracks.length) return;
  currentIndex = i;
  const file = await tracks[i].getFile();
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = URL.createObjectURL(file);
  audio.src = currentURL;

  const { artist, title } = parseName(tracks[i].name);
  trackTitleEl.textContent = title;
  trackArtistEl.textContent = artist;

  if ('mediaSession' in navigator){
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album: 'Reel — локальная библиотека'
    });
  }

  renderTracklist();
  try{ await audio.play(); }catch(e){ /* автоплей может требовать жеста пользователя */ }
}

function nextIndex(){
  if (shuffleOn){
    if (shuffleOrder.length === 0) shuffleOrder = shuffledIndices();
    const pos = shuffleOrder.indexOf(currentIndex);
    return shuffleOrder[(pos + 1) % shuffleOrder.length];
  }
  return (currentIndex + 1) % tracks.length;
}
function prevIndex(){
  if (shuffleOn){
    if (shuffleOrder.length === 0) shuffleOrder = shuffledIndices();
    const pos = shuffleOrder.indexOf(currentIndex);
    return shuffleOrder[(pos - 1 + shuffleOrder.length) % shuffleOrder.length];
  }
  return (currentIndex - 1 + tracks.length) % tracks.length;
}
function shuffledIndices(){
  const arr = tracks.map((_, i) => i);
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

playBtn.addEventListener('click', () => {
  if (currentIndex === -1){ playIndex(0); return; }
  if (audio.paused) audio.play(); else audio.pause();
});
nextBtn.addEventListener('click', () => playIndex(nextIndex()));
prevBtn.addEventListener('click', () => {
  if (audio.currentTime > 3){ audio.currentTime = 0; return; }
  playIndex(prevIndex());
});

shuffleBtn.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  shuffleOrder = shuffleOn ? shuffledIndices() : [];
  shuffleBtn.setAttribute('aria-pressed', String(shuffleOn));
});
repeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  repeatBtn.setAttribute('aria-pressed', String(repeatMode !== 'off'));
  repeatOneDot.hidden = repeatMode !== 'one';
});

audio.addEventListener('play', () => {
  playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>';
  playBtn.title = 'Пауза';
  reelsEl.classList.add('spinning');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  playIcon.innerHTML = '<path d="M7 5v14l12-7z" fill="currentColor"/>';
  playBtn.title = 'Играть';
  reelsEl.classList.remove('spinning');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('ended', () => {
  if (repeatMode === 'one'){ playIndex(currentIndex); return; }
  if (repeatMode === 'off' && currentIndex === tracks.length - 1 && !shuffleOn) return;
  playIndex(nextIndex());
});
audio.addEventListener('timeupdate', () => {
  timeCurrentEl.textContent = fmtTime(audio.currentTime);
  if (audio.duration){
    scrub.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && audio.duration){
    try{
      navigator.mediaSession.setPositionState({
        duration: audio.duration, playbackRate: 1, position: audio.currentTime
      });
    }catch(e){}
  }
});
audio.addEventListener('loadedmetadata', () => {
  timeTotalEl.textContent = fmtTime(audio.duration);
  scrub.disabled = false;
});

scrub.addEventListener('input', () => {
  if (!audio.duration) return;
  audio.currentTime = (Number(scrub.value) / 1000) * audio.duration;
});

// ---------- Управление с экрана блокировки / наушников ----------
if ('mediaSession' in navigator){
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => playIndex(prevIndex()));
  navigator.mediaSession.setActionHandler('nexttrack', () => playIndex(nextIndex()));
  navigator.mediaSession.setActionHandler('seekbackward', (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler('seekforward', (d) => {
    audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (d.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler('seekto', (d) => {
    if (d.seekTime != null) audio.currentTime = d.seekTime;
  });
}

// ---------- Service worker (офлайн-оболочка приложения) ----------
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
