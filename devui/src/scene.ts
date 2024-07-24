/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	BoxGeometry,
	FrontSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	PerspectiveCamera,
	Quaternion,
	RingGeometry,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';

import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { XRDevice } from 'iwer';

const PRIVATE = Symbol('@@iwer/devui/input-scene');
const FREE_MOVEMENT_SPEED = 0.016;

export class InputLayer {
	[PRIVATE]: {
		canvasContainer: HTMLDivElement;
		renderer: WebGLRenderer;
		scene: Scene;
		camera: PerspectiveCamera;
		playerRig: Group;
		cameraRig: Group;
		resizeObserver: ResizeObserver;
		xrDevice: XRDevice;
		controllerIndicators: { [key in 'left' | 'right']: Mesh };
		transformControls: { [key in 'left' | 'right']: TransformControls };
		isPointerLocked: boolean;
		vec3: Vector3;
		quat: Quaternion;
		mouseMoveHandler: (event: MouseEvent) => void;
		headsetDefaultPosition: Vector3;
		headsetDefaultQuaternion: Quaternion;
		controllerDefaultPositions: { [key in 'left' | 'right']: Vector3 };
		controllerDefaultQuaternions: { [key in 'left' | 'right']: Quaternion };
		keyState: { [key: string]: boolean };
		movePlayerRig: () => void;
		moveInterval: number | null;
	};

	constructor(xrDevice: XRDevice) {
		const canvasContainer = xrDevice.canvasContainer;
		// Create a scene
		const scene = new Scene();

		// Create a camera
		const camera = new PerspectiveCamera(
			(xrDevice.fovy / Math.PI) * 180,
			canvasContainer.offsetWidth / canvasContainer.offsetHeight,
			0.1,
			1000,
		);

		const playerRig = new Group();
		const cameraRig = new Group();
		scene.add(playerRig);
		playerRig.add(cameraRig);
		cameraRig.position.fromArray(xrDevice.position.vec3);
		cameraRig.quaternion.fromArray(xrDevice.quaternion.quat);
		cameraRig.add(camera);
		camera.position.x -= xrDevice.ipd / 2;

		const leftControllerIndicator = new Mesh(new BoxGeometry(0.1, 0.1, 0.1));
		const rightControllerIndicator = leftControllerIndicator.clone();
		leftControllerIndicator.position.fromArray(
			xrDevice.controllers.left!.position.vec3,
		);
		leftControllerIndicator.quaternion.fromArray(
			xrDevice.controllers.left!.quaternion.quat,
		);
		rightControllerIndicator.position.fromArray(
			xrDevice.controllers.right!.position.vec3,
		);
		rightControllerIndicator.quaternion.fromArray(
			xrDevice.controllers.right!.quaternion.quat,
		);
		cameraRig.attach(leftControllerIndicator);
		cameraRig.attach(rightControllerIndicator);
		leftControllerIndicator.visible = false;
		rightControllerIndicator.visible = false;

		const spaceOriginIndicator = new Mesh(
			new RingGeometry(0.25, 0.27, 32),
			new MeshBasicMaterial({
				color: 0xffffff,
				side: FrontSide,
			}),
		);
		spaceOriginIndicator.rotateX(-Math.PI / 2);
		scene.add(spaceOriginIndicator);

		// Create a renderer
		const renderer = new WebGLRenderer({ alpha: true });
		renderer.setSize(canvasContainer.offsetWidth, canvasContainer.offsetHeight);
		renderer.setClearColor(0x000000, 0);
		canvasContainer.appendChild(renderer.domElement);

		const leftTransformControls = new TransformControls(
			camera,
			renderer.domElement,
		);
		leftTransformControls.attach(leftControllerIndicator);
		scene.add(leftTransformControls);

		const rightTransformControls = new TransformControls(
			camera,
			renderer.domElement,
		);
		rightTransformControls.attach(rightControllerIndicator);
		scene.add(rightTransformControls);

		const resizeObserver = new ResizeObserver(() => {
			this.resize();
		});
		resizeObserver.observe(canvasContainer);

		// Event listeners for TransformControls
		const setupTransformControls = (controls: TransformControls) => {
			controls.addEventListener('mouseDown', () => {
				controls.userData.pressStart = performance.now();
			});
			controls.addEventListener('mouseUp', () => {
				const pressTime = performance.now() - controls.userData.pressStart;
				controls.userData.pressStart = null;
				if (pressTime < 200) {
					if (controls.mode === 'rotate') {
						controls.setMode('translate');
					} else {
						controls.setMode('rotate');
					}
				}
			});
			controls.addEventListener('change', () => {
				this.renderScene();
			});
		};

		setupTransformControls(leftTransformControls);
		setupTransformControls(rightTransformControls);

		const mouseMoveHandler = (event: MouseEvent) => {
			if (!this[PRIVATE].isPointerLocked) return;
			const movementX =
				// @ts-ignore
				event.movementX || event.mozMovementX || event.webkitMovementX || 0;
			const movementY =
				// @ts-ignore
				event.movementY || event.mozMovementY || event.webkitMovementY || 0;
			playerRig.rotation.y -= movementX * 0.002;
			cameraRig.rotation.x -= movementY * 0.002;

			xrDevice.quaternion.copy(
				cameraRig.getWorldQuaternion(new Quaternion()) as any,
			);
			this.renderScene();
		};

		this[PRIVATE] = {
			canvasContainer,
			renderer,
			scene,
			camera,
			playerRig,
			cameraRig,
			xrDevice,
			controllerIndicators: {
				left: leftControllerIndicator,
				right: rightControllerIndicator,
			},
			transformControls: {
				left: leftTransformControls,
				right: rightTransformControls,
			},
			headsetDefaultPosition: cameraRig.position.clone(),
			headsetDefaultQuaternion: cameraRig.quaternion.clone(),
			controllerDefaultPositions: {
				left: leftControllerIndicator.position.clone(),
				right: rightControllerIndicator.position.clone(),
			},
			controllerDefaultQuaternions: {
				left: leftControllerIndicator.quaternion.clone(),
				right: rightControllerIndicator.quaternion.clone(),
			},
			resizeObserver,
			isPointerLocked: false,
			vec3: new Vector3(),
			quat: new Quaternion(),
			mouseMoveHandler,
			keyState: {
				ShiftLeft: false,
				KeyW: false,
				KeyA: false,
				KeyS: false,
				KeyD: false,
				ArrowUp: false,
				ArrowDown: false,
			},
			movePlayerRig: () => this.movePlayerRig(),
			moveInterval: null,
		};

		document.addEventListener(
			'pointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);
		document.addEventListener(
			'mozpointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);
		document.addEventListener(
			'webkitpointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);

		document.addEventListener('keydown', this.keyDownHandler.bind(this), false);
		document.addEventListener('keyup', this.keyUpHandler.bind(this), false);
	}

	lockPointer() {
		this[PRIVATE].renderer.domElement.requestPointerLock =
			this[PRIVATE].renderer.domElement.requestPointerLock ||
			// @ts-ignore
			this[PRIVATE].renderer.domElement.mozRequestPointerLock ||
			// @ts-ignore
			this[PRIVATE].renderer.domElement.webkitRequestPointerLock;
		this[PRIVATE].renderer.domElement.requestPointerLock();
	}

	pointerLockChangeHandler() {
		this[PRIVATE].isPointerLocked =
			document.pointerLockElement === this[PRIVATE].renderer.domElement ||
			// @ts-ignore
			document.mozPointerLockElement === this[PRIVATE].renderer.domElement ||
			// @ts-ignore
			document.webkitPointerLockElement === this[PRIVATE].renderer.domElement;

		if (this[PRIVATE].isPointerLocked) {
			document.addEventListener(
				'mousemove',
				this[PRIVATE].mouseMoveHandler,
				false,
			);
			Object.values(this[PRIVATE].transformControls).forEach(
				(transformControls) => {
					transformControls.enabled = false;
					transformControls.visible = false;
				},
			);
		} else {
			document.removeEventListener(
				'mousemove',
				this[PRIVATE].mouseMoveHandler,
				false,
			);
			Object.values(this[PRIVATE].transformControls).forEach(
				(transformControls) => {
					transformControls.enabled = true;
					transformControls.visible = true;
				},
			);
		}
	}

	keyDownHandler(event: KeyboardEvent) {
		const { keyState, movePlayerRig, moveInterval } = this[PRIVATE];

		if (event.code in keyState) {
			keyState[event.code] = true;
		}

		if (
			keyState.ShiftLeft &&
			(keyState.KeyW || keyState.KeyA || keyState.KeyS || keyState.KeyD)
		) {
			if (!moveInterval) {
				this[PRIVATE].moveInterval = window.setInterval(movePlayerRig, 16);
			}
		}

		if (keyState.ShiftLeft && keyState.ArrowUp) {
			this[PRIVATE].cameraRig.position.y += 0.05;
			this.renderScene();
		}

		if (keyState.ShiftLeft && keyState.ArrowDown) {
			this[PRIVATE].cameraRig.position.y -= 0.05;
			this.renderScene();
		}
	}

	keyUpHandler(event: KeyboardEvent) {
		const { keyState, moveInterval } = this[PRIVATE];

		if (event.code in keyState) {
			keyState[event.code] = false;
		}

		if (
			!keyState.ShiftLeft ||
			!(keyState.KeyW || keyState.KeyA || keyState.KeyS || keyState.KeyD)
		) {
			if (moveInterval) {
				window.clearInterval(moveInterval);
				this[PRIVATE].moveInterval = null;
			}
		}
	}

	movePlayerRig() {
		const { playerRig, keyState, vec3 } = this[PRIVATE];
		vec3.set(
			(keyState.KeyD ? 1 : 0) - (keyState.KeyA ? 1 : 0),
			0,
			(keyState.KeyS ? 1 : 0) - (keyState.KeyW ? 1 : 0),
		);
		if (vec3.lengthSq() > 0) {
			vec3
				.normalize()
				.multiplyScalar(FREE_MOVEMENT_SPEED)
				.applyQuaternion(playerRig.quaternion);
			playerRig.position.add(vec3);

			this.renderScene();
		}
	}

	syncFovy() {
		this[PRIVATE].camera.fov = (this[PRIVATE].xrDevice.fovy / Math.PI) * 180;
		this[PRIVATE].camera.updateProjectionMatrix();
	}

	resetDeviceTransforms() {
		const { playerRig, cameraRig, controllerIndicators } = this[PRIVATE];
		cameraRig.position.copy(this[PRIVATE].headsetDefaultPosition);
		cameraRig.quaternion.set(0, 0, 0, 1);
		playerRig.position.set(0, 0, 0);
		playerRig.quaternion.set(0, 0, 0, 1);
		Object.entries(controllerIndicators).forEach(
			([handedness, controllerIndicator]) => {
				controllerIndicator.position.copy(
					// @ts-ignore
					this[PRIVATE].controllerDefaultPositions[handedness],
				);
				controllerIndicator.quaternion.copy(
					// @ts-ignore
					this[PRIVATE].controllerDefaultQuaternions[handedness],
				);
			},
		);
		this.syncDeviceTransforms();
		this.renderScene();
	}

	syncDeviceTransforms() {
		const { xrDevice, cameraRig, controllerIndicators } = this[PRIVATE];
		xrDevice.position.copy(
			cameraRig.getWorldPosition(this[PRIVATE].vec3) as any,
		);
		xrDevice.quaternion.copy(
			cameraRig.getWorldQuaternion(this[PRIVATE].quat) as any,
		);
		Object.entries(controllerIndicators).forEach(
			([handedness, controllerIndicator]) => {
				// @ts-ignore
				xrDevice.controllers[handedness]!.position.copy(
					controllerIndicator.getWorldPosition(this[PRIVATE].vec3) as any,
				);
				// @ts-ignore
				xrDevice.controllers[handedness]!.quaternion.copy(
					controllerIndicator.getWorldQuaternion(this[PRIVATE].quat) as any,
				);
			},
		);
	}

	renderScene() {
		this.syncDeviceTransforms();
		this[PRIVATE].renderer.render(this[PRIVATE].scene, this[PRIVATE].camera);
	}

	get domElement() {
		return this[PRIVATE].renderer.domElement;
	}

	resize() {
		const width = this[PRIVATE].canvasContainer.offsetWidth;
		const height = this[PRIVATE].canvasContainer.offsetHeight;
		this[PRIVATE].renderer.setSize(width, height);
		this[PRIVATE].camera.aspect = width / height;
		this[PRIVATE].camera.updateProjectionMatrix();
		this.renderScene();
	}

	dispose() {
		this[PRIVATE].resizeObserver.disconnect();
		this[PRIVATE].renderer.dispose();
		document.removeEventListener(
			'pointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);
		document.removeEventListener(
			'mozpointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);
		document.removeEventListener(
			'webkitpointerlockchange',
			this.pointerLockChangeHandler.bind(this),
			false,
		);
		document.removeEventListener(
			'mousemove',
			this[PRIVATE].mouseMoveHandler,
			false,
		);
		document.removeEventListener(
			'keydown',
			this.keyDownHandler.bind(this),
			false,
		);
		document.removeEventListener('keyup', this.keyUpHandler.bind(this), false);
	}
}
