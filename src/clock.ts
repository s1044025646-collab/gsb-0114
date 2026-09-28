export interface Clock {
  now(): number; // epoch ms
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FixedClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Rng {
  next(): number; // [0,1)
}

/** Deterministic seeded RNG (mulberry32) so tests/demos never depend on real randomness. */
export class SeededRng implements Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
