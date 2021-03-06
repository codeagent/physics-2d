import {
  ConstraintInterface,
  ConstraintClamping,
} from './constraint.interface';

export abstract class ConstraintBase implements ConstraintInterface {
  private readonly cache: number[] = [0.0, 0.0];

  getCache(id: 0 | 1): number {
    return this.cache[id];
  }

  setCache(id: 0 | 1, value: number): void {
    this.cache[id] = value;
  }

  abstract getJacobian(out: Float32Array, offset: number, length: number): void;
  abstract getPushFactor(dt: number, strength: number): number;
  abstract getClamping(): ConstraintClamping;
}
