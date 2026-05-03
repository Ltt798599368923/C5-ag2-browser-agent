// Memo — the Memory Agent mascot.
// Inline SVG with CSS-driven states: idle, thinking, happy, reading.
// State changes are class swaps; CSS handles the animations.

const SVG = `
<svg viewBox="0 0 80 80" class="mascot-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g class="m-body">
    <line x1="40" y1="22" x2="40" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="m-antenna"/>
    <circle cx="40" cy="9" r="3" fill="currentColor" class="m-antenna-tip"/>
    <ellipse cx="40" cy="48" rx="26" ry="24" fill="currentColor" class="m-shell"/>
    <ellipse cx="22" cy="52" rx="3.5" ry="2" fill="#ffd9c8" opacity="0.75" class="m-cheek m-cheek-l"/>
    <ellipse cx="58" cy="52" rx="3.5" ry="2" fill="#ffd9c8" opacity="0.75" class="m-cheek m-cheek-r"/>
    <g class="m-eye m-eye-l">
      <ellipse cx="30" cy="44" rx="5" ry="6" fill="#ffffff" class="m-eye-white"/>
      <circle cx="30" cy="45" r="2.5" fill="#1f1b16" class="m-pupil"/>
      <circle cx="31.4" cy="43.4" r="0.9" fill="#ffffff" class="m-glint"/>
    </g>
    <g class="m-eye m-eye-r">
      <ellipse cx="50" cy="44" rx="5" ry="6" fill="#ffffff" class="m-eye-white"/>
      <circle cx="50" cy="45" r="2.5" fill="#1f1b16" class="m-pupil"/>
      <circle cx="51.4" cy="43.4" r="0.9" fill="#ffffff" class="m-glint"/>
    </g>
    <path d="M33 55 Q40 60 47 55" stroke="#1f1b16" stroke-width="2" fill="none" stroke-linecap="round" class="m-mouth"/>
  </g>
  <!-- thought sparkles (only visible in thinking state) -->
  <g class="m-thoughts" aria-hidden="true">
    <circle cx="58" cy="20" r="1.3" fill="currentColor" class="m-spark m-spark-1"/>
    <circle cx="64" cy="14" r="1.8" fill="currentColor" class="m-spark m-spark-2"/>
    <circle cx="71" cy="9" r="2.4" fill="currentColor" class="m-spark m-spark-3"/>
  </g>
</svg>`;

const STATES = ["idle", "thinking", "happy", "reading", "wave"];

export function createMascot({ size = "md", state = "idle", greeting = null } = {}) {
  const root = document.createElement("div");
  root.className = `mascot mascot-${size} state-${state}`;
  root.innerHTML = SVG;

  if (greeting) {
    const bubble = document.createElement("div");
    bubble.className = "mascot-bubble";
    bubble.innerHTML = greeting;
    root.appendChild(bubble);
    root.classList.add("with-bubble");
  }
  return root;
}

export function setMascotState(el, state) {
  for (const s of STATES) el.classList.remove(`state-${s}`);
  el.classList.add(`state-${state}`);
}

export function celebrate(el, ms = 900) {
  setMascotState(el, "happy");
  setTimeout(() => setMascotState(el, "idle"), ms);
}

// Idle micro-life: random blinks and occasional winks.
// Returns a stop() function.
export function startIdleLife(el) {
  let blinkTimer, winkTimer;
  const blink = () => {
    el.classList.add("blink");
    setTimeout(() => el.classList.remove("blink"), 180);
  };
  const wink = () => {
    el.classList.add("wink");
    setTimeout(() => el.classList.remove("wink"), 380);
  };
  const scheduleBlink = () => {
    blinkTimer = setTimeout(() => {
      if (el.classList.contains("state-idle")) blink();
      scheduleBlink();
    }, 3000 + Math.random() * 5000);
  };
  const scheduleWink = () => {
    winkTimer = setTimeout(() => {
      if (el.classList.contains("state-idle")) wink();
      scheduleWink();
    }, 25000 + Math.random() * 35000);
  };
  scheduleBlink();
  scheduleWink();
  return () => { clearTimeout(blinkTimer); clearTimeout(winkTimer); };
}
