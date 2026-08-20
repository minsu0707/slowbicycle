import * as THREE from "three";

const INK = new THREE.MeshStandardMaterial({ color: 0x18221f, roughness: 0.48, metalness: 0.35 });
const FRAME = new THREE.MeshStandardMaterial({ color: 0xc55d3f, roughness: 0.42, metalness: 0.28 });
const METAL = new THREE.MeshStandardMaterial({ color: 0xb8bcb8, roughness: 0.3, metalness: 0.82 });
const MODEL_SCALE = 0.86;
const WHEEL_RADIUS = 0.98;
const WHEEL_HUB_HEIGHT = 0.72;

export class Bicycle {
  readonly group = new THREE.Group();
  readonly wheelbase = 2.1 * MODEL_SCALE;
  private readonly worldWheelRadius = WHEEL_RADIUS * MODEL_SCALE;
  private wheels: THREE.Group[] = [];
  private frontSteering?: THREE.Group;
  private steeringAngle = 0;
  private pedals = new THREE.Group();
  private crankAngle = 0;
  private crankTarget = 0;

  constructor() {
    this.group.name = "bicycle";
    this.group.rotation.order = "YXZ";
    this.build();
  }

  update(speed: number, lean: number, steering: number, dt: number, pedaling: boolean, pedalStroke: boolean): void {
    this.group.rotation.z = lean;
    const wheelRotation = (speed * dt) / this.worldWheelRadius;
    for (const wheel of this.wheels) wheel.rotation.x -= wheelRotation;
    const targetSteering = -steering * Math.min(speed / 5, 1) * 0.09;
    this.steeringAngle += (targetSteering - this.steeringAngle) * (1 - Math.exp(-10 * dt));
    if (this.frontSteering) this.frontSteering.rotation.y = this.steeringAngle;
    if (pedalStroke) this.crankTarget += Math.PI;
    if (pedaling && !pedalStroke) this.crankTarget += dt * (2.2 + speed * 0.38);
    this.crankAngle += (this.crankTarget - this.crankAngle) * (1 - Math.exp(-15 * dt));
    this.pedals.rotation.x = this.crankAngle;
  }

  groundOffsetAtPitch(pitch: number): number {
    // Small clearance keeps the tire surface above the ground without visible floating.
    return this.worldWheelRadius - WHEEL_HUB_HEIGHT * MODEL_SCALE * Math.cos(pitch) + 0.012;
  }

  private build(): void {
    const rear = this.makeWheel(WHEEL_RADIUS);
    rear.position.set(0, WHEEL_HUB_HEIGHT, 1.05);
    const front = this.makeWheel(WHEEL_RADIUS);
    const frontSteering = new THREE.Group();
    frontSteering.name = "front-steering";
    frontSteering.position.set(0, WHEEL_HUB_HEIGHT, -1.05);
    frontSteering.add(front);
    this.frontSteering = frontSteering;
    this.group.add(rear, frontSteering);
    this.wheels.push(rear, front);

    const joints = {
      crank: new THREE.Vector3(0, 0.84, 0.05),
      seat: new THREE.Vector3(0, 1.55, 0.28),
      frontTop: new THREE.Vector3(0, 1.52, -0.72),
      rearHub: new THREE.Vector3(0, WHEEL_HUB_HEIGHT, 1.05),
      frontHub: new THREE.Vector3(0, WHEEL_HUB_HEIGHT, -1.05),
    };
    this.group.add(
      tube(joints.crank, joints.seat, 0.055, FRAME),
      tube(joints.seat, joints.frontTop, 0.05, FRAME),
      tube(joints.frontTop, joints.crank, 0.05, FRAME),
      tube(joints.crank, joints.rearHub, 0.038, FRAME),
      tube(joints.seat, joints.rearHub, 0.034, FRAME),
      tube(joints.frontTop.clone().setX(-0.075), joints.frontHub.clone().setX(-0.105), 0.025, INK),
      tube(joints.frontTop.clone().setX(0.075), joints.frontHub.clone().setX(0.105), 0.025, INK),
    );

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.065, 0.22), INK);
    seat.position.copy(joints.seat).add(new THREE.Vector3(0, 0.08, 0.05));
    this.group.add(seat, tube(joints.frontTop, new THREE.Vector3(0, 1.67, -0.82), 0.026, INK));
    this.addDropHandlebars();

    this.pedals.position.copy(joints.crank);
    const axle = tube(new THREE.Vector3(-0.23, 0, 0), new THREE.Vector3(0.23, 0, 0), 0.025, INK);
    const chainring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 6, 28), INK);
    chainring.rotation.y = Math.PI / 2;
    const leftArm = tube(new THREE.Vector3(-0.04, 0, 0), new THREE.Vector3(-0.13, 0.25, 0), 0.018, INK);
    const rightArm = tube(new THREE.Vector3(0.04, 0, 0), new THREE.Vector3(0.13, -0.25, 0), 0.018, INK);
    const leftPedal = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.075), INK);
    leftPedal.position.set(-0.22, 0.25, 0);
    const rightPedal = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.075), INK);
    rightPedal.position.set(0.22, -0.25, 0);
    this.pedals.add(axle, chainring, leftArm, rightArm, leftPedal, rightPedal);
    this.group.add(this.pedals);
    const cassette = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 5, 24), METAL);
    cassette.rotation.y = Math.PI / 2;
    cassette.position.set(0.13, 0.72, 1.05);
    this.group.add(
      cassette,
      tube(new THREE.Vector3(0.13, 1.01, 0.03), new THREE.Vector3(0.13, 0.83, 1.05), 0.009, METAL),
      tube(new THREE.Vector3(0.13, 0.67, 0.04), new THREE.Vector3(0.13, 0.61, 1.05), 0.009, METAL),
    );

    const derailleur = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.06), INK);
    derailleur.position.set(0.15, 0.48, 0.98);
    derailleur.rotation.x = -0.28;
    this.group.add(derailleur);

    this.group.scale.setScalar(MODEL_SCALE);
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });
  }

  private makeWheel(radius: number): THREE.Group {
    const holder = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.027, 8, 48), INK);
    tire.rotation.y = Math.PI / 2;
    holder.add(tire);
    const rimMaterial = METAL;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.94, 0.012, 5, 48), rimMaterial);
    rim.rotation.y = Math.PI / 2;
    holder.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.24, 10), METAL);
    hub.rotation.z = Math.PI / 2;
    const rotor = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.18, 0.012, 5, 24), METAL);
    rotor.rotation.y = Math.PI / 2;
    rotor.position.x = -0.075;
    holder.add(hub, rotor);
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      const spoke = tube(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, Math.cos(angle) * radius * 0.86, Math.sin(angle) * radius * 0.86),
        0.006,
        rimMaterial,
      );
      holder.add(spoke);
    }
    return holder;
  }

  private addDropHandlebars(): void {
    const center = new THREE.Vector3(0, 1.67, -0.82);
    this.group.add(
      tube(new THREE.Vector3(-0.34, 1.67, -0.82), new THREE.Vector3(0.34, 1.67, -0.82), 0.018, INK),
      tube(center, new THREE.Vector3(0, 1.67, -0.72), 0.022, INK),
    );
    for (const side of [-1, 1]) {
      const hood = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.15, 0.09), INK);
      hood.position.set(side * 0.32, 1.69, -0.89);
      hood.rotation.x = -0.28;
      this.group.add(
        tube(
          new THREE.Vector3(side * 0.34, 1.67, -0.82),
          new THREE.Vector3(side * 0.39, 1.51, -0.94),
          0.018,
          INK,
        ),
        tube(
          new THREE.Vector3(side * 0.39, 1.51, -0.94),
          new THREE.Vector3(side * 0.34, 1.35, -0.86),
          0.018,
          INK,
        ),
        hood,
      );
    }
  }

}

function tube(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const midpoint = a.clone().add(b).multiplyScalar(0.5);
  const direction = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), material);
  mesh.position.copy(midpoint);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  return mesh;
}
