// WASM SIMD with a real library: Rapier's SIMD build steps a falling ball (module worker).
import RAPIER from '../vendor/rapier.mjs';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1, 10));
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
for (let i = 0; i < 240; i++) world.step();
postMessage({ y: body.translation().y, version: RAPIER.version() });
