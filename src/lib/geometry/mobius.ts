import {
  type C,
  ZERO,
  abs2,
  clampToDisk,
  conj,
  div,
  mul,
  neg,
  scale,
  sub,
} from "./complex";

/** Möbius map sending a → 0: T_a(z) = (z − a) / (1 − conj(a) z). */
export function mobiusToOrigin(a: C, z: C): C {
  if (abs2(a) < 1e-16) return z;
  return clampToDisk(
    div(sub(z, a), sub({ re: 1, im: 0 }, mul(conj(a), z))),
  );
}

export function mobiusFromOrigin(a: C, z: C): C {
  return mobiusToOrigin(neg(a), z);
}

export function applyView(layoutZ: C, focus: C, pan: C): C {
  return mobiusToOrigin(pan, mobiusToOrigin(focus, layoutZ));
}

/** Geodesic lerp in the Poincaré disk (Apple-smooth path for focus travel). */
export function geodesicLerp(a: C, b: C, t: number): C {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const bRel = mobiusToOrigin(a, b);
  return mobiusFromOrigin(a, scale(bRel, t));
}

export function panByDrag(startPan: C, dragOrigin: C, dragCurrent: C): C {
  const delta = sub(dragOrigin, dragCurrent);
  return clampToDisk(
    { re: startPan.re + delta.re * 0.9, im: startPan.im + delta.im * 0.9 },
    0.97,
  );
}

export { ZERO };
