(function () {
  const WORD_LENGTH = 5;
  const MAX_GUESSES = 6;

  const KEYBOARD_ROWS = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACK"],
  ];

  const boardEl = document.getElementById("board");
  const keyboardEl = document.getElementById("keyboard");
  const toastContainer = document.getElementById("toast-container");
  const helpBtn = document.getElementById("help-btn");
  const helpModal = document.getElementById("help-modal");
  const closeHelp = document.getElementById("close-help");
  const newGameBtn = document.getElementById("new-game-btn");
  const soundBtn = document.getElementById("sound-btn");
  const endModal = document.getElementById("end-modal");
  const closeEnd = document.getElementById("close-end");
  const endTitle = document.getElementById("end-title");
  const endMessage = document.getElementById("end-message");
  const playAgainBtn = document.getElementById("play-again-btn");
  const timerEl = document.getElementById("timer");
  const hintBtn = document.getElementById("hint-btn");
  const giveupBtn = document.getElementById("giveup-btn");
  const hintBox = document.getElementById("hint-box");
  const hintText = document.getElementById("hint-text");
  const closeHintBtn = document.getElementById("close-hint");
  const giveupModal = document.getElementById("giveup-modal");
  const closeGiveupBtn = document.getElementById("close-giveup");
  const confirmGiveupBtn = document.getElementById("confirm-giveup-btn");
  const cancelGiveupBtn = document.getElementById("cancel-giveup-btn");
  const endDefinitionBox = document.getElementById("end-definition");
  const definitionWordEl = document.getElementById("definition-word");
  const definitionTextEl = document.getElementById("definition-text");
  const definitionExampleEl = document.getElementById("definition-example");
  const definitionRelatedEl = document.getElementById("definition-related");

  const validWords = new Set(WORDS);

  // --- Dictionary lookups (for hints & the educational word recap) ---
  // Primary source: Wiktionary's REST API (Wikimedia infrastructure, CORS-enabled).
  // Fallback source: Datamuse, used when a word has no Wiktionary entry.
  const definitionCache = new Map();
  const relatedCache = new Map();

  function stripHtml(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<sup[\s\S]*?<\/sup>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchDefinition(word) {
    const key = word.toUpperCase();
    if (definitionCache.has(key)) return definitionCache.get(key);
    try {
      const res = await fetchWithTimeout(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(
          word.toLowerCase()
        )}`,
        4000
      );
      if (!res.ok) throw new Error("not found");
      const data = await res.json();
      const entries = data.en || [];

      // Wiktionary groups senses by etymology/part-of-speech, not by how
      // common they are, so the very first entry can be an obscure or
      // archaic sense (e.g. "robot" once meant serf labour). The entry with
      // the most catalogued senses is a decent proxy for "the primary,
      // well-documented meaning" of the word.
      let bestEntryDefs = [];
      let bestEntryPos = "";
      for (const entry of entries) {
        const defs = (entry.definitions || [])
          .map((defObj) => ({
            text: stripHtml(defObj.definition || ""),
            example:
              defObj.examples && defObj.examples[0]
                ? stripHtml(defObj.examples[0])
                : "",
          }))
          .filter((d) => d.text);
        if (defs.length > bestEntryDefs.length) {
          bestEntryDefs = defs;
          bestEntryPos = (entry.partOfSpeech || "").toLowerCase();
        }
      }

      // Within that entry, a sense with a citation example is more likely
      // to be the headline meaning than one without.
      const best =
        bestEntryDefs.find((d) => d.example) || bestEntryDefs[0];
      if (!best) throw new Error("no definition");
      const result = {
        partOfSpeech: bestEntryPos,
        definition: best.text,
        example: best.example,
      };
      definitionCache.set(key, result);
      return result;
    } catch (e) {
      definitionCache.set(key, null);
      return null;
    }
  }

  async function fetchRelatedWords(word) {
    const key = word.toUpperCase();
    if (relatedCache.has(key)) return relatedCache.get(key);
    try {
      const res = await fetchWithTimeout(
        `https://api.datamuse.com/words?ml=${encodeURIComponent(
          word.toLowerCase()
        )}&max=6`,
        4000
      );
      if (!res.ok) throw new Error("request failed");
      const data = await res.json();
      const words = data
        .map((d) => d.word)
        .filter((w) => w.toLowerCase() !== word.toLowerCase())
        .slice(0, 5);
      relatedCache.set(key, words);
      return words;
    } catch (e) {
      relatedCache.set(key, []);
      return [];
    }
  }

  function maskWord(text, word) {
    const re = new RegExp(word, "gi");
    return text.replace(re, "•".repeat(word.length));
  }

  // --- Timer ---
  let timerInterval = null;
  let startTime = null;
  let elapsedSeconds = 0;

  function formatTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  function tickTimer() {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = formatTime(elapsedSeconds);
  }

  function startTimer() {
    stopTimer();
    startTime = Date.now();
    elapsedSeconds = 0;
    timerEl.textContent = "00:00";
    timerInterval = setInterval(tickTimer, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // --- Sound ---
  let soundOn = localStorage.getItem("wordleLandSound") !== "off";
  let audioCtx = null;

  function getAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playTone(freq, duration, type, volume, delay) {
    if (!soundOn) return;
    const ctx = getAudioContext();
    const start = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume || 0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playKeySound() {
    playTone(480, 0.05, "sine", 0.12);
  }

  function playBackspaceSound() {
    playTone(320, 0.05, "sine", 0.1);
  }

  function playInvalidSound() {
    playTone(180, 0.16, "sawtooth", 0.15);
    playTone(140, 0.2, "sawtooth", 0.12, 0.09);
  }

  function playWinSound() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
      playTone(freq, 0.28, "triangle", 0.18, i * 0.12)
    );
  }

  function playLoseSound() {
    [392, 349.23, 293.66].forEach((freq, i) =>
      playTone(freq, 0.32, "sine", 0.14, i * 0.16)
    );
  }

  function updateSoundBtn() {
    soundBtn.textContent = soundOn ? "🔊" : "🔇";
  }

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("wordleLandSound", soundOn ? "on" : "off");
    updateSoundBtn();
    if (soundOn) playKeySound();
  });

  updateSoundBtn();

  // --- Confetti ---
  const CONFETTI_COLORS = ["#e91e8c", "#ff6fb0", "#ffc94d", "#ffd6e8", "#ff4f9a"];

  function launchConfetti() {
    const count = 60;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti";
      const size = 6 + Math.random() * 6;
      piece.style.left = Math.random() * 100 + "vw";
      piece.style.width = size + "px";
      piece.style.height = size * 1.6 + "px";
      piece.style.background =
        CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      const duration = 2.2 + Math.random() * 1.8;
      const delay = Math.random() * 0.3;
      piece.style.animationDuration = duration + "s";
      piece.style.animationDelay = delay + "s";
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), (duration + delay) * 1000 + 200);
    }
  }

  let secret = "";
  let currentRow = 0;
  let currentGuess = "";
  let gameOver = false;
  let hintUsed = false;
  let rowsEls = [];
  let keyEls = {};

  function pickSecret() {
    return ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  }

  function buildBoard() {
    boardEl.innerHTML = "";
    rowsEls = [];
    for (let r = 0; r < MAX_GUESSES; r++) {
      const row = document.createElement("div");
      row.className = "board-row";
      const tiles = [];
      for (let c = 0; c < WORD_LENGTH; c++) {
        const tile = document.createElement("div");
        tile.className = "tile";
        row.appendChild(tile);
        tiles.push(tile);
      }
      boardEl.appendChild(row);
      rowsEls.push(tiles);
    }
  }

  function buildKeyboard() {
    keyboardEl.innerHTML = "";
    keyEls = {};
    KEYBOARD_ROWS.forEach((rowKeys) => {
      const row = document.createElement("div");
      row.className = "keyboard-row";
      rowKeys.forEach((k) => {
        const btn = document.createElement("button");
        btn.className = "key";
        if (k === "ENTER" || k === "BACK") btn.classList.add("wide");
        btn.textContent = k === "BACK" ? "⌫" : k === "ENTER" ? "Enter" : k;
        btn.dataset.key = k;
        btn.addEventListener("click", () => handleKey(k));
        row.appendChild(btn);
        if (k !== "ENTER" && k !== "BACK") keyEls[k] = btn;
      });
      keyboardEl.appendChild(row);
    });
  }

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 1600);
  }

  function shakeRow() {
    const row = boardEl.children[currentRow];
    row.classList.add("shake");
    setTimeout(() => row.classList.remove("shake"), 500);
  }

  function updateTiles() {
    const tiles = rowsEls[currentRow];
    for (let i = 0; i < WORD_LENGTH; i++) {
      const letter = currentGuess[i];
      tiles[i].textContent = letter || "";
      tiles[i].classList.toggle("filled", !!letter);
    }
  }

  function evaluateGuess(guess) {
    const result = new Array(WORD_LENGTH).fill("absent");
    const secretLetters = secret.split("");
    const used = new Array(WORD_LENGTH).fill(false);

    for (let i = 0; i < WORD_LENGTH; i++) {
      if (guess[i] === secretLetters[i]) {
        result[i] = "correct";
        used[i] = true;
      }
    }

    for (let i = 0; i < WORD_LENGTH; i++) {
      if (result[i] === "correct") continue;
      const idx = secretLetters.findIndex(
        (ch, j) => ch === guess[i] && !used[j]
      );
      if (idx !== -1) {
        result[i] = "present";
        used[idx] = true;
      }
    }

    return result;
  }

  const KEY_PRIORITY = { absent: 0, present: 1, correct: 2 };

  function updateKeyboardColors(guess, result) {
    for (let i = 0; i < WORD_LENGTH; i++) {
      const letter = guess[i];
      const keyEl = keyEls[letter];
      if (!keyEl) continue;
      const current = keyEl.dataset.state || "";
      const currentRank = KEY_PRIORITY[current] ?? -1;
      const newRank = KEY_PRIORITY[result[i]];
      if (newRank > currentRank) {
        keyEl.classList.remove("correct", "present", "absent");
        keyEl.classList.add(result[i]);
        keyEl.dataset.state = result[i];
      }
    }
  }

  function revealRow(guess, result, onDone) {
    const tiles = rowsEls[currentRow];
    result.forEach((state, i) => {
      setTimeout(() => {
        tiles[i].classList.add("flip");
        setTimeout(() => {
          tiles[i].classList.add(state);
        }, 250);
        if (i === WORD_LENGTH - 1) {
          setTimeout(onDone, 300);
        }
      }, i * 250);
    });
  }

  function revealGiveUpRow(onDone) {
    const tiles = rowsEls[currentRow];
    const letters = secret.split("");
    letters.forEach((letter, i) => {
      tiles[i].textContent = letter;
      tiles[i].classList.add("filled");
      setTimeout(() => {
        tiles[i].classList.add("flip");
        setTimeout(() => {
          tiles[i].classList.add("revealed");
        }, 250);
        if (i === WORD_LENGTH - 1) {
          setTimeout(onDone, 300);
        }
      }, i * 250);
    });
  }

  async function showEndDefinition(word) {
    endDefinitionBox.classList.remove("hidden");
    definitionWordEl.textContent = word;
    definitionTextEl.textContent = "Looking up something interesting…";
    definitionExampleEl.classList.add("hidden");
    definitionRelatedEl.classList.add("hidden");

    const [info, related] = await Promise.all([
      fetchDefinition(word),
      fetchRelatedWords(word),
    ]);

    if (info && info.definition) {
      const pos = info.partOfSpeech ? `(${info.partOfSpeech}) ` : "";
      definitionTextEl.textContent = pos + info.definition;
      if (info.example) {
        definitionExampleEl.textContent = `“${info.example}”`;
        definitionExampleEl.classList.remove("hidden");
      }
    } else if (related.length) {
      definitionTextEl.textContent = `Here are some words related to ${word.toLowerCase()}:`;
    } else {
      endDefinitionBox.classList.add("hidden");
      return;
    }

    if (related.length) {
      definitionRelatedEl.innerHTML =
        "<strong>Related words:</strong> " + related.join(", ");
      definitionRelatedEl.classList.remove("hidden");
    }
  }

  function lockRoundControls() {
    hintBtn.disabled = true;
    giveupBtn.disabled = true;
  }

  function endGame(won) {
    gameOver = true;
    stopTimer();
    lockRoundControls();
    hideHintBox();
    const finalTime = formatTime(elapsedSeconds);
    setTimeout(() => {
      if (won) {
        rowsEls[currentRow].forEach((tile, i) => {
          setTimeout(() => tile.classList.add("win-bounce"), i * 80);
        });
        playWinSound();
        launchConfetti();
        const guesses = currentRow + 1;
        endTitle.textContent = "You Win! 🌸";
        endMessage.textContent = `You guessed the word in ${guesses} ${
          guesses === 1 ? "try" : "tries"
        } and ${finalTime}!`;
      } else {
        playLoseSound();
        endTitle.textContent = "So Close!";
        endMessage.textContent = `The word was ${secret}. Time: ${finalTime}. Better luck next time!`;
      }
      endModal.classList.remove("hidden");
      showEndDefinition(secret);
    }, won ? 600 : 300);
  }

  function giveUp() {
    if (gameOver) return;
    giveupModal.classList.add("hidden");
    gameOver = true;
    stopTimer();
    lockRoundControls();
    hideHintBox();
    const finalTime = formatTime(elapsedSeconds);
    playLoseSound();
    revealGiveUpRow(() => {
      endTitle.textContent = "Gave Up";
      endMessage.textContent = `The word was ${secret}. Time: ${finalTime}. Here's something to learn from it!`;
      endModal.classList.remove("hidden");
      showEndDefinition(secret);
    });
  }

  // --- Hint ---
  function showHintBox(text) {
    hintText.textContent = text;
    hintBox.classList.remove("hidden");
  }

  function hideHintBox() {
    hintBox.classList.add("hidden");
  }

  async function handleHint() {
    if (gameOver || hintUsed) return;
    hintUsed = true;
    hintBtn.disabled = true;
    showHintBox("Thinking of a clue…");

    const info = await fetchDefinition(secret);
    if (info && info.definition) {
      const pos = info.partOfSpeech ? `(${info.partOfSpeech}) ` : "";
      showHintBox(`💡 ${pos}${maskWord(info.definition, secret)}`);
      return;
    }

    const related = await fetchRelatedWords(secret);
    if (related.length) {
      showHintBox(`💡 Think of words related to: ${maskWord(related.join(", "), secret)}`);
      return;
    }

    showHintBox("💡 No clue available right now — trust your instincts!");
  }

  function submitGuess() {
    if (currentGuess.length !== WORD_LENGTH) {
      shakeRow();
      playInvalidSound();
      showToast("Not enough letters");
      return;
    }
    if (!validWords.has(currentGuess)) {
      shakeRow();
      playInvalidSound();
      showToast("Not in word list");
      return;
    }

    const guess = currentGuess;
    const result = evaluateGuess(guess);

    revealRow(guess, result, () => {
      updateKeyboardColors(guess, result);
      const won = guess === secret;
      if (won) {
        endGame(true);
      } else if (currentRow === MAX_GUESSES - 1) {
        endGame(false);
      } else {
        currentRow++;
        currentGuess = "";
      }
    });
  }

  function handleKey(k) {
    if (gameOver) return;
    if (k === "ENTER") {
      submitGuess();
    } else if (k === "BACK") {
      currentGuess = currentGuess.slice(0, -1);
      updateTiles();
      playBackspaceSound();
    } else if (/^[A-Z]$/.test(k)) {
      if (currentGuess.length < WORD_LENGTH) {
        currentGuess += k;
        updateTiles();
        playKeySound();
      }
    }
  }

  document.addEventListener("keydown", (e) => {
    if (
      !helpModal.classList.contains("hidden") ||
      !endModal.classList.contains("hidden") ||
      !giveupModal.classList.contains("hidden")
    ) {
      return;
    }
    const key = e.key.toUpperCase();
    if (key === "ENTER") handleKey("ENTER");
    else if (key === "BACKSPACE") handleKey("BACK");
    else if (/^[A-Z]$/.test(key)) handleKey(key);
  });

  helpBtn.addEventListener("click", () => helpModal.classList.remove("hidden"));
  closeHelp.addEventListener("click", () => helpModal.classList.add("hidden"));
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) helpModal.classList.add("hidden");
  });

  closeEnd.addEventListener("click", () => endModal.classList.add("hidden"));
  endModal.addEventListener("click", (e) => {
    if (e.target === endModal) endModal.classList.add("hidden");
  });

  hintBtn.addEventListener("click", handleHint);
  closeHintBtn.addEventListener("click", hideHintBox);

  giveupBtn.addEventListener("click", () => {
    if (gameOver) return;
    giveupModal.classList.remove("hidden");
  });
  closeGiveupBtn.addEventListener("click", () => giveupModal.classList.add("hidden"));
  cancelGiveupBtn.addEventListener("click", () => giveupModal.classList.add("hidden"));
  confirmGiveupBtn.addEventListener("click", giveUp);
  giveupModal.addEventListener("click", (e) => {
    if (e.target === giveupModal) giveupModal.classList.add("hidden");
  });

  function newGame() {
    secret = pickSecret();
    currentRow = 0;
    currentGuess = "";
    gameOver = false;
    hintUsed = false;
    endModal.classList.add("hidden");
    giveupModal.classList.add("hidden");
    endDefinitionBox.classList.add("hidden");
    hideHintBox();
    hintBtn.disabled = false;
    giveupBtn.disabled = false;
    buildBoard();
    buildKeyboard();
    startTimer();
  }

  newGameBtn.addEventListener("click", newGame);
  playAgainBtn.addEventListener("click", newGame);

  newGame();
})();
