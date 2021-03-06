import { World } from './world';
import { WorldIsland } from './world-island';
import { Body } from './body';
import { JointInterface } from './joint';
import { ConstraintInterface } from './constraint';

export class IslandsGenerator {
  private island = new WorldIsland(this.world, 0);
  private readonly bodies = new Set<Body>();
  private readonly joints = new Set<JointInterface>();
  private readonly constraints = new Set<ConstraintInterface>();
  private readonly stack = new Array<Body>();

  constructor(private readonly world: World) {}

  resizeIsland(size: number) {
    this.island = new WorldIsland(this.world, size);
  }

  *generateIslands() {
    this.bodies.clear();
    this.joints.clear();
    this.constraints.clear();

    for (let body of this.world.bodies) {
      // Skip processed
      if (this.bodies.has(body)) {
        continue;
      }

      this.island.clear();

      // Depth first dependency traverse
      this.stack.length = 0;
      this.stack.push(body);
      while (this.stack.length) {
        const body = this.stack.pop();

        if (this.bodies.has(body)) {
          continue;
        }

        // Skip static bodies
        if (body.isStatic) {
          this.bodies.add(body);
          continue;
        }

        // joints
        const bodyJoints = this.world.bodyJoints.get(body);
        for (const joint of bodyJoints) {
          if (this.joints.has(joint)) {
            continue;
          }

          for (const constraint of joint) {
            this.island.addConstraint(constraint);
          }

          this.joints.add(joint);

          const second = joint.bodyA === body ? joint.bodyB : joint.bodyA;
          if (!this.bodies.has(second)) {
            this.stack.push(second);
          }
        }

        // concacts
        const bodyContacts = this.world.bodyContacts.get(body);
        for (const contact of bodyContacts) {
          if (this.joints.has(contact)) {
            continue;
          }

          for (const constraint of contact) {
            this.island.addConstraint(constraint);
          }

          this.joints.add(contact);

          const second = contact.bodyA === body ? contact.bodyB : contact.bodyA;
          if (!this.bodies.has(second)) {
            this.stack.push(second);
          }
        }

        // misc/arbitrary constraints
        const bodyConstraints = this.world.bodyConstraints.get(body);
        for (const constraint of bodyConstraints) {
          if (this.constraints.has(constraint)) {
            continue;
          }
          this.island.addConstraint(constraint);
          this.constraints.add(constraint);
        }

        this.island.addBody(body);
        this.bodies.add(body);
      }

      if (this.island.bodies.length) {
        yield this.island;
      }
    }
  }
}
