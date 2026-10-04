export type C = { re: number; im: number };

export const ZERO: C = { re: 0, im: 0 };

export function c(re: number, im = 0): C {
  return { re, im };
}

export function add(a: C, b: C): C {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function sub(a: C, b: C): C {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function mul(a: C, b: C): C {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  };
}

export function div(a: C, b: C): C {
  const d = b.re * b.re + b.im * b.im;
  if (d < 1e-18) return ZERO;
  return {
    re: (a.re * b.re + a.im * b.im) / d,
    im: (a.im * b.re - a.re * b.im) / d,
  };
}

export function conj(a: C): C {
  return { re: a.re, im: -a.im };
}

export function neg(a: C): C {
  return { re: -a.re, im: -a.im };
}

export function scale(a: C, s: number): C {
  return { re: a.re * s, im: a.im * s };
}

export function abs(a: C): number {
  return Math.hypot(a.re, a.im);
}

export function abs2(a: C): number {
  return a.re * a.re + a.im * a.im;
}

export function clampToDisk(a: C, maxR = 0.999): C {
  const n = abs(a);
  if (n <= maxR) return a;
  return scale(a, maxR / n);
}
