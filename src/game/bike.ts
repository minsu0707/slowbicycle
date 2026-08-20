import * as THREE from "three";

const INK = new THREE.MeshStandardMaterial({ color: 0x18221f, roughness: 0.48, metalness: 0.35 });
const FRAME = new THREE.MeshStandardMaterial({ color: 0xc55d3f, roughness: 0.42, metalness: 0.28 });

export class Bicycle {
  readonly group = new THREE.Group();
  private wheels: THREE.Group[] = [];
  private pedals = new THREE.Group();

  constructor() {
    this.group.name = "bicycle";
    this.build();
  }

  update(speed: number, lean: number, pedalTime: number): void {
    this.group.rotation.z = lean;
    for (const wheel of this.wheels) wheel.rotation.x -= speed * 0.032;
    this.pedals.rotation.x = pedalTime * Math.min(speed * 0.85, 8);
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

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.065, 0.22), INK);
    seat.position.copy(joints.seat).add(new THREE.Vector3(0, 0.08, 0.05));
    this.group.add(seat, tube(joints.frontTop, new THREE.Vector3(0, 1.67, -0.82), 0.026, INK));
    this.addDropHandlebars();

    this.pedals.position.copy(joints.crank);
    const axle = tube(new THREE.Vector3(-0.23, 0, 0), new THREE.Vector3(0.23, 0, 0), 0.025, INK);
    const chainring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 6, 28), INK);
    chainring.rotation.y = Math.PI / 2;
    this.pedals.add(axle, chainring);
    this.group.add(this.pedals);

    this.group.scale.setScalar(0.86);
  }

  private makeWheel(radius: number): THREE.Group {
    const holder = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.027, 8, 48), INK);
    tire.rotation.y = Math.PI / 2;
    holder.add(tire);
    const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xcfd3cc, metalness: 0.65, roughness: 0.3 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.94, 0.012, 5, 48), rimMaterial);
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

  private addDropHandlebars(): void {
    const center = new THREE.Vector3(0, 1.67, -0.82);
    this.group.add(
      tube(new THREE.Vector3(-0.34, 1.67, -0.82), new THREE.Vector3(0.34, 1.67, -0.82), 0.018, INK),
      tube(center, new THREE.Vector3(0, 1.67, -0.72), 0.022, INK),
    );
    for (const side of [-1, 1]) {
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
