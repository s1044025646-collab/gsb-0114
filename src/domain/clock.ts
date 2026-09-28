export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests / demos. */
export class FixedClock implements Clock {
  private current: number;
  constructor(start: Date | number | string = 0) {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }
  set(t: Date | number | string): Date {
    this.current = new Date(t).getTime();
    return this.now();
  }
}

export function iso(d: Date): string {
  return d.toISOString();
}
