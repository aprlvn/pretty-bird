(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const title = document.getElementById('title');
  const message = document.getElementById('message');
  const scoreDisplay = document.getElementById('score-display');
  const startBtn = document.getElementById('start-btn');
  const scoreEl = document.getElementById('score');
  const muteBtn = document.getElementById('mute-btn');
  const musicVolumeSlider = document.getElementById('music-volume');
  const audioDebugEl = document.getElementById('audio-debug');

  const W = canvas.width;
  const H = canvas.height;

  const GRAVITY = 1500;
  const FLAP_VELOCITY = -420;
  const PIPE_WIDTH = 80;
  const GROUND_HEIGHT = 0;
  const BIRD_WIDTH = 50;
  const BIRD_HEIGHT = 40;
  const FLAP_FRAME_MS = 140;
  const POP_DURATION = 180;
  const POP_SCALE = 1.35;

  // Base difficulty, ramped up over time by score (see getDifficultyLevel).
  const DIFFICULTY_SCORE_STEP = 5;
  const BASE_PIPE_SPEED = 160;
  const MAX_PIPE_SPEED = 300;
  const SPEED_PER_LEVEL = 10;
  const BASE_PIPE_GAP = 160;
  const MIN_PIPE_GAP = 120;
  const GAP_PER_LEVEL = 4;
  const BASE_PIPE_INTERVAL = 1400;
  const MIN_PIPE_INTERVAL = 950;
  const INTERVAL_PER_LEVEL = 35;
  const BASE_MOVING_CHANCE = 0.35;
  const MAX_MOVING_CHANCE = 0.75;
  const CHANCE_PER_LEVEL = 0.04;
  const CHILL_TO_THRILL_SCORE = 10;

  const STEP_OFFSET_MIN = 35;
  const STEP_OFFSET_MAX = 80;
  const STEP_COUNT_MIN = 2;
  const STEP_COUNT_MAX = 5;
  const STEP_ZONE_START_X = 420;
  const STEP_ZONE_END_X = 150;

  const CLOUDS = [
    { x: 40, y: 70, scale: 1.0, speed: 9 },
    { x: 220, y: 42, scale: 0.7, speed: 6 },
    { x: 350, y: 115, scale: 1.3, speed: 13 },
    { x: 130, y: 160, scale: 0.55, speed: 4 },
  ];

  // Eye socket positions measured from each cat sprite (source pixel space),
  // used to paint over the sprite's fixed pupil with a pupil that tracks the bird.
  const CAT_DEFS = [
    { key: 'cat1', sclera: '#fdfcfb', eyeL: { x: 25, y: 49, r: 5.5 }, eyeR: { x: 55, y: 49, r: 5.5 } },
    { key: 'cat2', sclera: '#e9c76e', eyeL: { x: 25, y: 49, r: 6.5 }, eyeR: { x: 51, y: 48, r: 6 } },
    { key: 'cat3', sclera: '#e9e5e2', eyeL: { x: 27, y: 42, r: 4.5 }, eyeR: { x: 55, y: 41, r: 4 } },
    { key: 'cat4', sclera: '#ffffff', eyeL: { x: 29, y: 32, r: 3.5 }, eyeR: { x: 49, y: 32, r: 3.5 } },
  ];

  const AudioEngine = (() => {
    let ctx = null;
    let musicGain = null;
    let sfxGain = null;
    let schedulerId = null;
    let nextNoteTime = 0;
    let melodyIndex = 0;
    let muted = false;
    let intensity = 0; // 0 = chill start-of-run, 1 = fully thrilling

    // Chill: a soft, pleasant major arpeggio to open each run.
    // Thrill: a tenser minor riff the music sneaks toward as intensity rises,
    // so players don't hear the challenge ramp coming.
    const CHILL_MELODY = [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 880.0, 698.46];
    const THRILL_MELODY = [440.0, 659.25, 523.25, 659.25, 440.0, 698.46, 523.25, 587.33];
    const BASS_NOTE = 110.0;
    const MAX_MUSIC_GAIN = 0.6;

    let musicVolume = 0.27;
    const SFX_VOLUME = 0.35;

    let lastError = null;
    let lastAction = 'not started';

    function ensureContext() {
      try {
        if (!ctx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) {
            lastAction = 'no AudioContext support';
            return null;
          }
          ctx = new AudioCtx();
          lastAction = `created (state=${ctx.state})`;
          musicGain = ctx.createGain();
          musicGain.gain.value = muted ? 0 : musicVolume;
          musicGain.connect(ctx.destination);
          sfxGain = ctx.createGain();
          sfxGain.gain.value = muted ? 0 : SFX_VOLUME;
          sfxGain.connect(ctx.destination);

          // iOS/Safari only fully unlocks audio after a real sound plays inside
          // the gesture handler that created the context — a silent blip does it.
          const unlockBuffer = ctx.createBuffer(1, 1, 22050);
          const unlockSource = ctx.createBufferSource();
          unlockSource.buffer = unlockBuffer;
          unlockSource.connect(ctx.destination);
          unlockSource.start(0);
        }
        // Safari/iOS WebKit adds a state beyond the spec's suspended/running/
        // closed: "interrupted" (e.g. after a call, Siri, or another app
        // taking the audio session). resume() is what recovers from it too,
        // but a check for only "suspended" misses it and gets stuck forever.
        if (ctx.state !== 'running' && ctx.state !== 'closed') {
          lastAction = `resume() requested (was ${ctx.state})`;
          ctx.resume().then(
            () => {
              lastAction = `resume() resolved (state=${ctx.state})`;
              lastError = null;
            },
            (err) => {
              lastAction = 'resume() rejected';
              lastError = String(err);
            }
          );
        } else {
          lastAction = `ready (state=${ctx.state})`;
        }
        return ctx;
      } catch (err) {
        lastAction = 'threw exception';
        lastError = String(err);
        console.error('AudioEngine: failed to init/resume AudioContext', err);
        return ctx;
      }
    }

    // Human-readable snapshot for the on-screen debug readout — lets us see
    // what's actually happening on a phone without a devtools connection.
    function getDebugInfo() {
      if (!ctx) return `no context yet (${lastAction})`;
      let info = `state=${ctx.state} | ${lastAction}`;
      if (lastError) info += ` | error: ${lastError}`;
      return info;
    }

    // Mobile browsers often suspend (or, on WebKit, "interrupt") the
    // AudioContext when the tab/app is backgrounded; resume it once the
    // player comes back.
    function resumeIfNeeded() {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    }

    // True once the AudioContext exists and is actually running — iOS/Safari
    // create it in a "suspended" state until a real gesture resumes it.
    function isUnlocked() {
      return !!ctx && ctx.state === 'running';
    }

    function playTone({ freqStart, freqEnd, duration, type = 'sine', gainStart = 0.3, delay = 0 }) {
      if (!ensureContext()) return;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freqStart, t0);
      if (freqEnd !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
      }
      gain.gain.setValueAtTime(gainStart, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(sfxGain);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    function playFlap() {
      playTone({ freqStart: 520, freqEnd: 880, duration: 0.12, type: 'square', gainStart: 0.22 });
    }

    // Two different game-over stingers, picked at random for variety.
    function playGameOverSwoop() {
      playTone({ freqStart: 420, freqEnd: 120, duration: 0.5, type: 'sawtooth', gainStart: 0.28 });
      playTone({ freqStart: 200, freqEnd: 55, duration: 0.4, type: 'square', gainStart: 0.18, delay: 0.15 });
    }

    function playGameOverTumble() {
      const notes = [660, 550, 440, 330];
      notes.forEach((freq, i) => {
        playTone({ freqStart: freq, freqEnd: freq * 0.85, duration: 0.14, type: 'square', gainStart: 0.22, delay: i * 0.09 });
      });
      playTone({ freqStart: 150, freqEnd: 45, duration: 0.35, type: 'sawtooth', gainStart: 0.2, delay: notes.length * 0.09 });
    }

    function playGameOver() {
      (Math.random() < 0.5 ? playGameOverSwoop : playGameOverTumble)();
    }

    function scheduleNote(freq, time, type, duration) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.22, time + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration * 0.85);
      osc.connect(gain);
      gain.connect(musicGain);
      osc.start(time);
      osc.stop(time + duration);
    }

    function scheduleBass(time, gainAmount, duration) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(BASS_NOTE, time);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(gainAmount, time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration * 1.7);
      osc.connect(gain);
      gain.connect(musicGain);
      osc.start(time);
      osc.stop(time + duration * 1.8);
    }

    function musicTick() {
      // Backgrounded tabs throttle setInterval (heavily on mobile); without this,
      // returning to the game would try to schedule a big backlog of catch-up notes.
      if (nextNoteTime < ctx.currentTime) {
        nextNoteTime = ctx.currentTime;
      }
      while (nextNoteTime < ctx.currentTime + 0.2) {
        const thrilling = intensity >= 0.5;
        const melody = thrilling ? THRILL_MELODY : CHILL_MELODY;
        const leadType = thrilling ? 'square' : 'triangle';
        const noteDuration = 0.34 - intensity * 0.13; // 0.34 (chill) -> 0.21 (thrilling)
        const bassGain = intensity * 0.3; // fades in as the run gets harder

        scheduleNote(melody[melodyIndex % melody.length], nextNoteTime, leadType, noteDuration);
        if (bassGain > 0.015 && melodyIndex % 2 === 0) {
          scheduleBass(nextNoteTime, bassGain, noteDuration);
        }
        melodyIndex++;
        nextNoteTime += noteDuration;
      }
    }

    function startMusic() {
      if (!ensureContext() || schedulerId) return;
      const now = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(muted ? 0 : musicVolume, now);
      nextNoteTime = now + 0.1;
      melodyIndex = 0;
      musicTick();
      schedulerId = setInterval(musicTick, 100);
    }

    // Stops scheduling new notes and fades the tail out quickly so it doesn't click.
    function stopMusic() {
      if (schedulerId) {
        clearInterval(schedulerId);
        schedulerId = null;
      }
      if (ctx && musicGain) {
        const now = ctx.currentTime;
        musicGain.gain.cancelScheduledValues(now);
        musicGain.gain.setValueAtTime(musicGain.gain.value, now);
        musicGain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
      }
    }

    function setIntensity(value) {
      intensity = Math.max(0, Math.min(1, value));
    }

    function setMusicVolumePercent(percent) {
      musicVolume = (Math.max(0, Math.min(100, percent)) / 100) * MAX_MUSIC_GAIN;
      if (musicGain && !muted && !schedulerId) {
        // Not currently playing (or mid fade-out) — just stage the level for next start.
        musicGain.gain.value = musicVolume;
      } else if (musicGain && !muted) {
        musicGain.gain.setValueAtTime(musicVolume, ctx.currentTime);
      }
    }

    function setMuted(value) {
      muted = value;
      if (musicGain) musicGain.gain.value = muted ? 0 : musicVolume;
      if (sfxGain) sfxGain.gain.value = muted ? 0 : SFX_VOLUME;
    }

    function toggleMuted() {
      setMuted(!muted);
      return muted;
    }

    return {
      playFlap,
      playGameOver,
      startMusic,
      stopMusic,
      setIntensity,
      setMusicVolumePercent,
      toggleMuted,
      resumeIfNeeded,
      isMuted: () => muted,
      // Exposed so the very first tap anywhere on the page can create/resume
      // the AudioContext immediately, before any game-ready gating applies.
      unlock: ensureContext,
      isUnlocked,
      getDebugInfo,
    };
  })();

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${src}`));
      img.src = src;
    });
  }

  const assets = {};
  let ready = false;

  Promise.all([
    loadImage('images/background.png').then((img) => (assets.background = img)),
    loadImage('images/bird1up.png').then((img) => (assets.birdUp = img)),
    loadImage('images/bird1down.png').then((img) => (assets.birdDown = img)),
    ...CAT_DEFS.map((def) => loadImage(`images/${def.key}.png`).then((img) => (def.img = img))),
  ]).then(() => {
    assets.cats = CAT_DEFS;
    ready = true;
    message.textContent = 'Tap, click, or press Space to flap';
    resetGame();
    requestAnimationFrame(loop);
  });

  let bird, pipes, score, best, lastTime, pipeTimer, state, popStart;

  best = Number(localStorage.getItem('prettyBirdBest') || 0);

  function resetGame() {
    bird = {
      x: W * 0.28,
      y: H / 2,
      vy: 0,
      radius: 15,
      rotation: 0,
    };
    pipes = [];
    score = 0;
    pipeTimer = 0;
    state = 'ready';
    popStart = -Infinity;
    scoreEl.textContent = '0';
    AudioEngine.setIntensity(0);
  }

  function flap() {
    if (!ready) return;
    if (state === 'ready') {
      state = 'playing';
      overlay.classList.add('hidden');
      AudioEngine.startMusic();
    }
    if (state === 'playing') {
      bird.vy = FLAP_VELOCITY;
      popStart = performance.now();
      AudioEngine.playFlap();
    } else if (state === 'over') {
      resetGame();
    }
  }

  function pickTwoDistinctCats() {
    const firstIndex = Math.floor(Math.random() * assets.cats.length);
    let secondIndex = Math.floor(Math.random() * (assets.cats.length - 1));
    if (secondIndex >= firstIndex) secondIndex++;
    return [assets.cats[firstIndex], assets.cats[secondIndex]];
  }

  // Difficulty ramps up steadily as the score climbs, rather than staying flat.
  function getDifficultyLevel() {
    return Math.floor(score / DIFFICULTY_SCORE_STEP);
  }

  function currentPipeSpeed() {
    return Math.min(MAX_PIPE_SPEED, BASE_PIPE_SPEED + getDifficultyLevel() * SPEED_PER_LEVEL);
  }

  function currentPipeGap() {
    return Math.max(MIN_PIPE_GAP, BASE_PIPE_GAP - getDifficultyLevel() * GAP_PER_LEVEL);
  }

  function currentPipeInterval() {
    return Math.max(MIN_PIPE_INTERVAL, BASE_PIPE_INTERVAL - getDifficultyLevel() * INTERVAL_PER_LEVEL);
  }

  function currentMovingChance() {
    return Math.min(MAX_MOVING_CHANCE, BASE_MOVING_CHANCE + getDifficultyLevel() * CHANCE_PER_LEVEL);
  }

  function buildSteps() {
    const stepCount = STEP_COUNT_MIN + Math.floor(Math.random() * (STEP_COUNT_MAX - STEP_COUNT_MIN + 1));
    const zoneRange = STEP_ZONE_START_X - STEP_ZONE_END_X;
    const segmentWidth = zoneRange / stepCount;
    const steps = [];
    for (let i = 0; i < stepCount; i++) {
      const segmentEnd = STEP_ZONE_START_X - (i + 1) * segmentWidth;
      const x = segmentEnd + Math.random() * segmentWidth;
      const magnitude = STEP_OFFSET_MIN + Math.random() * (STEP_OFFSET_MAX - STEP_OFFSET_MIN);
      steps.push({ x, offset: Math.random() < 0.5 ? magnitude : -magnitude });
    }
    return steps;
  }

  function spawnPipe() {
    const margin = 60;
    const gap = currentPipeGap();
    const availableHeight = H - GROUND_HEIGHT - gap - margin * 2;
    const topHeight = margin + Math.random() * availableHeight;
    const [topCat, bottomCat] = pickTwoDistinctCats();
    const moving = Math.random() < currentMovingChance();
    pipes.push({
      x: W + PIPE_WIDTH,
      topHeight,
      bottomY: topHeight + gap,
      passed: false,
      topCat,
      bottomCat,
      gap,
      moving,
      minTop: margin,
      maxTop: margin + availableHeight,
      // A handful of last-second jumps, not a continuous bob — catches the player off guard.
      steps: moving ? buildSteps() : [],
      nextStepIndex: 0,
    });
  }

  function rectCircleCollide(cx, cy, r, rx, ry, rw, rh) {
    const closestX = Math.max(rx, Math.min(cx, rx + rw));
    const closestY = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - closestX;
    const dy = cy - closestY;
    return dx * dx + dy * dy < r * r;
  }

  function update(dt) {
    if (state !== 'playing') return;

    bird.vy += GRAVITY * dt;
    bird.y += bird.vy * dt;
    bird.rotation = Math.max(-0.5, Math.min(1.2, bird.vy / 600));

    pipeTimer += dt * 1000;
    if (pipeTimer >= currentPipeInterval()) {
      pipeTimer = 0;
      spawnPipe();
    }

    const pipeSpeed = currentPipeSpeed();
    for (const pipe of pipes) {
      pipe.x -= pipeSpeed * dt;

      while (pipe.nextStepIndex < pipe.steps.length && pipe.x <= pipe.steps[pipe.nextStepIndex].x) {
        const step = pipe.steps[pipe.nextStepIndex];
        pipe.topHeight = Math.min(pipe.maxTop, Math.max(pipe.minTop, pipe.topHeight + step.offset));
        pipe.bottomY = pipe.topHeight + pipe.gap;
        pipe.nextStepIndex++;
      }

      if (!pipe.passed && pipe.x + PIPE_WIDTH < bird.x - bird.radius) {
        pipe.passed = true;
        score++;
        scoreEl.textContent = String(score);
        AudioEngine.setIntensity(score / CHILL_TO_THRILL_SCORE);
      }

      if (
        rectCircleCollide(bird.x, bird.y, bird.radius, pipe.x, 0, PIPE_WIDTH, pipe.topHeight) ||
        rectCircleCollide(bird.x, bird.y, bird.radius, pipe.x, pipe.bottomY, PIPE_WIDTH, H - GROUND_HEIGHT - pipe.bottomY)
      ) {
        gameOver();
      }
    }

    while (pipes.length && pipes[0].x + PIPE_WIDTH < 0) {
      pipes.shift();
    }

    if (bird.y + bird.radius >= H - GROUND_HEIGHT) {
      bird.y = H - GROUND_HEIGHT - bird.radius;
      gameOver();
    }
    if (bird.y - bird.radius <= 0) {
      bird.y = bird.radius;
      bird.vy = 0;
    }
  }

  function gameOver() {
    if (state !== 'playing') return;
    state = 'over';
    AudioEngine.stopMusic();
    AudioEngine.playGameOver();
    if (score > best) {
      best = score;
      localStorage.setItem('prettyBirdBest', String(best));
    }
    title.textContent = 'Game Over';
    message.textContent = 'Tap, click, or press Space to try again';
    scoreDisplay.textContent = `Score: ${score}   Best: ${best}`;
    overlay.classList.remove('hidden');
  }

  function drawBackground() {
    if (assets.background) {
      ctx.drawImage(assets.background, 0, 0, W, H);
    }
  }

  function updateClouds(dt) {
    for (const cloud of CLOUDS) {
      cloud.x -= cloud.speed * dt;
      const wrapMargin = 80 * cloud.scale;
      if (cloud.x < -wrapMargin) {
        cloud.x = W + wrapMargin;
      }
    }
  }

  function drawCloudShape(x, y, scale) {
    ctx.beginPath();
    ctx.ellipse(x, y, 30 * scale, 16 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 22 * scale, y + 6 * scale, 22 * scale, 14 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 22 * scale, y + 6 * scale, 22 * scale, 14 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawClouds() {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#ffffff';
    for (const cloud of CLOUDS) {
      drawCloudShape(cloud.x, cloud.y, cloud.scale);
    }
    ctx.restore();
  }

  function drawEye(cat, eye, eyeX, eyeY) {
    // Cover the sprite's fixed painted pupil with the sclera color, then draw
    // a fresh pupil offset toward the bird so the cat appears to watch it.
    ctx.beginPath();
    ctx.fillStyle = cat.sclera;
    ctx.arc(eyeX, eyeY, eye.r * 0.62, 0, Math.PI * 2);
    ctx.fill();

    const dx = bird.x - eyeX;
    const dy = bird.y - eyeY;
    const dist = Math.hypot(dx, dy) || 1;
    const pupilRadius = Math.max(1.3, eye.r * 0.42);
    const travel = Math.max(eye.r - pupilRadius - 0.6, 0.6);
    const offX = (dx / dist) * travel;
    const offY = (dy / dist) * travel;

    ctx.beginPath();
    ctx.fillStyle = '#201208';
    ctx.arc(eyeX + offX, eyeY + offY, pupilRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipe(pipe) {
    // Bottom obstacle: cat stands upright, face near the gap, feet flush with the ground.
    const bottomHeight = H - GROUND_HEIGHT - pipe.bottomY;
    if (pipe.bottomCat) {
      const cat = pipe.bottomCat;
      const img = cat.img;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pipe.x, pipe.bottomY, PIPE_WIDTH, bottomHeight);
      ctx.clip();
      ctx.drawImage(img, pipe.x, pipe.bottomY, PIPE_WIDTH, img.height);
      drawEye(cat, cat.eyeL, pipe.x + cat.eyeL.x, pipe.bottomY + cat.eyeL.y);
      drawEye(cat, cat.eyeR, pipe.x + cat.eyeR.x, pipe.bottomY + cat.eyeR.y);
      ctx.restore();
    }

    // Top obstacle: a different cat hangs upside-down, face near the gap.
    if (pipe.topCat) {
      const cat = pipe.topCat;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pipe.x, 0, PIPE_WIDTH, pipe.topHeight);
      ctx.clip();
      ctx.translate(pipe.x, pipe.topHeight);
      ctx.scale(1, -1);
      ctx.drawImage(cat.img, 0, 0, PIPE_WIDTH, cat.img.height);
      ctx.restore();

      // Eyes are drawn after un-flipping so the pupils themselves stay upright.
      ctx.save();
      ctx.beginPath();
      ctx.rect(pipe.x, 0, PIPE_WIDTH, pipe.topHeight);
      ctx.clip();
      drawEye(cat, cat.eyeL, pipe.x + cat.eyeL.x, pipe.topHeight - cat.eyeL.y);
      drawEye(cat, cat.eyeR, pipe.x + cat.eyeR.x, pipe.topHeight - cat.eyeR.y);
      ctx.restore();
    }
  }

  function drawBird() {
    const frame = Math.floor(performance.now() / FLAP_FRAME_MS) % 2 === 0 ? assets.birdUp : assets.birdDown;
    if (!frame) return;

    const popElapsed = performance.now() - popStart;
    let scale = 1;
    if (popElapsed >= 0 && popElapsed < POP_DURATION) {
      const t = popElapsed / POP_DURATION;
      const decay = (1 - t) * (1 - t);
      scale = 1 + (POP_SCALE - 1) * decay;
    }

    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(frame, -BIRD_WIDTH / 2, -BIRD_HEIGHT / 2, BIRD_WIDTH, BIRD_HEIGHT);
    ctx.restore();
  }

  function draw() {
    drawBackground();
    drawClouds();
    for (const pipe of pipes) drawPipe(pipe);
    drawBird();
  }

  function loop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const dt = Math.min((timestamp - lastTime) / 1000, 1 / 30);
    lastTime = timestamp;

    updateClouds(dt);
    update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  function handleInput(e) {
    if (e.type === 'keydown' && e.code !== 'Space') return;
    e.preventDefault();
    flap();
  }

  window.addEventListener('keydown', handleInput);
  canvas.addEventListener('mousedown', flap);
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    flap();
  }, { passive: false });
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    flap();
  });
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const muted = AudioEngine.toggleMuted();
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });
  AudioEngine.setMusicVolumePercent(Number(musicVolumeSlider.value));
  musicVolumeSlider.addEventListener('input', (e) => {
    AudioEngine.setMusicVolumePercent(Number(e.target.value));
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) AudioEngine.resumeIfNeeded();
  });

  // Temporary on-screen readout of the AudioContext's real status — lets us
  // see what's happening on a phone that isn't hooked up to devtools.
  setInterval(() => {
    audioDebugEl.textContent = `Audio: ${AudioEngine.getDebugInfo()}`;
  }, 300);

  // iOS/Safari only unlocks Web Audio inside a genuine user gesture, and the
  // very first tap can arrive before assets finish loading (when flap() is
  // still a no-op). This listens for that literal first tap/click/key press
  // anywhere on the page — independent of game state — creates and resumes
  // the AudioContext right then, and keeps retrying on each gesture until
  // the context reports "running" (some iOS versions resolve resume()
  // asynchronously, so one tap isn't always guaranteed to finish the job).
  const UNLOCK_EVENTS = ['touchstart', 'touchend', 'pointerdown', 'mousedown', 'click', 'keydown'];
  function unlockAudioOnGesture() {
    AudioEngine.unlock();
    if (AudioEngine.isUnlocked()) {
      UNLOCK_EVENTS.forEach((type) => document.removeEventListener(type, unlockAudioOnGesture));
    }
  }
  UNLOCK_EVENTS.forEach((type) => document.addEventListener(type, unlockAudioOnGesture, { passive: true }));

  title.textContent = 'Pretty Bird';
  message.textContent = 'Loading...';
  scoreDisplay.textContent = best ? `Best: ${best}` : '';
})();
