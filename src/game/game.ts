import * as THREE from "three";
import { RideAudio } from "./audio";
import { Bicycle } from "./bike";
import { sampleAtmosphere, type AtmosphereState } from "./day-night";
import { InputController } from "./input";
import {
  DEFAULT_BIKE_STATE,
  damp,
  returnToRoadIfNeeded,
  speedKmh,
  stepBike,
  type BikeState,
} from "./physics";
import { loadBestDistance, saveBestDistance } from "./storage";
import { GameUI, type Settings } from "./ui";
import { WildlifeDirector } from "./wildlife";
import { EndlessWorld } from "./world";

type GameMode = "title" | "riding" | "paused";

export class SlowBicycleGame {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 650);
  private clock = new THREE.Clock();
  private world: EndlessWorld;
  private wildlife: WildlifeDirector;
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
  private skyLight = new THREE.HemisphereLight(0xb9ccdb, 0x43503c, 1.25);
  private sun = new THREE.DirectionalLight(0xffdfaa, 2.15);
  private sunDisc?: THREE.Mesh;
  private loopStarted = false;
  private bestDistance = loadBestDistance();
  private cameraKick = 0;
  private readonly roadRight = new THREE.Vector3();
  private readonly bikePosition = new THREE.Vector3();
  private readonly frontGround = new THREE.Vector3();
  private readonly rearGround = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly lookAhead = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.ui = new GameUI(container);
    this.settings = this.ui.getSettings();
    const canvas = document.querySelector<HTMLCanvasElement>("#scene");
    if (!canvas) throw new Error("Canvas not found");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0xe5b979);
    this.scene.fog = new THREE.FogExp2(0xd4b17b, 0.0065);
    this.world = new EndlessWorld(this.scene);
    this.wildlife = new WildlifeDirector(this.world);
    this.scene.add(this.wildlife.group);
    this.scene.add(this.bicycle.group);
    this.setupLights();
    this.bindUI();
    this.ui.updateBest(this.bestDistance);
    this.resize();
    this.world.update(this.state.distance);
    this.updateScene(0, 0);
    this.renderer.render(this.scene, this.camera);
    window.addEventListener("resize", () => this.resize());
  }

  private setupLights(): void {
    this.sun.position.set(-38, 62, 24);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -20;
    this.sun.shadow.camera.right = 20;
    this.sun.shadow.camera.top = 20;
    this.sun.shadow.camera.bottom = -20;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 110;
    this.sun.shadow.bias = -0.0002;
    this.sun.target = this.shadowTarget;
    this.scene.add(this.skyLight, this.sun, this.shadowTarget);

    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(7, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe2a1, fog: false }),
    );
    this.scene.add(this.sunDisc);
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
    this.wildlife.reset();
    this.resume();
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    this.world?.setQuality(settings.quality);
    this.wildlife?.setQuality(settings.quality);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === "high" ? 1.5 : 1));
    this.renderer.shadowMap.enabled = settings.quality === "high";
    this.sun.castShadow = settings.quality === "high";
    if (settings.sound && this.mode === "riding") this.audio.start();
    this.audio.setVolume(settings.sound ? settings.volume : 0);
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    let atmosphere: AtmosphereState | undefined;
    if (this.mode === "riding") {
      const controls = this.input.sample(dt);
      const pedalStroke = this.input.consumePedalStroke();
      if (pedalStroke) this.cameraKick = Math.min(1.35, this.cameraKick + 0.85);
      this.cameraKick *= Math.exp(-6.5 * dt);
      const road = this.world.sample(this.state.distance);
      const offRoad = Math.abs(this.state.lateral) > this.world.roadHalfWidth() - 0.25;
      this.state = stepBike(this.state, controls, { slope: road.slope, offRoad }, dt);
      const recoveredState = returnToRoadIfNeeded(this.state);
      if (recoveredState !== this.state) this.ui.announceRoadReturn();
      this.state = recoveredState;
      this.elapsed += dt;
      this.world.update(this.state.distance);
      atmosphere = sampleAtmosphere(this.elapsed);
      this.wildlife.update(dt, this.state.distance, atmosphere.starOpacity);
      this.bicycle.update(this.state.speed, this.state.lean, controls.steer, dt, controls.pedal > 0, pedalStroke);
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
    this.updateScene(dt, this.elapsed, atmosphere);
    this.renderer.render(this.scene, this.camera);
  }

  private updateScene(dt: number, elapsed: number, atmosphere = sampleAtmosphere(elapsed)): void {
    const road = this.world.sample(this.state.distance);
    this.roadRight.set(-road.tangent.z, 0, road.tangent.x).normalize();
    this.bikePosition.copy(road.position).addScaledVector(this.roadRight, this.state.lateral);
    const halfWheelbase = this.bicycle.wheelbase * 0.5;
    const longitudinalOffset = Math.cos(this.state.heading) * halfWheelbase;
    const lateralOffset = Math.sin(this.state.heading) * halfWheelbase;
    this.world.groundPosition(
      this.state.distance + longitudinalOffset,
      this.state.lateral + lateralOffset,
      this.frontGround,
    );
    this.world.groundPosition(
      this.state.distance - longitudinalOffset,
      this.state.lateral - lateralOffset,
      this.rearGround,
    );
    const contactDistance = Math.max(
      0.001,
      Math.hypot(this.frontGround.x - this.rearGround.x, this.frontGround.z - this.rearGround.z),
    );
    const pitch = Math.atan2(this.frontGround.y - this.rearGround.y, contactDistance);
    this.bikePosition.y =
      (this.frontGround.y + this.rearGround.y) * 0.5 + this.bicycle.groundOffsetAtPitch(pitch);
    this.bicycle.group.position.copy(this.bikePosition);
    // Physics uses positive heading for motion toward the road's right side,
    // while Three.js positive Y rotation turns a -Z-facing model to the left.
    this.bicycle.group.rotation.y = road.yaw - this.state.heading;
    // Sample both tire contact points: when steering diagonally, the wheels sit
    // at different longitudinal and lateral ground positions.
    this.bicycle.group.rotation.x = pitch;

    const speedRatio = Math.min(this.state.speed / 13, 1);
    const distance = 7.2 + speedRatio * 2.8 + this.cameraKick * 0.55;
    const height = 3.5 + speedRatio * 1.1 + this.cameraKick * 0.08;
    this.desiredCamera.copy(road.tangent).multiplyScalar(-distance).add(this.bikePosition);
    this.desiredCamera.y += height;
    if (!this.settings.reduceMotion && this.mode === "riding") {
      this.desiredCamera.y += Math.sin(elapsed * (2.1 + this.state.speed * 0.16)) * 0.025 * speedRatio;
    }
    const follow = dt === 0 ? 1 : 1 - Math.exp(-4.5 * dt);
    this.camera.position.lerp(this.desiredCamera, follow);
    this.lookAhead.copy(this.bikePosition).addScaledVector(road.tangent, 10 + this.state.speed * 0.8);
    this.lookAhead.y += 1.1;
    this.camera.lookAt(this.lookAhead);
    const kickFov = this.settings.reduceMotion ? 0 : this.cameraKick * 2.8;
    this.camera.fov = damp(this.camera.fov, this.settings.reduceMotion ? 60 : 60 + speedRatio * 6 + kickFov, 7, dt || 0.016);
    this.camera.updateProjectionMatrix();
    this.shadowTarget.position.copy(this.bikePosition);
    this.updateAtmosphere(atmosphere);
  }

  private updateAtmosphere(atmosphere: AtmosphereState): void {
    (this.scene.background as THREE.Color).setHex(atmosphere.background);
    (this.scene.fog as THREE.FogExp2).color.setHex(atmosphere.fog);
    this.renderer.toneMappingExposure = atmosphere.exposure;
    this.skyLight.color.setHex(atmosphere.skyLight);
    this.skyLight.groundColor.setHex(atmosphere.groundLight);
    this.skyLight.intensity = atmosphere.ambientIntensity;
    this.sun.color.setHex(atmosphere.sunColor);
    this.sun.intensity = atmosphere.sunIntensity;
    this.world.setAtmosphere(atmosphere.skyTint, atmosphere.starOpacity);

    const lightRadius = 82;
    const lightHeight = 8 + Math.max(0, atmosphere.sunElevation) * 72;
    this.sun.position.set(
      this.bikePosition.x + Math.cos(atmosphere.sunAzimuth) * lightRadius,
      this.bikePosition.y + lightHeight,
      this.bikePosition.z + Math.sin(atmosphere.sunAzimuth) * lightRadius,
    );
    if (this.sunDisc) {
      const discRadius = 240;
      this.sunDisc.position.set(
        this.bikePosition.x + Math.cos(atmosphere.sunAzimuth) * discRadius,
        this.bikePosition.y + atmosphere.sunElevation * 185,
        this.bikePosition.z + Math.sin(atmosphere.sunAzimuth) * discRadius,
      );
      (this.sunDisc.material as THREE.MeshBasicMaterial).color.setHex(atmosphere.sunColor);
      this.sunDisc.visible = atmosphere.sunElevation > -0.035;
    }
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private saveProgress(): void {
    saveBestDistance(this.bestDistance);
    this.ui.updateBest(this.bestDistance);
  }
}
