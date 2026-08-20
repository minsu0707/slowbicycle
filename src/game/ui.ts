export interface Settings {
  quality: "low" | "high";
  reduceMotion: boolean;
  sound: boolean;
  volume: number;
}

const DEFAULTS: Settings = { quality: "high", reduceMotion: false, sound: true, volume: 0.7 };

export class GameUI {
  readonly root: HTMLElement;
  readonly startButton: HTMLButtonElement;
  readonly resumeButton: HTMLButtonElement;
  readonly restartButton: HTMLButtonElement;
  readonly controls: Record<"pedal" | "brake" | "left" | "right", HTMLButtonElement>;
  private speed: HTMLElement;
  private distance: HTMLElement;
  private stamina: HTMLElement;
  private title: HTMLElement;
  private pause: HTMLElement;
  private hud: HTMLElement;
  private toast: HTMLElement;
  private best: HTMLElement;
  private settings: Settings;
  private settingsListeners: Array<(settings: Settings) => void> = [];

  constructor(container: HTMLElement) {
    this.settings = loadSettings();
    container.innerHTML = markup(this.settings);
    this.root = container;
    this.startButton = this.get<HTMLButtonElement>("start-ride");
    this.resumeButton = this.get<HTMLButtonElement>("resume-ride");
    this.restartButton = this.get<HTMLButtonElement>("restart-ride");
    this.speed = this.get("speed-value");
    this.distance = this.get("distance-value");
    this.stamina = this.get("stamina-fill");
    this.title = this.get("title-screen");
    this.pause = this.get("pause-screen");
    this.hud = this.get("ride-hud");
    this.toast = this.get("milestone-toast");
    this.best = this.get("best-value");
    this.controls = {
      pedal: this.get<HTMLButtonElement>("touch-pedal"),
      brake: this.get<HTMLButtonElement>("touch-brake"),
      left: this.get<HTMLButtonElement>("touch-left"),
      right: this.get<HTMLButtonElement>("touch-right"),
    };
    this.bindSettings();
  }

  onSettings(listener: (settings: Settings) => void): void {
    this.settingsListeners.push(listener);
    listener(this.settings);
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  showRiding(): void {
    this.title.classList.add("is-hidden");
    this.pause.classList.add("is-hidden");
    this.root.classList.add("is-riding");
  }

  showPaused(): void {
    this.pause.classList.remove("is-hidden");
  }

  toggleHud(): void {
    this.hud.classList.toggle("is-hidden");
  }

  update(speedKmh: number, distanceMeters: number, stamina: number): void {
    this.speed.textContent = Math.round(speedKmh).toString().padStart(2, "0");
    this.distance.textContent = (distanceMeters / 1000).toFixed(2);
    this.stamina.style.transform = `scaleX(${stamina})`;
  }

  announceMilestone(kilometers: number): void {
    this.toast.textContent = `${kilometers.toFixed(0)} km`;
    this.toast.classList.remove("show");
    void this.toast.offsetWidth;
    this.toast.classList.add("show");
  }

  updateBest(distanceMeters: number): void {
    this.best.textContent = `${(distanceMeters / 1000).toFixed(2)} km`;
  }

  private bindSettings(): void {
    const quality = this.get<HTMLSelectElement>("quality-setting");
    const reduceMotion = this.get<HTMLInputElement>("motion-setting");
    const sound = this.get<HTMLInputElement>("sound-setting");
    const volume = this.get<HTMLInputElement>("volume-setting");
    const update = () => {
      this.settings = {
        quality: quality.value as Settings["quality"],
        reduceMotion: reduceMotion.checked,
        sound: sound.checked,
        volume: Number(volume.value),
      };
      localStorage.setItem("slowbicycle:settings", JSON.stringify(this.settings));
      for (const listener of this.settingsListeners) listener(this.getSettings());
    };
    quality.addEventListener("change", update);
    reduceMotion.addEventListener("change", update);
    sound.addEventListener("change", update);
    volume.addEventListener("input", update);
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing UI element: ${id}`);
    return element as T;
  }
}

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem("slowbicycle:settings") ?? "{}") as Partial<Settings>;
    return { ...DEFAULTS, ...stored };
  } catch {
    return DEFAULTS;
  }
}

function markup(settings: Settings): string {
  return `
    <canvas id="scene" aria-label="끝없이 이어지는 시골길 위의 자전거 주행 장면"></canvas>
    <section id="title-screen" class="overlay title-screen">
      <div class="title-mark">
        <h1>slow bicycle</h1>
        <p>endless cycling</p>
      </div>
      <button id="start-ride" class="start-button">begin</button>
      <div class="title-meta">
        <p><span>pedal</span> w / ↑</p>
        <p><span>steer</span> a d / ← →</p>
        <p><span>brake</span> s / ↓</p>
      </div>
      <p class="best-distance"><span>best</span> <b id="best-value">0.00 km</b></p>
    </section>

    <section id="ride-hud" class="hud" aria-live="polite">
      <div class="speedometer"><strong id="speed-value">00</strong><span>km/h</span></div>
      <div class="distance"><span>distance</span> <b id="distance-value">0.00</b> km</div>
      <div class="stamina" aria-label="페달 여유"><i id="stamina-fill"></i></div>
      <button id="pause-button" class="pause-button" aria-label="일시정지">pause</button>
    </section>

    <div id="milestone-toast" class="milestone">1 km</div>

    <section id="pause-screen" class="overlay pause-screen is-hidden" aria-label="일시정지 메뉴">
      <div class="pause-card">
        <h2>paused</h2>
        <nav class="pause-actions">
          <button id="resume-ride">resume</button>
          <button id="restart-ride">restart</button>
        </nav>
        <div class="settings">
          <label><span>detail</span>
            <select id="quality-setting"><option value="high" ${settings.quality === "high" ? "selected" : ""}>high</option><option value="low" ${settings.quality === "low" ? "selected" : ""}>low</option></select>
          </label>
          <label class="check-row"><span>reduce motion</span><input id="motion-setting" type="checkbox" ${settings.reduceMotion ? "checked" : ""}/></label>
          <label class="check-row"><span>sound</span><input id="sound-setting" type="checkbox" ${settings.sound ? "checked" : ""}/></label>
          <label><span>volume</span><input id="volume-setting" type="range" min="0" max="1" step="0.05" value="${settings.volume}" /></label>
        </div>
        <p class="pause-help">esc to return · h to hide ui</p>
      </div>
    </section>

    <nav class="touch-controls" aria-label="터치 주행 조작">
      <div><button id="touch-left" aria-label="왼쪽">←</button><button id="touch-right" aria-label="오른쪽">→</button></div>
      <div><button id="touch-brake" class="small" aria-label="브레이크">BRK</button><button id="touch-pedal" aria-label="페달">GO</button></div>
    </nav>
  `;
}
