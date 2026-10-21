import { mat4, vec3, vec4 } from 'gl-matrix';

import { P_RAY } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { convertDOMPointInit } from '../utils/DOMPointInit.js';

class DOMPointReadOnly {
  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
    public w: number = 1,
  ) {}
}

export class XRRay {
  [P_RAY]: {
    origin: DOMPointReadOnly;
    direction: DOMPointReadOnly;
    matrix: Float32Array | null;
  };

  constructor(
    origin?: DOMPointInit | XRRigidTransform,
    direction?: DOMPointInit,
  ) {
    let _origin = { x: 0, y: 0, z: 0, w: 1 };
    let _direction = { x: 0, y: 0, z: -1, w: 0 };

    if (origin instanceof XRRigidTransform) {
      const transform = origin;
      const matrix = transform.matrix;
      const originVec4 = vec4.set(
        vec4.create(),
        _origin.x!,
        _origin.y!,
        _origin.z!,
        _origin.w!,
      );
      const directionVec4 = vec4.set(
        vec4.create(),
        _direction.x!,
        _direction.y!,
        _direction.z!,
        _direction.w!,
      );
      vec4.transformMat4(originVec4, originVec4, matrix);
      vec4.transformMat4(directionVec4, directionVec4, matrix);
      _origin.x = originVec4[0];
      _origin.y = originVec4[1];
      _origin.z = originVec4[2];
      _origin.w = originVec4[3];
      _direction.x = directionVec4[0];
      _direction.y = directionVec4[1];
      _direction.z = directionVec4[2];
      _direction.w = directionVec4[3];
    } else {
      _origin = convertDOMPointInit(origin);
      _direction = convertDOMPointInit(direction, -1, 0, true);
      if (_direction.x === 0 && _direction.y === 0 && _direction.z === 0) {
        throw new TypeError('XRRay direction must have nonzero length');
      }
      if (_direction.w !== 0) {
        throw new TypeError('XRRay direction.w must be 0');
      }
      if (_origin.w !== 1) {
        throw new TypeError('XRRay origin.w must be 1');
      }
    }

    const length =
      Math.sqrt(
        _direction.x! * _direction.x! +
          _direction.y! * _direction.y! +
          _direction.z! * _direction.z!,
      ) || 1;
    _direction.x = _direction.x! / length;
    _direction.y = _direction.y! / length;
    _direction.z = _direction.z! / length;

    this[P_RAY] = {
      origin: new DOMPointReadOnly(
        _origin.x!,
        _origin.y!,
        _origin.z!,
        _origin.w!,
      ),
      direction: new DOMPointReadOnly(
        _direction.x!,
        _direction.y!,
        _direction.z!,
        _direction.w!,
      ),
      matrix: null,
    };
  }

  get origin(): DOMPointReadOnly {
    return this[P_RAY].origin;
  }

  get direction(): DOMPointReadOnly {
    return this[P_RAY].direction;
  }

  get matrix(): Float32Array {
    if (this[P_RAY].matrix) {
      return this[P_RAY].matrix;
    }
    const z = vec3.set(vec3.create(), 0, 0, -1);
    const origin = vec3.set(
      vec3.create(),
      this[P_RAY].origin.x,
      this[P_RAY].origin.y,
      this[P_RAY].origin.z,
    );
    const direction = vec3.set(
      vec3.create(),
      this[P_RAY].direction.x,
      this[P_RAY].direction.y,
      this[P_RAY].direction.z,
    );
    const axis = vec3.cross(vec3.create(), direction, z);
    const cosAngle = vec3.dot(direction, z);
    const rotation = mat4.create();
    if (cosAngle > -1 && cosAngle < 1) {
      mat4.fromRotation(rotation, Math.acos(cosAngle), axis);
    } else if (cosAngle === -1) {
      mat4.fromRotation(
        rotation,
        Math.acos(cosAngle),
        vec3.set(vec3.create(), 1, 0, 0),
      );
    } else {
      mat4.identity(rotation);
    }

    const translation = mat4.fromTranslation(mat4.create(), origin);
    const matrix = mat4.multiply(mat4.create(), translation, rotation);
    this[P_RAY].matrix = new Float32Array(matrix);
    return this[P_RAY].matrix;
  }
}
