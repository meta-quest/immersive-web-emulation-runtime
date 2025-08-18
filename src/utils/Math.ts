/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { quat, vec3 } from 'gl-matrix';

/**
 * Wrapper class for gl-matrix vec3
 * Minimal interoperable interface to Vector3 in Three.js and Babylon.js
 */
export class Vector3 {
  vec3: vec3;
  private tempVec3: vec3;

  constructor(x: number = 0, y: number = 0, z: number = 0) {
    this.vec3 = vec3.fromValues(x, y, z);
    this.tempVec3 = vec3.create();
  }

  get x() {
    return this.vec3[0];
  }

  set x(value: number) {
    this.vec3[0] = value;
  }

  get y() {
    return this.vec3[1];
  }

  set y(value: number) {
    this.vec3[1] = value;
  }

  get z() {
    return this.vec3[2];
  }

  set z(value: number) {
    this.vec3[2] = value;
  }

  set(x: number, y: number, z: number): this {
    vec3.set(this.vec3, x, y, z);
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  copy(v: Vector3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    this.z = Math.round(this.z);
    return this;
  }

  normalize(): this {
    vec3.copy(this.tempVec3, this.vec3);
    vec3.normalize(this.vec3, this.tempVec3);
    return this;
  }

  add(v: Vector3): this {
    vec3.copy(this.tempVec3, this.vec3);
    vec3.add(this.vec3, this.tempVec3, v.vec3);
    return this;
  }

  applyQuaternion(q: Quaternion): this {
    vec3.copy(this.tempVec3, this.vec3);
    vec3.transformQuat(this.vec3, this.tempVec3, q.quat);
    return this;
  }
}

/**
 * Wrapper class for gl-matrix quat4
 * Minimal interoperable interface to Vector3 in Three.js and Babylon.js
 */
export class Quaternion {
  quat: quat;
  private tempQuat: quat;

  constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 1) {
    this.quat = quat.fromValues(x, y, z, w);
    this.tempQuat = quat.create();
  }

  get x() {
    return this.quat[0];
  }

  set x(value: number) {
    this.quat[0] = value;
  }

  get y() {
    return this.quat[1];
  }

  set y(value: number) {
    this.quat[1] = value;
  }

  get z() {
    return this.quat[2];
  }

  set z(value: number) {
    this.quat[2] = value;
  }

  get w() {
    return this.quat[3];
  }

  set w(value: number) {
    this.quat[3] = value;
  }

  set(x: number, y: number, z: number, w: number): this {
    quat.set(this.quat, x, y, z, w);
    return this;
  }

  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  copy(q: Quaternion): this {
    quat.set(this.quat, q.x, q.y, q.z, q.w);
    return this;
  }

  normalize(): this {
    quat.copy(this.tempQuat, this.quat);
    quat.normalize(this.quat, this.tempQuat);
    return this;
  }

  invert(): this {
    quat.copy(this.tempQuat, this.quat);
    quat.conjugate(this.quat, this.tempQuat);
    return this;
  }

  multiply(q: Quaternion): this {
    quat.copy(this.tempQuat, this.quat);
    quat.multiply(this.quat, this.tempQuat, q.quat);
    return this;
  }

  setFromAxisAngle(axis: Vector3, angle: number): this {
    quat.setAxisAngle(this.quat, axis.vec3, angle);
    return this;
  }
}
