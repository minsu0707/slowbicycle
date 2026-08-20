import * as THREE from "three";
import { RideAudio } from "./audio";
import { Bicycle } from "./bike";
import { InputController } from "./input";
import { DEFAULT_BIKE_STATE, damp, speedKmh, stepBike, type BikeState } from "./physics";
import { GameUI, type Settings } from "./ui";
import { EndlessWorld } from "./world";

type GameMode = "title" | "riding" | "paused";

export class SlowBicycleGame {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 650);
  private clock = new THREE.Clock();
  private world: EndlessWorld;
  private bicycle = new Bicycle();
  private input = new InputController();
  private audio = new RideAudio();
  private ui: GameUI;
  private state: BikeState = { ...DEFAULT_BIKE_STATE };
  private mode: GameMode = "title";
  private settings: Settings;
  private elapsed = 0;
  private milestone = 1;
  private shadowTarget = new THREE.Object3D();
  private loopStarted = false;
  private bestDistance = loadBestDistance();
  private cameraKick = 0;

  constructor(container: HTMLElement) {
    this.ui = new GameUI(container);
    this.settings = this.ui.getSettings();
    const canvas = document.querySelector<HTMLCanvasElement>("#scene");
    if (!canvas) throw new Error("Canvas not found");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0xe5b979);
    this.scene.fog = new THREE.FogExp2(0xd4b17b, 0.0065);
    this.world = new EndlessWorld(this.scene);
    this.scene.add(this.bicycle.group);
    this.setupLights();
    this.bindUI();
    this.ui.updateBest(this.bestDistance);
    this.resize();
    this.world.update(0);
    this.updateScene(0, 0);
    window.addEventListener("resize", () => this.resize());
  }

  private setupLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xf5d6a2, 0x365145, 2.2);
    const sun = new THREE.DirectionalLight(0xffe8bd, 3.3);
    sun.position.set(-38, 62, 24);
    sun.castShadow = false;
    sun.shadow.mapSize.set(512, 512);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.target = this.shadowTarget;
    this.scene.add(hemisphere, sun, this.shadowTarget);

    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(7, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe2a1, fog: false }),
    );
    sunDisc.position.set(-82, 55, -220);
    this.scene.add(sunDisc);
  }

  private bindUI(): void {
    this.ui.startButton.addEventListener("click", () => this.start());
    this.ui.resumeButton.addEventListener("click", () => this.resume());
    this.ui.restartButton.addEventListener("click", () => this.restart());
    document.getElementById("pause-button")?.addEventListener("click", () => this.pause());
    this.input.bindTouchButton(this.ui.controls.pedal, "pedal");
    this.input.bindTouchButton(this.ui.controls.brake, "brake");
    this.input.bindTouchButton(this.ui.controls.left, "left");
    this.input.bindTouchButton(this.ui.controls.right, "right");
    this.ui.onSettings((settings) => this.applySettings(settings));
    window.addEventListener("keydown", (event) => {
      if (event.code === "Escape") this.mode === "riding" ? this.pause() : this.mode === "paused" && this.resume();
      if (event.code === "KeyH") this.ui.toggleHud();
      if (this.mode === "title" && ["KeyW", "Space", "ArrowUp"].includes(event.code)) this.start();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.mode === "riding") this.pause();
    });
  }

  private start(): void {
    this.mode = "riding";
    this.input.setEnabled(true);
    this.ui.showRiding();
    if (this.settings.sound) this.audio.start();
    this.clock.getDelta();
    if (!this.loopStarted) {
      this.loopStarted = true;
      this.renderer.setAnimationLoop(() => this.frame());
    }
  }

  private pause(): void {
    if (this.mode !== "riding") return;
    this.mode = "paused";
    this.input.setEnabled(false);
    this.ui.showPaused();
    this.saveProgress();
  }

  private resume(): void {
    this.mode = "riding";
    this.input.setEnabled(true);
    this.ui.showRiding();
    if (this.settings.sound) this.audio.start();
    this.clock.getDelta();
  }

  private restart(): void {
    this.saveProgress();
    this.state = { ...DEFAULT_BIKE_STATE };
    this.elapsed = 0;
    this.milestone = 1;
    this.resume();
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.world?.setQuality(settings.quality);
    this.audio.setVolume(settings.sound ? settings.volume : 0);
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mode === "riding") {
      const controls = this.input.sample(dt);
      const pedalStroke = this.input.consumePedalStroke();
      if (pedalStroke) this.cameraKick = Math.min(1.35, this.cameraKick + 0.85);
      this.cameraKick *= Math.exp(-6.5 * dt);
      const road = this.world.sample(this.state.distance);
      const offRoad = Math.abs(this.state.lateral) > this.world.roadHalfWidth() - 0.25;
      this.state = stepBike(this.state, controls, { slope: road.slope, offRoad }, dt);
      this.elapsed += dt;
      this.world.update(this.state.distance);
      this.bicycle.update(this.state.speed, this.state.lean, dt, controls.pedal > 0, pedalStroke);
      this.audio.update(this.state.speed, controls.pedal, dt);
      this.ui.update(speedKmh(this.state.speed), this.state.distance, this.state.stamina);
      this.bestDistance = Math.max(this.bestDistance, this.state.distance);
      if (this.state.distance >= this.milestone * 1000) {
        this.ui.announceMilestone(this.milestone);
        this.audio.milestone();
        this.saveProgress();
        this.milestone += 1;
      }
    }
    this.updateScene(dt, this.elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  private updateScene(dt: number, elapsed: number): void {
    const road = this.world.sample(this.state.distance);
    const right = new THREE.Vector3(-road.tangent.z, 0, road.tangent.x).normalize();
    const bikePosition = road.position.clone().addScaledVector(right, this.state.lateral);
    bikePosition.y += 0.07;
    this.bicycle.group.position.copy(bikePosition);
    this.bicycle.group.rotation.y = road.yaw + this.state.heading;
    this.bicycle.group.rotation.x = -Math.atan(road.slope);

    const speedRatio = Math.min(this.state.speed / 13, 1);
    const distance = 7.2 + speedRatio * 2.8 + this.cameraKick * 0.55;
    const height = 3.5 + speedRatio * 1.1 + this.cameraKick * 0.08;
    const back = road.tangent.clone().multiplyScalar(-distance);
    const desiredCamera = bikePosition.clone().add(back).add(new THREE.Vector3(0, height, 0));
    if (!this.settings.reduceMotion && this.mode === "riding") {
      desiredCamera.y += Math.sin(elapsed * (2.1 + this.state.speed * 0.16)) * 0.025 * speedRatio;
    }
    const follow = dt === 0 ? 1 : 1 - Math.exp(-4.5 * dt);
    this.camera.position.lerp(desiredCamera, follow);
    const lookAhead = bikePosition.clone().addScaledVector(road.tangent, 10 + this.state.speed * 0.8);
    lookAhead.y += 1.1;
    this.camera.lookAt(lookAhead);
    const kickFov = this.settings.reduceMotion ? 0 : this.cameraKick * 2.8;
    this.camera.fov = damp(this.camera.fov, this.settings.reduceMotion ? 60 : 60 + speedRatio * 6 + kickFov, 7, dt || 0.016);
    this.camera.updateProjectionMatrix();
    this.shadowTarget.position.copy(bikePosition);
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private saveProgress(): void {
    localStorage.setItem("slowbicycle:progress", JSON.stringify({ bestDistanceMeters: this.bestDistance }));
    this.ui.updateBest(this.bestDistance);
  }
}

function loadBestDistance(): number {
  try {
    const progress = JSON.parse(localStorage.getItem("slowbicycle:progress") ?? "{}") as { bestDistanceMeters?: number };
    return Number.isFinite(progress.bestDistanceMeters) ? progress.bestDistanceMeters ?? 0 : 0;
  } catch {
    return 0;
  }
}
