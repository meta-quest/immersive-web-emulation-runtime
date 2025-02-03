/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
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
import { TransformHandles, TransformHandlesMode } from '@pmndrs/handle';

import { XRDevice } from 'iwer';
import { forwardHtmlEvents } from '@pmndrs/pointer-events';

export const PRIVATE = Symbol('@@iwer/devui/input-scene');
const FREE_MOVEMENT_SPEED = 2;

type Handedness = 'left' | 'right';

export class InputLayer {
	public transformHandles: Map<Handedness, TransformHandles>;
	public combinedCameraPosition: Vector3 = new Vector3();

	private renderer: WebGLRenderer;
	private scene: Scene;
	private camera: PerspectiveCamera;
	private playerRig: Group;
	private cameraRig: Group;
	private isPointerLocked: boolean = false;
	private vec3: Vector3 = new Vector3();
	private quat: Quaternion = new Quaternion();
	private mouseMoveHandler: (event: MouseEvent) => void;
	private headsetDefaultPosition: Vector3;
	private headsetDefaultQuaternion: Quaternion;
	private keyState: { [key: string]: boolean } = {
		ShiftLeft: false,
		KeyW: false,
		KeyA: false,
		KeyS: false,
		KeyD: false,
		ArrowUp: false,
		ArrowDown: false,
	};
	private forwardHtmlEvents: () => void;
	private lastTime: number = 0;

	constructor(private xrDevice: XRDevice) {
		this.scene = new Scene();
		this.camera = new PerspectiveCamera(
			50,
			window.innerWidth / window.innerHeight,
			0.1,
			40,
		);

		this.playerRig = new Group();
		this.cameraRig = new Group();
		this.scene.add(this.playerRig);
		this.playerRig.add(this.cameraRig);
		this.cameraRig.position.fromArray(xrDevice.position.vec3);
		this.cameraRig.quaternion.fromArray(xrDevice.quaternion.quat);
		this.cameraRig.add(this.camera);
		this.camera.position.x -= xrDevice.ipd / 2;

		const spaceOriginIndicator = new Mesh(
			new RingGeometry(0.25, 0.27, 32),
			new MeshBasicMaterial({
				color: 0xffffff,
				side: FrontSide,
			}),
		);
		spaceOriginIndicator.rotateX(-Math.PI / 2);
		this.scene.add(spaceOriginIndicator);

		// Create a renderer
		this.renderer = new WebGLRenderer({ alpha: true });
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.setClearColor(0x000000, 0);

		this.renderer.domElement.style.position = 'fixed';
		this.renderer.domElement.style.top = '50vh';
		this.renderer.domElement.style.left = '50vw';
		this.renderer.domElement.style.transform = 'translate(-50%, -50%)';

		this.transformHandles = new Map<Handedness, TransformHandles>();
		(['left', 'right'] as Handedness[]).forEach((handedness) => {
			const transformHandle = new TransformHandles();
			transformHandle.scale.setScalar(0.1);
			transformHandle.position.fromArray(
				xrDevice.controllers[handedness]!.position.vec3,
			);
			transformHandle.quaternion.fromArray(
				xrDevice.controllers[handedness]!.quaternion.quat,
			);
			this.cameraRig.attach(transformHandle);
			transformHandle.userData = {
				defaultPosition: transformHandle.position.toArray(),
				defaultQuaternion: transformHandle.quaternion.toArray(),
			};
			transformHandle.userData.setMode = (mode: TransformHandlesMode) => {
				transformHandle.userData.modeCleanup?.();
				transformHandle.userData.modeCleanup = transformHandle.bind(mode);
				transformHandle.userData.mode = mode;
			};
			transformHandle.userData.setMode('translate');
			transformHandle.space = 'local';
			this.transformHandles.set(handedness, transformHandle);
			transformHandle.addEventListener('click' as any, () => {
				if (transformHandle.userData.mode === 'translate') {
					transformHandle.userData.setMode('rotate');
				} else {
					transformHandle.userData.setMode('translate');
				}
			});
		});

		// @ts-ignore
		window.transformHandles = this.transformHandles;

		this.mouseMoveHandler = (event: MouseEvent) => {
			if (!this.isPointerLocked) return;
			const movementX =
				// @ts-ignore
				event.movementX || event.mozMovementX || event.webkitMovementX || 0;
			const movementY =
				// @ts-ignore
				event.movementY || event.mozMovementY || event.webkitMovementY || 0;
			this.playerRig.rotation.y -= movementX * 0.002;
			this.cameraRig.rotation.x -= movementY * 0.002;

			xrDevice.quaternion.copy(
				this.cameraRig.getWorldQuaternion(new Quaternion()) as any,
			);
		};

		this.cameraRig.getWorldPosition(this.combinedCameraPosition);
		this.headsetDefaultPosition = this.cameraRig.position.clone();
		this.headsetDefaultQuaternion = this.cameraRig.quaternion.clone();
		this.forwardHtmlEvents = forwardHtmlEvents(
			this.renderer.domElement,
			() => this.camera,
			this.scene,
		).update;

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
		this.renderer.domElement.requestPointerLock =
			this.renderer.domElement.requestPointerLock ||
			// @ts-ignore
			this.renderer.domElement.mozRequestPointerLock ||
			// @ts-ignore
			this.renderer.domElement.webkitRequestPointerLock;
		this.renderer.domElement.requestPointerLock();
	}

	pointerLockChangeHandler() {
		this.isPointerLocked =
			document.pointerLockElement === this.renderer.domElement ||
			// @ts-ignore
			document.mozPointerLockElement === this.renderer.domElement ||
			// @ts-ignore
			document.webkitPointerLockElement === this.renderer.domElement;

		if (this.isPointerLocked) {
			document.addEventListener('mousemove', this.mouseMoveHandler, false);
			Object.values(this.transformHandles).forEach((transformHandle) => {
				transformHandle.visible = false;
			});
		} else {
			document.removeEventListener('mousemove', this.mouseMoveHandler, false);
			Object.values(this.transformHandles).forEach((transformHandle) => {
				transformHandle.visible = true;
			});
		}
	}

	keyDownHandler(event: KeyboardEvent) {
		const { keyState } = this;

		if (event.code in keyState) {
			keyState[event.code] = true;
		}

		if (keyState.ShiftLeft && keyState.ArrowUp) {
			this.cameraRig.position.y += 0.05;
		}

		if (keyState.ShiftLeft && keyState.ArrowDown) {
			this.cameraRig.position.y -= 0.05;
		}
	}

	keyUpHandler(event: KeyboardEvent) {
		const { keyState } = this;

		if (event.code in keyState) {
			keyState[event.code] = false;
		}
	}

	movePlayerRig(delta: number) {
		const { playerRig, keyState, vec3 } = this;
		vec3.set(
			(keyState.KeyD ? 1 : 0) - (keyState.KeyA ? 1 : 0),
			0,
			(keyState.KeyS ? 1 : 0) - (keyState.KeyW ? 1 : 0),
		);
		if (vec3.lengthSq() > 0 && keyState.ShiftLeft) {
			vec3
				.normalize()
				.multiplyScalar(FREE_MOVEMENT_SPEED * delta)
				.applyQuaternion(playerRig.quaternion);
			playerRig.position.add(vec3);
		}
	}

	resetDeviceTransforms() {
		const { playerRig, cameraRig, transformHandles } = this;
		cameraRig.position.copy(this.headsetDefaultPosition);
		cameraRig.quaternion.copy(this.headsetDefaultQuaternion);
		playerRig.position.set(0, 0, 0);
		playerRig.quaternion.set(0, 0, 0, 1);
		transformHandles.forEach((transformHandle) => {
			transformHandle.position.fromArray(
				transformHandle.userData.defaultPosition,
			);
			transformHandle.quaternion.fromArray(
				transformHandle.userData.defaultQuaternion,
			);
		});
	}

	syncDeviceTransforms() {
		const { xrDevice, cameraRig, transformHandles } = this;
		xrDevice.position.copy(cameraRig.getWorldPosition(this.vec3) as any);
		xrDevice.quaternion.copy(cameraRig.getWorldQuaternion(this.quat) as any);
		transformHandles.forEach((transformHandle, handedness) => {
			const emulatedInput =
				xrDevice.primaryInputMode === 'controller'
					? xrDevice.controllers[handedness]!
					: xrDevice.hands[handedness]!;
			emulatedInput.position.copy(
				transformHandle.getWorldPosition(this.vec3) as any,
			);
			emulatedInput.quaternion.copy(
				transformHandle.getWorldQuaternion(this.quat) as any,
			);
		});
	}

	renderScene(time: number) {
		const xrDeviceFOV = (this.xrDevice.fovy / Math.PI) * 180;
		let cameraMatrixNeedsUpdate = false;
		if (this.camera.fov !== xrDeviceFOV) {
			this.camera.fov = xrDeviceFOV;
			cameraMatrixNeedsUpdate = true;
		}
		const iwerCanvasDimension = this.xrDevice.canvasDimensions;
		if (iwerCanvasDimension) {
			const canvas = this.renderer.domElement;
			const resizeNeeded =
				canvas.width !== iwerCanvasDimension.width ||
				canvas.height !== iwerCanvasDimension.height;
			if (resizeNeeded) {
				this.camera.aspect =
					iwerCanvasDimension.width / iwerCanvasDimension.height;
				this.renderer.setSize(
					iwerCanvasDimension.width,
					iwerCanvasDimension.height,
				);
				cameraMatrixNeedsUpdate = true;
			}
		}
		if (cameraMatrixNeedsUpdate) {
			this.camera.updateProjectionMatrix();
		}
		if (!this.isPointerLocked) {
			this.cameraRig.position.y = this.combinedCameraPosition.y;
			this.playerRig.position.x = this.combinedCameraPosition.x;
			this.playerRig.position.z = this.combinedCameraPosition.z;
		} else {
			this.cameraRig.getWorldPosition(this.combinedCameraPosition);
		}
		this.forwardHtmlEvents();
		this.transformHandles.forEach((transformHandle, handedness) => {
			const connected = Boolean(
				this.xrDevice.controllers[handedness]?.connected,
			);
			transformHandle.visible = connected && !this.isPointerLocked;
			if (connected) {
				transformHandle.update(time, this.camera);
			}
		});
		const delta = Math.min((time - this.lastTime) / 1000, 0.1);
		this.movePlayerRig(delta);
		this.syncDeviceTransforms();
		this.renderer.render(this.scene, this.camera);
		this.lastTime = time;
	}

	get domElement() {
		return this.renderer.domElement;
	}

	dispose() {
		this.renderer.dispose();
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
		document.removeEventListener('mousemove', this.mouseMoveHandler, false);
		document.removeEventListener(
			'keydown',
			this.keyDownHandler.bind(this),
			false,
		);
		document.removeEventListener('keyup', this.keyUpHandler.bind(this), false);
	}
}
