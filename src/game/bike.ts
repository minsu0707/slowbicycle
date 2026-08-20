import * as THREE from "three";

const INK = new THREE.MeshStandardMaterial({ color: 0x18221f, roughness: 0.48, metalness: 0.35 });
const FRAME = new THREE.MeshStandardMaterial({ color: 0xc55d3f, roughness: 0.42, metalness: 0.28 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xc78963, roughness: 0.8 });
const SHIRT = new THREE.MeshStandardMaterial({ color: 0xe7c86b, roughness: 0.75 });

export class Bicycle {
  readonly group = new THREE.Group();
  private wheels: THREE.Group[] = [];
  private pedals = new THREE.Group();
  private rider = new THREE.Group();

  constructor() {
    this.group.name = "bicycle";
    this.build();
  }

  update(speed: number, lean: number, pedalTime: number): void {
    this.group.rotation.z = lean;
    for (const wheel of this.wheels) wheel.rotation.x -= speed * 0.032;
    this.pedals.rotation.x = pedalTime * Math.min(speed * 0.85, 8);
    this.rider.position.y = 0.025 * Math.sin(pedalTime * Math.min(speed, 6));
  }

  private build(): void {
    const rear = this.makeWheel(0.98);
    rear.position.set(0, 0.72, 1.05);
    const front = this.makeWheel(0.98);
    front.position.set(0, 0.72, -1.05);
    this.group.add(rear, front);
    this.wheels.push(rear, front);

    const joints = {
      crank: new THREE.Vector3(0, 0.84, 0.05),
      seat: new THREE.Vector3(0, 1.55, 0.28),
      frontTop: new THREE.Vector3(0, 1.52, -0.72),
      rearHub: new THREE.Vector3(0, 0.72, 1.05),
      frontHub: new THREE.Vector3(0, 0.72, -1.05),
    };
    this.group.add(
      tube(joints.crank, joints.seat, 0.055, FRAME),
      tube(joints.seat, joints.frontTop, 0.05, FRAME),
      tube(joints.frontTop, joints.crank, 0.05, FRAME),
      tube(joints.crank, joints.rearHub, 0.038, FRAME),
      tube(joints.seat, joints.rearHub, 0.034, FRAME),
      tube(joints.frontTop, joints.frontHub, 0.042, INK),
    );

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.09, 0.18), INK);
    seat.position.copy(joints.seat).add(new THREE.Vector3(0, 0.08, 0.05));
    const handlebar = tube(new THREE.Vector3(-0.28, 1.68, -0.78), new THREE.Vector3(0.28, 1.68, -0.78), 0.028, INK);
    this.group.add(seat, handlebar);

    this.pedals.position.copy(joints.crank);
    const axle = tube(new THREE.Vector3(-0.23, 0, 0), new THREE.Vector3(0.23, 0, 0), 0.025, INK);
    this.pedals.add(axle);
    this.group.add(this.pedals);

    this.rider.add(this.makeRider());
    this.group.add(this.rider);
    this.group.scale.setScalar(0.86);
  }

  private makeWheel(radius: number): THREE.Group {
    const holder = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 10, 42), INK);
    tire.rotation.y = Math.PI / 2;
    holder.add(tire);
    const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xcfd3cc, metalness: 0.65, roughness: 0.3 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.88, 0.018, 6, 36), rimMaterial);
    rim.rotation.y = Math.PI / 2;
    holder.add(rim);
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

  private makeRider(): THREE.Group {
    const rider = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.62, 5, 10), SHIRT);
    torso.position.set(0, 2.05, 0.16);
    torso.rotation.x = -0.42;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), SKIN);
    head.position.set(0, 2.48, -0.17);
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
      FRAME,
    );
    helmet.position.copy(head.position).add(new THREE.Vector3(0, 0.05, 0));
    rider.add(torso, head, helmet);
    rider.add(
      tube(new THREE.Vector3(-0.18, 2.16, -0.02), new THREE.Vector3(-0.25, 1.7, -0.75), 0.055, SKIN),
      tube(new THREE.Vector3(0.18, 2.16, -0.02), new THREE.Vector3(0.25, 1.7, -0.75), 0.055, SKIN),
      tube(new THREE.Vector3(-0.12, 1.82, 0.2), new THREE.Vector3(-0.16, 1.0, 0.02), 0.07, INK),
      tube(new THREE.Vector3(0.12, 1.82, 0.2), new THREE.Vector3(0.16, 0.72, 0.12), 0.07, INK),
    );
    return rider;
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
