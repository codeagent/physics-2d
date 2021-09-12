import { vec2 } from 'gl-matrix';

import { csr } from './csr';
import { Body } from './body';
import {
  DistanceConstraint,
  ConstraintInterface,
  ContactConstraint,
  FrictionConstraint,
  LineConstraint,
  AngleConstraint,
  MaxDistanceConstraint
} from './constraint';
import {
  VxSpVxS,
  projectedGussSeidel,
  Vector,
  VcV,
  VpV,
  VmV,
  VpVxS
} from './solver';
import { CollisionDetector } from './detector';
import { Shape } from './collision';
import { MinDistanceConstraint } from '.';

export class World {
  public readonly bodies: Body[] = [];
  public readonly bodyShapeLookup = new WeakMap<Body, Shape>();
  private readonly _jointConstraints: ConstraintInterface[] = [];
  private readonly _contactConstraints: ConstraintInterface[] = [];
  private readonly _frictionConstraints: ConstraintInterface[] = [];
  private readonly collisionDetector: CollisionDetector;

  // "read"/"write" variables
  public positions = new Float32Array(0);
  public velocities = new Float32Array(0);
  public forces = new Float32Array(0);
  public invMasses = new Float32Array(0);

  public get constraints() {
    return this._jointConstraints.concat(
      this._contactConstraints,
      this._frictionConstraints
    );
  }

  // "helper" variables
  private _accelerations = new Float32Array(0);
  private _c0Forces = new Float32Array(0);
  private _cvForces = new Float32Array(0);
  private _tmpForces = new Float32Array(0);
  private _tmpVelocities = new Float32Array(0);

  private _lambdaCache0 = new Float32Array(0);
  private _lambdaCache1 = new Float32Array(0);

  constructor(
    public gravity = vec2.fromValues(0.0, -9.8),
    public pushFactor = 0.6,
    public iterations = 50,
    public friction = 0.5,
    public restitution = 0.5
  ) {
    this.collisionDetector = new CollisionDetector(this);
  }

  createBody(
    shape: Shape,
    mass: number,
    intertia: number,
    position: vec2,
    angle: number
  ) {
    const bodyIndex = this.bodies.length;
    const body = new Body(this, bodyIndex);
    this.bodies.push(body);
    this.bodyShapeLookup.set(body, shape);

    const n = this.bodies.length * 3;

    if (this.positions.length < n) {
      const tmp = new Float32Array(this.positions.length + 3);
      tmp.set(this.positions);
      this.positions = tmp;
    }

    if (this.velocities.length < n) {
      const tmp = new Float32Array(this.velocities.length + 3);
      tmp.set(this.velocities);
      this.velocities = tmp;
    }

    if (this.forces.length < n) {
      const tmp = new Float32Array(this.forces.length + 3);
      tmp.set(this.forces);
      this.forces = tmp;
    }

    if (this.invMasses.length < n) {
      const tmp = new Float32Array(this.invMasses.length + 3);
      tmp.set(this.invMasses);
      this.invMasses = tmp;
    }

    this.invMasses[bodyIndex * 3] = 1.0 / mass;
    this.invMasses[bodyIndex * 3 + 1] = 1.0 / mass;
    this.invMasses[bodyIndex * 3 + 2] = 1.0 / intertia;

    this.positions[bodyIndex * 3] = position[0];
    this.positions[bodyIndex * 3 + 1] = position[1];
    this.positions[bodyIndex * 3 + 2] = angle;

    this._accelerations = new Float32Array(n);
    this._c0Forces = new Float32Array(n);
    this._cvForces = new Float32Array(n);
    this._tmpVelocities = new Float32Array(n);
    this._tmpForces = new Float32Array(n);

    body.updateTransform();

    this.collisionDetector.registerBody(body);

    return body;
  }

  destroyBody(body: Body) {
    const bodyIndex = this.bodies.indexOf(body);
    if (bodyIndex === -1) {
      return;
    }
    this.bodies.splice(bodyIndex, 1);

    const size = this.bodies.length * 3;
    const newPositions = new Float32Array(size);
    const newVelocities = new Float32Array(size);
    const newForces = new Float32Array(size);
    const newInvMasses = new Float32Array(size);

    this._accelerations = new Float32Array(size);
    this._c0Forces = new Float32Array(size);
    this._cvForces = new Float32Array(size);
    this._tmpForces = new Float32Array(size);
    this._tmpVelocities = new Float32Array(size);

    newPositions.set([
      ...this.positions.subarray(0, bodyIndex * 3),
      ...this.positions.subarray((bodyIndex + 1) * 3)
    ]);
    newVelocities.set([
      ...this.velocities.subarray(0, bodyIndex * 3),
      ...this.velocities.subarray((bodyIndex + 1) * 3)
    ]);
    newForces.set([
      ...this.forces.subarray(0, bodyIndex * 3),
      ...this.forces.subarray((bodyIndex + 1) * 3)
    ]);
    newInvMasses.set([
      ...this.invMasses.subarray(0, bodyIndex * 3),
      ...this.invMasses.subarray((bodyIndex + 1) * 3)
    ]);

    this.positions = newPositions;
    this.velocities = newVelocities;
    this.forces = newForces;
    this.invMasses = newInvMasses;
  }

  simulate(dt: number) {
    this.applyGlobalForces();
    this.detectCollisions();

    if (this.constraints.length) {
      // Resolve
      this.solveConstraints(this._cvForces, dt, this.pushFactor);
      this.solveConstraints(this._c0Forces, dt, 0.0);

      //  Correct positions
      VpV(this._tmpForces, this.forces, this._cvForces);
      VcV(this._tmpVelocities, this.velocities);
      VmV(this._accelerations, this._tmpForces, this.invMasses);
      VpVxS(this._tmpVelocities, this._tmpVelocities, this._accelerations, dt);
      VpVxS(this.positions, this.positions, this._tmpVelocities, dt);

      // Correct velocities
      VpV(this._tmpForces, this.forces, this._c0Forces);
      VmV(this._accelerations, this._tmpForces, this.invMasses);
      VpVxS(this.velocities, this.velocities, this._accelerations, dt);
    } else {
      VmV(this._accelerations, this.forces, this.invMasses);
      VpVxS(this.velocities, this.velocities, this._accelerations, dt);
      VpVxS(this.positions, this.positions, this.velocities, dt);
    }

    this.updateBodiesTransforms();
    this.clearForces();
  }

  addDistanceConstraint(
    bodyA: Body,
    positionA: vec2,
    bodyB: Body,
    positionB: vec2,
    distance: number
  ) {
    this._jointConstraints.push(
      new MaxDistanceConstraint(
        this,
        this.bodies.indexOf(bodyA),
        vec2.clone(positionA),
        this.bodies.indexOf(bodyB),
        vec2.clone(positionB),
        distance
      )
    );

    this._lambdaCache0 = new Float32Array(this._jointConstraints.length);
    this._lambdaCache1 = new Float32Array(this._jointConstraints.length);
  }

  addLineConstraint(
    bodyA: Body,
    jointA: vec2,
    bodyB: Body,
    jointB: vec2,
    localAxis: vec2
  ) {
    this._jointConstraints.push(
      new LineConstraint(
        this,
        this.bodies.indexOf(bodyA),
        vec2.clone(jointA),
        this.bodies.indexOf(bodyB),
        vec2.clone(jointB),
        vec2.clone(localAxis)
      )
    );

    this._lambdaCache0 = new Float32Array(this._jointConstraints.length);
    this._lambdaCache1 = new Float32Array(this._jointConstraints.length);
  }

  addPrismaticJoint(
    bodyA: Body,
    jointA: vec2,
    bodyB: Body,
    jointB: vec2,
    localAxis: vec2,
    refAngle: number
  ) {
    this._jointConstraints.push(
      new LineConstraint(
        this,
        this.bodies.indexOf(bodyA),
        vec2.clone(jointA),
        this.bodies.indexOf(bodyB),
        vec2.clone(jointB),
        vec2.clone(localAxis)
      )
    );

    this._jointConstraints.push(
      new AngleConstraint(
        this,
        this.bodies.indexOf(bodyA),
        this.bodies.indexOf(bodyB),
        refAngle
      )
    );

    this._jointConstraints.push(
      new MaxDistanceConstraint(
        this,
        this.bodies.indexOf(bodyA),
        vec2.clone(jointA),
        this.bodies.indexOf(bodyB),
        vec2.clone(jointB),
        10
      )
    );

    this._jointConstraints.push(
      new MinDistanceConstraint(
        this,
        this.bodies.indexOf(bodyA),
        vec2.clone(jointA),
        this.bodies.indexOf(bodyB),
        vec2.clone(jointB),
        5
      )
    );

    this._lambdaCache0 = new Float32Array(this._jointConstraints.length);
    this._lambdaCache1 = new Float32Array(this._jointConstraints.length);
  }

  removeConstraint(constraint: ConstraintInterface) {
    const indexOf = this._jointConstraints.indexOf(constraint);

    if (indexOf === -1) {
      return;
    }

    this._jointConstraints.splice(indexOf, 1);
    this._lambdaCache0 = new Float32Array(this._jointConstraints.length);
    this._lambdaCache1 = new Float32Array(this._jointConstraints.length);
  }

  private detectCollisions() {
    this._contactConstraints.length = 0;
    this._frictionConstraints.length = 0;

    for (const contact of this.collisionDetector.detectCollisions()) {
      this._contactConstraints.push(
        new ContactConstraint(
          this,
          contact.bodyAIndex,
          contact.bodyBIndex,
          contact.point,
          contact.normal,
          contact.depth
        )
      );

      if (this.friction) {
        this._frictionConstraints.push(
          new FrictionConstraint(
            this,
            contact.bodyAIndex,
            contact.bodyBIndex,
            contact.point,
            contact.normal,
            this.friction
          )
        );
      }
    }
  }

  private solveConstraints(out: Vector, dt: number, pushFactor: number) {
    // friction constraints are not involved in position correction
    const constraints = this._jointConstraints
      .concat(this._contactConstraints)
      .concat(!pushFactor ? this._frictionConstraints : []);

    const n = this.bodies.length * 3;
    const c = constraints.length;

    const J = new Float32Array(n * c);
    const v = new Float32Array(c);
    const cMin = new Float32Array(c);
    const cMax = new Float32Array(c);
    // const A = new Float32Array(c * c);
    const lambdas = new Float32Array(c);
    const b = new Float32Array(c);
    const bhat = new Float32Array(n);

    const cache = pushFactor ? this._lambdaCache0 : this._lambdaCache1;
    const initialGuess = new Float32Array(c);
    initialGuess.set(cache);

    let i = 0;
    let j = 0;
    for (const constraint of constraints) {
      J.set(constraint.getJacobian(), i);
      v[j] = constraint.getPushFactor(dt, pushFactor);
      const { min, max } = constraint.getClamping();
      cMin[j] = min;
      cMax[j] = max;
      i += n;
      j++;
    }

    // A = J * Minv * Jt
    // b = 1.0 / ∆t * v − J * (1 / ∆t * v1 + Minv * fext)

    const csrJ = csr.compress(J, c);

    const csrA = csr.MxDxMtCsr(csrJ, this.invMasses);
    // csr.MxDxMt(A, csrJ, this.invMasses);
    // const csrA = csr.compress(A, c)

    VmV(bhat, this.invMasses, this.forces);
    VpVxS(bhat, bhat, this.velocities, 1.0 / dt);
    csr.MxV(b, csrJ, bhat);
    VxSpVxS(b, v, 1.0 / dt, b, -1.0);

    projectedGussSeidel(lambdas, csrA, b, cache, cMin, cMax, this.iterations);
    cache.set(lambdas.subarray(0, this._jointConstraints.length));
    csr.MtxV(out, csrJ, lambdas);
  }

  private applyGlobalForces() {
    let i = 0;
    while (i < this.forces.length) {
      if (!Number.isFinite(this.bodies[i / 3].mass)) {
        i += 3;
        continue;
      }
      this.forces[i] += this.bodies[i / 3].mass * this.gravity[0];
      this.forces[i + 1] += this.bodies[i / 3].mass * this.gravity[1];
      i += 3;
    }
  }

  private clearForces() {
    this.forces.fill(0.0);
  }

  private updateBodiesTransforms() {
    this.bodies.forEach(b => b.updateTransform());
  }
}
