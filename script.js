/* /script.js
   Pitch Matching Test (single-note)
   - Requires a user gesture to start audio (Begin Game button).
*/
(() => {
  "use strict";

  const AUDIO_DIR = "audio";

  const OUTER_H = 320;
  const BORDER_PX = 19;

  const WHITE_W = 40;
  const WHITE_H = OUTER_H - (BORDER_PX * 2);
  const BLACK_W = Math.round(WHITE_W * 0.62);
  const BLACK_H = Math.round(WHITE_H * 0.63);

  const RADIUS = 18;
  const WHITE_CORNER_R = 10;

  const PRESELECT_COLOR_DEFAULT = "#0099ff";
  const CORRECT_COLOR = "#34c759";
  const WRONG_COLOR = "#ff6b6b";

  const LIMITER_THRESHOLD_DB = -6;
  const STOP_FADE_SEC = 0.04;

  const PC_TO_STEM = {
    0: "c",
    1: "csharp",
    2: "d",
    3: "dsharp",
    4: "e",
    5: "f",
    6: "fsharp",
    7: "g",
    8: "gsharp",
    9: "a",
    10: "asharp",
    11: "b",
  };

  const PC_NAMES_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const PC_NAMES_FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];

  const KEYBOARD_PRESETS = {
    "4oct-c2": { startOctave: 2, octaves: 4, endOnFinalC: true },
    "3oct-c3": { startOctave: 3, octaves: 3, endOnFinalC: true },
    "2oct-c3": { startOctave: 3, octaves: 2, endOnFinalC: true },
    "1oct-c4": { startOctave: 4, octaves: 1, endOnFinalC: true },
  };

  const $ = (id) => document.getElementById(id);

  const mount = $("mount");
  const keyboardRangeSel = $("keyboardRange");
  const highlightColorInput = $("highlightColor");

  const beginBtn = $("beginBtn");
  const replayBtn = $("replayBtn");
  const submitBtn = $("submitBtn");
  const nextBtn = $("nextBtn");
  const downloadScoreBtn = $("downloadScoreBtn");

  const actionHint = $("actionHint");
  const feedbackOut = $("feedbackOut");
  const scoreOut = $("scoreOut");

  const streakModal = $("streakModal");
  const modalTitle = $("modalTitle");
  const modalBody = $("modalBody");
  const modalClose = $("modalClose");
  const modalDownload = $("modalDownload");

  // Safety: if HTML/JS mismatch, fail loudly in UI.
  if (!mount || !keyboardRangeSel || !highlightColorInput || !beginBtn || !replayBtn || !submitBtn || !nextBtn || !downloadScoreBtn || !feedbackOut || !scoreOut) {
    const msg = "UI mismatch: some required elements are missing. Make sure index.html matches script.js (beginBtn, keyboardRange, highlightColor, replayBtn, submitBtn, downloadScoreBtn, feedbackOut, scoreOut, mount).";
    if (feedbackOut) feedbackOut.textContent = msg;
    else alert(msg);
    return;
  }

  let svg = null;
  const pitchToKey = new Map();
  let allPitches = [];

  let started = false;
  let targetPitch = null;
  let pickedPitch = null;
  let lastTargetPitch = null;

  let awaitingNext = false;

  let highlightColor = PRESELECT_COLOR_DEFAULT;

  const score = { asked: 0, correct: 0, streak: 0, longestStored: 0 };

  let audioCtx = null;
  let masterGain = null;
  let limiter = null;

  const bufferPromiseCache = new Map();
  const activeVoices = new Set();

  function ensureAudioGraph() {
    if (audioCtx) return audioCtx;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      alert("Your browser doesn’t support Web Audio (required for playback).");
      return null;
    }

    audioCtx = new Ctx();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;

    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;

    masterGain.connect(limiter);
    limiter.connect(audioCtx.destination);

    return audioCtx;
  }

  async function resumeAudioIfNeeded() {
    const ctx = ensureAudioGraph();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch {}
    }
  }

  function trackVoice(src, gain, startTime) {
    const voice = { src, gain, startTime };
    activeVoices.add(voice);
    src.onended = () => activeVoices.delete(voice);
    return voice;
  }

   let lastHeight = 0;

const ro = new ResizeObserver(entries => {
  for (const entry of entries) {
    const height = Math.ceil(entry.contentRect.height);

    if (height !== lastHeight) {
      parent.postMessage({ iframeHeight: height }, "*");
      lastHeight = height;
    }
  }
});

// Observe the root layout element
ro.observe(document.documentElement);

  function gameModeLabel() {
    switch (keyboardRangeSel.value) {
      case "1oct-c4": return "1 octave";
      case "2oct-c3": return "2 octaves";
      case "3oct-c3": return "3 octaves";
      case "4oct-c2": return "4 octaves";
      default: return "Custom";
    }
  }

   function postHeightNow() {
  try {
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    parent.postMessage({ iframeHeight: h }, "*");
  } catch {}
}

window.addEventListener("load", () => {
  postHeightNow();
  setTimeout(postHeightNow, 250);
  setTimeout(postHeightNow, 1000);
});

window.addEventListener("orientationchange", () => {
  setTimeout(postHeightNow, 100);
  setTimeout(postHeightNow, 500);
});

  function enableScrollForwardingToParent() {
  const SCROLL_GAIN = 6.0; // start here; now it should feel normal (try 2.0–3.0)

  const isVerticallyScrollable = () =>
    document.documentElement.scrollHeight > window.innerHeight + 2;

  const isInteractiveTarget = (t) =>
    t instanceof Element && !!t.closest("button, a, input, select, textarea, label");

  const isInPianoStrip = (t) =>
    t instanceof Element && !!t.closest("#mount, .mount, svg, .key");

  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let lockedMode = null;

  let lastMoveTs = 0;
  let vScrollTop = 0; // px/ms in scrollTop coordinates

  window.addEventListener("touchstart", (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.target;

    lockedMode = null;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastY = startY;

    lastMoveTs = e.timeStamp || performance.now();
    vScrollTop = 0;

    if (isInteractiveTarget(t) || isInPianoStrip(t)) lockedMode = "x";
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    if (isVerticallyScrollable()) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;

    const dx = x - startX;
    const dy = y - startY;

    if (!lockedMode) {
      if (Math.abs(dy) > Math.abs(dx) + 4) lockedMode = "y";
      else if (Math.abs(dx) > Math.abs(dy) + 4) lockedMode = "x";
      else return;
    }
    if (lockedMode !== "y") return;

    const nowTs = e.timeStamp || performance.now();
    const dt = Math.max(8, nowTs - lastMoveTs);
    lastMoveTs = nowTs;

    const fingerStep = (y - lastY) * SCROLL_GAIN;
    lastY = y;

    // Convert finger movement -> scrollTop delta (positive scrollTop means scroll down)
    const scrollTopDelta = -fingerStep;

    // velocity in scrollTop coords
    const instV = scrollTopDelta / dt; // px/ms
    vScrollTop = vScrollTop * 0.75 + instV * 0.25;

    e.preventDefault();
    parent.postMessage({ scrollTopDelta }, "*");
  }, { passive: false });

  function endGesture() {
    if (lockedMode === "y" && Math.abs(vScrollTop) > 0.05) {
      const capped = Math.max(-5.5, Math.min(5.5, vScrollTop));
      parent.postMessage({ scrollTopVelocity: capped }, "*");
    }
    lockedMode = null;
    vScrollTop = 0;
  }

  window.addEventListener("touchend", endGesture, { passive: true });
  window.addEventListener("touchcancel", endGesture, { passive: true });

  window.addEventListener("wheel", (e) => {
    if (isVerticallyScrollable()) return;
    parent.postMessage({ scrollTopDelta: e.deltaY }, "*"); // NOT inverted
  }, { passive: true });
}

enableScrollForwardingToParent();


  function stopAllNotes(fadeSec = STOP_FADE_SEC) {
    const ctx = ensureAudioGraph();
    if (!ctx) return;

    const now = ctx.currentTime;
    const fade = Math.max(0.01, Number.isFinite(fadeSec) ? fadeSec : STOP_FADE_SEC);

    for (const v of Array.from(activeVoices)) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, fade / 6);
        const stopAt = Math.max(now + fade, (v.startTime || now) + 0.001);
        v.src.stop(stopAt + 0.02);
      } catch {}
    }
  }

  function noteUrl(stem, octaveNum) {
    return `${AUDIO_DIR}/${stem}${octaveNum}.mp3`;
  }

  function loadBuffer(url) {
    if (bufferPromiseCache.has(url)) return bufferPromiseCache.get(url);

    const p = (async () => {
      const ctx = ensureAudioGraph();
      if (!ctx) return null;

      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    })();

    bufferPromiseCache.set(url, p);
    return p;
  }

  function playBufferAt(buffer, whenSec, gain = 1) {
    const ctx = ensureAudioGraph();
    if (!ctx || !masterGain) return null;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    const safeGain = Math.max(0, Number.isFinite(gain) ? gain : 1);
    const fadeIn = 0.004;

    g.gain.setValueAtTime(0, whenSec);
    g.gain.linearRampToValueAtTime(safeGain, whenSec + fadeIn);

    src.connect(g);
    g.connect(masterGain);
    trackVoice(src, g, whenSec);

    src.start(whenSec);
    return src;
  }

  function pitchFromPcOct(pc, oct) { return (oct * 12) + pc; }
  function pcFromPitch(pitch) { return ((pitch % 12) + 12) % 12; }
  function octFromPitch(pitch) { return Math.floor(pitch / 12); }
  function getStemForPc(pc) { return PC_TO_STEM[(pc + 12) % 12] || null; }

  async function playPitch(pitch, gain = 1) {
    const key = pitchToKey.get(pitch);
    if (!key) return;

    const pc = Number(key.getAttribute("data-pc"));
    const oct = Number(key.getAttribute("data-oct"));
    const stem = getStemForPc(pc);
    if (!stem) return;

    await resumeAudioIfNeeded();

    const url = noteUrl(stem, oct);
    const buf = await loadBuffer(url);
    if (!buf) {
      setResult(`Missing audio: <code>${url}</code>`);
      return;
    }

    const ctx = ensureAudioGraph();
    if (!ctx) return;

    playBufferAt(buf, ctx.currentTime, gain);
  }

  function randomInt(min, max) {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    return Math.floor(Math.random() * (b - a + 1)) + a;
  }

  function pickRandomPitchAvoidRepeat() {
    if (!allPitches.length) return null;
    if (allPitches.length === 1) return allPitches[0];

    for (let i = 0; i < 7; i++) {
      const p = allPitches[randomInt(0, allPitches.length - 1)];
      if (p !== lastTargetPitch) return p;
    }
    return allPitches[randomInt(0, allPitches.length - 1)];
  }

  function scorePercent() {
    if (score.asked <= 0) return 0;
    return Math.round((score.correct / score.asked) * 1000) / 10;
  }

  function displayLongest() {
    return Math.max(score.longestStored, score.streak);
  }

 function renderScore() {
  const items = [
    ["Questions asked", score.asked],
    ["Answers correct", score.correct],
    ["Correct in a row", score.streak],
    ["Longest correct streak", displayLongest()],
    ["Percentage correct", `${scorePercent()}%`],
  ];

  scoreOut.innerHTML =
    `<div class="scoreGrid">` +
    items.map(([k, v]) =>
      `<div class="scoreItem"><span class="scoreK">${k}</span><span class="scoreV">${v}</span></div>`
    ).join("") +
    `</div>`;
}


  function setResult(html) { feedbackOut.innerHTML = html || ""; }

  function clearAllHighlights() {
    if (!svg) return;
    svg.querySelectorAll(".key").forEach(k => k.classList.remove("selected", "handL", "correct", "wrong"));
  }

  function setKeyPreselected(pitch, on) {
    const k = pitchToKey.get(pitch);
    if (!k) return;
    k.classList.toggle("selected", on);
    k.classList.toggle("handL", on);
  }

  function showKeyCorrect(pitch) {
    const k = pitchToKey.get(pitch);
    if (!k) return;
    k.classList.remove("selected", "handL", "wrong");
    k.classList.add("correct");
  }

  function showKeyWrong(pitch) {
    const k = pitchToKey.get(pitch);
    if (!k) return;
    k.classList.remove("selected", "handL", "correct");
    k.classList.add("wrong");
  }

  function pitchLabel(pitch) {
    const pc = pcFromPitch(pitch);
    const oct = octFromPitch(pitch);
    const isAcc = [1, 3, 6, 8, 10].includes(pc);
    if (!isAcc) return `${PC_NAMES_SHARP[pc]}${oct}`;
    return `${PC_NAMES_SHARP[pc]}${oct} / ${PC_NAMES_FLAT[pc]}${oct}`;
  }

  function updateControlsEnabled() {
    replayBtn.disabled = !started || targetPitch == null;
    nextBtn.disabled = !started || !awaitingNext;
    submitBtn.disabled = !started || awaitingNext || pickedPitch == null || targetPitch == null;
  }

  function updateBeginButton() {
    beginBtn.textContent = started ? "Restart Game" : "Begin Game";
    beginBtn.classList.toggle("pulse", !started);
  }

  async function startNewQuestion({ autoplay = true } = {}) {
    if (!started) return;

    clearAllHighlights();
    pickedPitch = null;
    awaitingNext = false;
    updateControlsEnabled();

    targetPitch = pickRandomPitchAvoidRepeat();
    lastTargetPitch = targetPitch;

    renderScore();

    if (autoplay && targetPitch != null) {
      stopAllNotes(0.2);
      await playPitch(targetPitch, 1);
    }

    updateControlsEnabled();
  }

  async function replayTarget() {
    if (!started || targetPitch == null) return;
    stopAllNotes(0.2);
    await playPitch(targetPitch, 1);
  }

  function clearPick() {
    if (pickedPitch == null) return;
    setKeyPreselected(pickedPitch, false);
    pickedPitch = null;
    awaitingNext = false;
    updateControlsEnabled();
  }

  async function handleKeyClick(keyEl) {
    if (!started) return;

    const pitch = Number(keyEl.getAttribute("data-abs"));
    if (!Number.isFinite(pitch)) return;

    if (pickedPitch === pitch) {
      clearPick();
      return;
    }

    if (pickedPitch != null) setKeyPreselected(pickedPitch, false);
    pickedPitch = pitch;

    setKeyPreselected(pitch, true);
    updateControlsEnabled();

    await playPitch(pitch, 0.95);
  }

  function showPopup(title, message, { showDownload = false } = {}) {
    modalTitle.textContent = title;
    modalBody.textContent = message;
    modalDownload.classList.toggle("hidden", !showDownload);
    streakModal.classList.remove("hidden");
    modalClose.focus();
  }

  function hidePopup() { streakModal.classList.add("hidden"); }

  function considerStreakForLongestOnFail(prevStreak) {
    if (prevStreak > score.longestStored) {
      score.longestStored = prevStreak;
      showPopup(
        "New Longest Streak!",
        `New Longest Streak! That's ${prevStreak} correct in a row!`,
        { showDownload: true }
      );
    }
  }

  async function submitAnswer() {
    if (!started || targetPitch == null || pickedPitch == null) return;

    score.asked += 1;
    renderScore();

    const isCorrect = pickedPitch === targetPitch;

    clearAllHighlights();

    if (isCorrect) {
      score.correct += 1;
      score.streak += 1;
      renderScore();

      const noteName = pitchLabel(targetPitch);
      setResult(`Correct! ✅ That was the note <strong>${noteName}</strong>. Nice one!`);
      showKeyCorrect(pickedPitch);

      pickedPitch = null;
      updateControlsEnabled();

      awaitingNext = true;
      updateControlsEnabled();
      if (actionHint) actionHint.innerHTML = "Correct! Press <strong>Next</strong> (or <strong>Space</strong>) for the next note.";

      return;
    }

    const prevStreak = score.streak;
    score.streak = 0;
    considerStreakForLongestOnFail(prevStreak);

    const noteName = pitchLabel(targetPitch);
    setResult(`Incorrect ❌ The note played was <strong>${noteName}</strong>.`);

    showKeyWrong(pickedPitch);
    showKeyCorrect(targetPitch);

    pickedPitch = null;
    awaitingNext = true;
    renderScore();
    updateControlsEnabled();
    if (actionHint) actionHint.innerHTML = "Press <strong>Next</strong> (or <strong>Space</strong>) for the next note.";
  }

  function resetScoreAndRestart() {
    stopAllNotes();
    clearAllHighlights();

    score.asked = 0;
    score.correct = 0;
    score.streak = 0;
    score.longestStored = 0;

    pickedPitch = null;
    awaitingNext = false;
    targetPitch = null;
    lastTargetPitch = null;

    renderScore();
    updateControlsEnabled();
    setResult("");

    startNewQuestion({ autoplay: true });
  }

    async function goNext() {
    if (!started || !awaitingNext) return;
    setResult("");
    awaitingNext = false;
    updateControlsEnabled();
    await startNewQuestion({ autoplay: true });
  }

async function beginGame() {
    await resumeAudioIfNeeded();
    started = true;
    updateBeginButton();

    setResult("");
    score.asked = 0;
    score.correct = 0;
    score.streak = 0;
    score.longestStored = 0;
    renderScore();

    awaitingNext = false;
    await startNewQuestion({ autoplay: true });
  }

  function restartGame() {
    resetScoreAndRestart();
  }

// ---------- PNG downloads ----------

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  }

  function drawCardBase(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fbfbfc";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);

    ctx.fillStyle = "#111";
    ctx.fillRect(8, 8, w - 16, 74);
  }

  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = word;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
  }

  function getPlayerName() {
    const prev = localStorage.getItem("pm_player_name") || "";
    const name = window.prompt("Enter your name for the score card:", prev) ?? "";
    const trimmed = String(name).trim();
    if (trimmed) localStorage.setItem("pm_player_name", trimmed);
    return trimmed || "Player";
  }

  async function onDownloadScoreCard() {
    const name = getPlayerName();
    await downloadScoreCardPng(name);
  }

  async function onDownloadRecord() {
    const name = getPlayerName();
    const v = score.longestStored || displayLongest();
    await downloadRecordPng(v, name);
  }

  async function downloadScoreCardPng(playerName) {
    const w = 560;
    const h = 500;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawCardBase(ctx, w, h);

    ctx.fillStyle = "#fff";
    ctx.font = "900 30px Arial";
    ctx.fillText("Pitch Matching Test — Score Card", 28, 56);

    const bodyX = 28;
    const bodyY = 130;

    ctx.fillStyle = "#111";
    ctx.font = "900 22px Arial";
    ctx.fillText("Summary", bodyX, bodyY);

    ctx.font = "700 20px Arial";
    const lines = [
      `Name: ${playerName}`,
      `Game mode: ${gameModeLabel()}`,
      `Questions asked: ${score.asked}`,
      `Answers correct: ${score.correct}`,
      `Correct in a row: ${score.streak}`,
      `Longest correct streak: ${displayLongest()}`,
      `Percentage correct: ${scorePercent()}%`,
    ];

    let y = bodyY + 44;
    for (const ln of lines) {
      ctx.fillText(ln, bodyX, y);
      y += 34;
    }

    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.font = "700 16px Arial";
    ctx.fillText("Downloaded from the Pitch Matching Test 🎶", bodyX, h - 36);

    const blob = await canvasToPngBlob(canvas);
    if (blob) downloadBlob(blob, "pitch-matching-score-card.png");
  }

  async function downloadRecordPng(streakValue, playerName) {
    const w = 980;
    const h = 420;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawCardBase(ctx, w, h);

    ctx.fillStyle = "#fff";
    ctx.font = "900 30px Arial";
    ctx.fillText("Pitch Matching Test — Record", 28, 56);

    ctx.fillStyle = "#111";
    ctx.font = "900 28px Arial";
    ctx.fillText(`${streakValue} correct in a row!`, 28, 142);

    ctx.font = "700 22px Arial";
    ctx.fillStyle = "#111";
    const msg = `${playerName} just scored ${streakValue} correct answers in a row on the pitch matching test! 🎉🎶🥳`;
    drawWrappedText(ctx, msg, 28, 200, w - 56, 34);

    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.font = "700 16px Arial";
    ctx.fillText("Downloaded from the Pitch Matching Test 🎶", 28, h - 36);

    const blob = await canvasToPngBlob(canvas);
    if (blob) downloadBlob(blob, "pitch-matching-record.png");
  }

  // ---------- Keyboard SVG ----------

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs = {}, children = []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const c of children) n.appendChild(c);
    return n;
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex).replace("#", "").trim();
    const rgb = (m.length === 3)
      ? [m[0] + m[0], m[1] + m[1], m[2] + m[2]].map(x => parseInt(x, 16))
      : [m.slice(0, 2), m.slice(2, 4), m.slice(4, 6)].map(x => parseInt(x, 16));
    const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0.28));
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  }

  function darken(hex, amt) {
    const m = String(hex).replace("#", "").trim();
    const rgb = (m.length === 3)
      ? [m[0] + m[0], m[1] + m[1], m[2] + m[2]].map(x => parseInt(x, 16))
      : [m.slice(0, 2), m.slice(2, 4), m.slice(4, 6)].map(x => parseInt(x, 16));
    const to = (c) => Math.max(0, Math.min(255, Math.round(c)));
    const out = rgb.map(c => to(c * (1 - amt)));
    return `rgb(${out[0]},${out[1]},${out[2]})`;
  }

  function outerRoundedWhitePath(x, y, w, h, r, roundLeft) {
    const rr = Math.max(0, Math.min(r, Math.min(w / 2, h / 2)));
    if (roundLeft) {
      return [
        `M ${x + rr} ${y}`,
        `H ${x + w}`,
        `V ${y + h}`,
        `H ${x + rr}`,
        `A ${rr} ${rr} 0 0 1 ${x} ${y + h - rr}`,
        `V ${y + rr}`,
        `A ${rr} ${rr} 0 0 1 ${x + rr} ${y}`,
        `Z`
      ].join(" ");
    }
    return [
      `M ${x} ${y}`,
      `H ${x + w - rr}`,
      `A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr}`,
      `V ${y + h - rr}`,
      `A ${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}`,
      `H ${x}`,
      `V ${y}`,
      `Z`
    ].join(" ");
  }

  const WHITE_NOTES = ["C", "D", "E", "F", "G", "A", "B"];
  const WHITE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const BLACK_BY_WHITE_INDEX = {
    0: ["C#", "Db", 1],
    1: ["D#", "Eb", 3],
    3: ["F#", "Gb", 6],
    4: ["G#", "Ab", 8],
    5: ["A#", "Bb", 10],
  };

  function makeWhiteKey(x, y, w, h, label, pc, pitch, roundLeft, roundRight, octaveNum) {
    const shape = (roundLeft || roundRight)
      ? el("path", { d: outerRoundedWhitePath(x, y, w, h, WHITE_CORNER_R, roundLeft) })
      : el("rect", { x, y, width: w, height: h });

    const noteTextY = y + h - 16;
    const text = el("text", { x: x + w / 2, y: noteTextY, "text-anchor": "middle" });
    text.textContent = label;

    return el("g", {
      class: "key white",
      "data-pc": pc,
      "data-abs": pitch,
      "data-oct": octaveNum,
    }, [shape, text]);
  }

  function makeBlackKey(x, y, w, h, sharpName, flatName, pc, pitch, octaveNum) {
    const rect = el("rect", { x, y, width: w, height: h, rx: 4, ry: 4 });

    const text = el("text", { x: x + w / 2, y: y + Math.round(h * 0.46), "text-anchor": "middle" });
    const t1 = el("tspan", { x: x + w / 2, dy: "-6" }); t1.textContent = sharpName;
    const t2 = el("tspan", { x: x + w / 2, dy: "14" }); t2.textContent = flatName;
    text.appendChild(t1);
    text.appendChild(t2);

    return el("g", {
      class: "key black",
      "data-pc": pc,
      "data-abs": pitch,
      "data-oct": octaveNum,
    }, [rect, text]);
  }

  function buildKeyboardSvg(preset) {
    const { startOctave, octaves, endOnFinalC } = preset;

    const totalWhite = octaves * 7 + (endOnFinalC ? 1 : 0);
    const innerW = totalWhite * WHITE_W;
    const outerW = innerW + (BORDER_PX * 2);

    const s = el("svg", {
      id: "pianoSvg",
      width: outerW,
      height: OUTER_H,
      viewBox: `0 0 ${outerW} ${OUTER_H}`,
      role: "img",
      "aria-label": "Keyboard",
      preserveAspectRatio: "xMidYMid meet",
    });

    // Responsive sizing: shrink to fit container, but never upscale beyond natural width.
    s.style.width = "100%";
    s.style.maxWidth = `${outerW}px`;
    s.style.height = "auto";

    const style = el("style");
    style.textContent = `
      :root { --hlL:${highlightColor}; --hlTextL:#ffffff; --correct:${CORRECT_COLOR}; --wrong:${WRONG_COLOR}; }

      @keyframes keyPulse {
        0%   { filter: drop-shadow(0 0 0 rgba(0,0,0,0)); }
        45%  { filter: drop-shadow(0 0 9px rgba(0,0,0,0.0)) drop-shadow(0 0 10px rgba(77,163,255,0.45)); }
        100% { filter: drop-shadow(0 0 0 rgba(0,0,0,0)); }
      }

      .white rect, .white path { fill:#fff; stroke:#222; stroke-width:1; }
      .white text { font-family: Arial, Helvetica, sans-serif; font-size:14px; fill:#9a9a9a; pointer-events:none; user-select:none; }

      .black rect { fill: url(#blackGrad); stroke:#111; stroke-width:1; }
      .black text { font-family: Arial, Helvetica, sans-serif; font-size:12px; fill:#fff; pointer-events:none; user-select:none; opacity:0; }

      .key { cursor:pointer; }

      .white.selected.handL rect, .white.selected.handL path { fill: var(--hlL); animation:keyPulse 1.05s ease-in-out infinite; }
      .white.selected.handL text { fill: var(--hlTextL); font-weight:700; }
      .black.selected.handL rect { fill: url(#hlBlackGradL); animation:keyPulse 1.05s ease-in-out infinite; }
      .black.selected.handL text { opacity:1; }

      .white.correct rect, .white.correct path { fill: var(--correct); }
      .white.correct text { fill: rgba(255,255,255,0.95); font-weight:800; }
      .black.correct rect { fill: url(#hlBlackCorrect); }
      .black.correct text { opacity:1; }

      .white.wrong rect, .white.wrong path { fill: var(--wrong); }
      .white.wrong text { fill: rgba(255,255,255,0.95); font-weight:800; }
      .black.wrong rect { fill: url(#hlBlackWrong); }
      .black.wrong text { opacity:1; }
    `;
    s.appendChild(style);

    const defs = el("defs");

    const blackGrad = el("linearGradient", { id: "blackGrad", x1: "0", y1: "0", x2: "0", y2: "1" }, [
      el("stop", { offset: "0%", "stop-color": "#3a3a3a" }),
      el("stop", { offset: "100%", "stop-color": "#000000" }),
    ]);

    const hlBlackGradL = el("linearGradient", { id: "hlBlackGradL", x1: "0", y1: "0", x2: "0", y2: "1" }, [
      el("stop", { offset: "0%", "stop-color": highlightColor }),
      el("stop", { offset: "100%", "stop-color": darken(highlightColor, 0.45) }),
    ]);

    const hlBlackCorrect = el("linearGradient", { id: "hlBlackCorrect", x1: "0", y1: "0", x2: "0", y2: "1" }, [
      el("stop", { offset: "0%", "stop-color": CORRECT_COLOR }),
      el("stop", { offset: "100%", "stop-color": darken(CORRECT_COLOR, 0.35) }),
    ]);

    const hlBlackWrong = el("linearGradient", { id: "hlBlackWrong", x1: "0", y1: "0", x2: "0", y2: "1" }, [
      el("stop", { offset: "0%", "stop-color": WRONG_COLOR }),
      el("stop", { offset: "100%", "stop-color": darken(WRONG_COLOR, 0.35) }),
    ]);

    defs.appendChild(blackGrad);
    defs.appendChild(hlBlackGradL);
    defs.appendChild(hlBlackCorrect);
    defs.appendChild(hlBlackWrong);
    s.appendChild(defs);

    s.appendChild(el("rect", {
      x: BORDER_PX / 2,
      y: BORDER_PX / 2,
      width: outerW - BORDER_PX,
      height: OUTER_H - BORDER_PX,
      rx: RADIUS,
      ry: RADIUS,
      fill: "#ffffff",
      stroke: "#000000",
      "stroke-width": BORDER_PX,
    }));

    const gWhite = el("g", { id: "whiteKeys" });
    const gBlack = el("g", { id: "blackKeys" });
    s.appendChild(gWhite);
    s.appendChild(gBlack);

    const startX = BORDER_PX;
    const startY = BORDER_PX;

    for (let i = 0; i < totalWhite; i++) {
      const x = startX + (i * WHITE_W);
      const noteName = WHITE_NOTES[i % 7];
      const pc = WHITE_PC[noteName];
      const octIndex = Math.floor(i / 7);
      const octaveNum = startOctave + octIndex;
      const pitch = pitchFromPcOct(pc, octaveNum);

      const label = (noteName === "C" && octaveNum === 4) ? "C4" : noteName;
      const isFirst = (i === 0);
      const isLast = (i === totalWhite - 1);

      gWhite.appendChild(makeWhiteKey(x, startY, WHITE_W, WHITE_H, label, pc, pitch, isFirst, isLast, octaveNum));
    }

    for (let oct = 0; oct < octaves; oct++) {
      const baseWhite = oct * 7;
      const octaveNum = startOctave + oct;

      for (const [whiteI, info] of Object.entries(BLACK_BY_WHITE_INDEX)) {
        const wi = Number(whiteI);
        const [sharpName, flatName, pc] = info;

        const leftWhiteX = startX + ((baseWhite + wi) * WHITE_W);
        const x = leftWhiteX + WHITE_W - (BLACK_W / 2);

        const pitch = pitchFromPcOct(pc, octaveNum);
        gBlack.appendChild(makeBlackKey(x, startY, BLACK_W, BLACK_H, sharpName, flatName, pc, pitch, octaveNum));
      }
    }

    return s;
  }

  function initKeyboard() {
    const preset = KEYBOARD_PRESETS[keyboardRangeSel.value] || KEYBOARD_PRESETS["4oct-c2"];

    mount.innerHTML = "";
    pitchToKey.clear();

    svg = buildKeyboardSvg(preset);
    mount.appendChild(svg);

    const keys = [...svg.querySelectorAll(".key")];
    for (const g of keys) {
      const pc = Number(g.getAttribute("data-pc"));
      const oct = Number(g.getAttribute("data-oct"));
      const pitch = pitchFromPcOct(pc, oct);
      pitchToKey.set(pitch, g);
    }

    allPitches = [...pitchToKey.keys()].sort((a, b) => a - b);

    keys.forEach(g => {
      g.addEventListener("click", (e) => {
        e.preventDefault();
        handleKeyClick(g);
      });
    });

    applyHighlightColor(highlightColor);
  }

  function applyHighlightColor(hex) {
    highlightColor = hex;
    document.documentElement.style.setProperty("--pulseColor", highlightColor);
    document.documentElement.style.setProperty("--pulseRGBA", hexToRgba(highlightColor, 0.28));

    highlightColorInput.value = highlightColor;

    if (!svg) return;
    svg.style.setProperty("--hlL", highlightColor);

    const grad = svg.querySelector("#hlBlackGradL");
    if (grad) {
      const stops = grad.querySelectorAll("stop");
      if (stops[0]) stops[0].setAttribute("stop-color", highlightColor);
      if (stops[1]) stops[1].setAttribute("stop-color", darken(highlightColor, 0.45));
    }
  }

  // ---------- Events ----------

  function bind() {
    beginBtn.addEventListener("click", async () => {
      if (!started) await beginGame();
      else restartGame();
    });

    replayBtn.addEventListener("click", replayTarget);
    submitBtn.addEventListener("click", submitAnswer);
    nextBtn.addEventListener("click", goNext);
    downloadScoreBtn.addEventListener("click", onDownloadScoreCard);

    modalClose?.addEventListener("click", hidePopup);
    streakModal?.addEventListener("click", (e) => { if (e.target === streakModal) hidePopup(); });
    modalDownload?.addEventListener("click", onDownloadRecord);

    keyboardRangeSel.addEventListener("change", () => {
      initKeyboard();
      if (started) startNewQuestion({ autoplay: true });
    });

    highlightColorInput.addEventListener("change", () => applyHighlightColor(highlightColorInput.value));

    document.addEventListener("keydown", async (e) => {
      if (!started) return;

      if (e.code === "KeyR") {
        await replayTarget();
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        if (awaitingNext) await goNext();
        else await submitAnswer();
        return;
      }

      if (e.code === "Enter") {
        e.preventDefault();
        if (awaitingNext) await goNext();
        else await submitAnswer();
      }
    });
  }

  function init() {
    bind();
    initKeyboard();
    applyHighlightColor(highlightColorInput.value || PRESELECT_COLOR_DEFAULT);
    renderScore();
    updateBeginButton();
    updateControlsEnabled();
    if (actionHint) actionHint.innerHTML = "Tip: press <strong>R</strong> to replay, <strong>Space</strong>/<strong>Enter</strong> to submit.";
    setResult("Press <strong>Begin Game</strong> to start.");
  }

  init();
})();
