import type { BikeInput } from "./physics";

export class InputController {
  private keys = new Set<string>();
  private touch = { pedal: false, brake: false, left: false, right: false };
  private enabled = false;
  private pedalStrokeQueued = false;
  private pedalBurst = 0;

  constructor() {
    window.addEventListener("keydown", (event) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
      }
      this.keys.add(event.code);
      if (event.code === "Space" && !event.repeat && this.enabled) {
        this.pedalStrokeQueued = true;
        this.pedalBurst = 0.22;
      }
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.resetTouch();
  }

  bindTouchButton(element: HTMLElement, action: keyof typeof this.touch): void {
    const set = (value: boolean) => (event: PointerEvent) => {
      event.preventDefault();
      this.touch[action] = value;
      element.classList.toggle("is-pressed", value);
    };
    element.addEventListener("pointerdown", set(true));
    element.addEventListener("pointerup", set(false));
    element.addEventListener("pointercancel", set(false));
    element.addEventListener("pointerleave", set(false));
  }

  sample(dt = 0): BikeInput {
    if (!this.enabled) return { pedal: 0, brake: 0, steer: 0 };
    this.pedalBurst = Math.max(0, this.pedalBurst - dt);
    const pedal = this.keys.has("KeyW") || this.keys.has("Space") || this.keys.has("ArrowUp") || this.touch.pedal || this.pedalBurst > 0;
    const brake = this.keys.has("KeyS") || this.keys.has("ArrowDown") || this.touch.brake;
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft") || this.touch.left;
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight") || this.touch.right;
    return { pedal: pedal ? 1 : 0, brake: brake ? 1 : 0, steer: Number(right) - Number(left) };
  }

  consumePedalStroke(): boolean {
    const queued = this.pedalStrokeQueued;
    this.pedalStrokeQueued = false;
    return queued;
  }

  private resetTouch(): void {
    this.touch = { pedal: false, brake: false, left: false, right: false };
    this.pedalStrokeQueued = false;
    this.pedalBurst = 0;
  }
}
