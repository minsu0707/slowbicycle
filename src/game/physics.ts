export interface BikeInput {
  pedal: number;
  brake: number;
  steer: number;
}

export interface BikeState {
  speed: number;
  distance: number;
  lateral: number;
  heading: number;
  lean: number;
  stamina: number;
}

export interface PhysicsOptions {
  slope: number;
  offRoad: boolean;
}

export const DEFAULT_BIKE_STATE: BikeState = {
  speed: 0,
  distance: 0,
  lateral: 0,
  heading: 0,
  lean: 0,
  stamina: 1,
};

const MAX_SPEED = 15;

export function stepBike(
  previous: BikeState,
  input: BikeInput,
  options: PhysicsOptions,
  dt: number,
): BikeState {
  const frame = Math.min(Math.max(dt, 0), 0.05);
  const pedal = clamp(input.pedal, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const steer = clamp(input.steer, -1, 1);
  const effort = 0.58 + previous.stamina * 0.42;
  const drive = pedal * 4.3 * effort;
  const gravity = -9.81 * options.slope;
  const rolling = previous.speed > 0.05 ? 0.14 : 0;
  const drag = 0.017 * previous.speed * previous.speed;
  const roughness = options.offRoad ? 2.1 : 0;
  const braking = brake * 8.5;
  const acceleration = drive + gravity - rolling - drag - roughness - braking;
  const speed = clamp(previous.speed + acceleration * frame, 0, MAX_SPEED);

  // A road bike changes lane with a small heading angle. Large angles made the
  // riderless bicycle snap sideways and visually skid instead of carving.
  const steerAuthority = 0.07 + Math.min(speed / 8, 1) * 0.15;
  const targetHeading = steer * steerAuthority;
  const heading = damp(previous.heading, targetHeading, 7, frame);
  const lateral = previous.lateral + Math.sin(heading) * speed * frame;
  const targetLean = -steer * Math.min(speed / 9, 1) * 0.2;
  const lean = damp(previous.lean, targetLean, 8, frame);

  const drain = pedal > 0.72 ? (pedal - 0.72) * 0.065 : 0;
  const recovery = pedal < 0.45 ? 0.042 : 0.008;
  const stamina = clamp(previous.stamina + (recovery - drain) * frame, 0, 1);

  return {
    speed,
    distance: previous.distance + speed * frame,
    lateral,
    heading,
    lean,
    stamina,
  };
}

export function speedKmh(speed: number): number {
  return speed * 3.6;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
