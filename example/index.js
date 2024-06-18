/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as THREE from 'three';
import * as dat from 'dat.gui';

import { ActionRecorder, XRDevice, metaQuest3 } from 'iwer';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { capture } from './cap.min.js';

let container;
let camera, scene, renderer;
let hand1, hand2;
let controller1, controller2;
let controllerGrip1, controllerGrip2;
let controls;
let xrdevice;
let recorder;
let recording = false;
let gui;

const prepare = async () => {
	const nativeVRSupport = navigator.xr
		? await navigator.xr.isSessionSupported('immersive-vr')
		: false;
	if (!nativeVRSupport) {
		xrdevice = new XRDevice(metaQuest3);
		xrdevice.ipd = 0;
		xrdevice.installRuntime();

		gui = new dat.GUI({ name: 'My GUI' });
		gui.domElement.parentElement.style.zIndex = '999999';
		gui.domElement.style.display = 'none';
		const deviceState = {
			blurred: false,
			hands: false,
			left: true,
			right: true,
		};
		const stereoControl = gui
			.add(xrdevice, 'stereoEnabled')
			.name('stereo rendering');
		stereoControl.onChange(() => {
			ipdControl.domElement.parentElement.parentElement.style.display =
				xrdevice.stereoEnabled ? 'block' : 'none';
		});
		const ipdControl = gui.add(xrdevice, 'ipd', 0, 0.08, 0.001);
		gui.add(xrdevice, 'fovy', Math.PI / 4, Math.PI / 1.1, 0.01).name('fov-y');
		gui.add(deviceState, 'blurred').onChange(() => {
			xrdevice.updateVisibilityState(
				deviceState.blurred ? 'visible-blurred' : 'visible',
			);
		});
		gui.add(deviceState, 'hands').onChange(() => {
			xrdevice.primaryInputMode = deviceState.hands ? 'hand' : 'controller';
		});

		const selectValues = {
			left: 0,
			right: 0,
		};

		const createInputControl = (handedness, step) => {
			const inputSwitch = gui
				.add(deviceState, handedness)
				.name(handedness + ' connected');
			const selectControl = gui
				.add(selectValues, handedness, 0, 1, step)
				.name(handedness + ' select');
			selectControl.onChange(() => {
				if (deviceState.hands) {
					xrdevice.hands[handedness].updatePinchValue(selectValues[handedness]);
				} else {
					xrdevice.controllers[handedness].updateButtonValue(
						'trigger',
						selectValues[handedness],
					);
				}
			});
			inputSwitch.onChange(() => {
				selectControl.domElement.parentElement.parentElement.style.display =
					deviceState[handedness] ? 'block' : 'none';
				if (deviceState.hands) {
					xrdevice.hands[handedness].connected = deviceState[handedness];
				} else {
					xrdevice.controllers[handedness].connected = deviceState[handedness];
				}
			});
		};

		['left', 'right'].forEach((handedness) => {
			createInputControl(handedness, 0.01);
		});

		const playRecording = () => {
			window.player.play();
		};
		gui.add({ playRecording }, 'playRecording').name('play input recording');

		const exitVR = () => {
			const session = renderer.xr?.getSession();
			session?.end();
		};
		gui.add({ exitVR }, 'exitVR').name('exit immersive');
	}
	Array.from(document.getElementsByClassName('native')).forEach((el) => {
		el.style.display = nativeVRSupport ? 'block' : 'none';
	});
	Array.from(document.getElementsByClassName('emulated')).forEach((el) => {
		el.style.display = nativeVRSupport ? 'none' : 'block';
	});
};

prepare().then(() => {
	init();
	animate();
});

function init() {
	container = document.createElement('div');
	document.body.appendChild(container);

	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x444444);

	camera = new THREE.PerspectiveCamera(
		50,
		window.innerWidth / window.innerHeight,
		0.1,
		10,
	);
	camera.position.set(0, 1.6, 3);

	controls = new OrbitControls(camera, container);
	controls.target.set(0, 1.6, 0);
	controls.update();

	const floorGeometry = new THREE.PlaneGeometry(4, 4);
	const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x666666 });
	const floor = new THREE.Mesh(floorGeometry, floorMaterial);
	floor.rotation.x = -Math.PI / 2;
	floor.receiveShadow = true;
	scene.add(floor);

	scene.add(new THREE.HemisphereLight(0xbcbcbc, 0xa5a5a5, 3));

	const light = new THREE.DirectionalLight(0xffffff, 3);
	light.position.set(0, 6, 0);
	light.castShadow = true;
	light.shadow.camera.top = 2;
	light.shadow.camera.bottom = -2;
	light.shadow.camera.right = 2;
	light.shadow.camera.left = -2;
	light.shadow.mapSize.set(4096, 4096);
	scene.add(light);

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = true;
	renderer.xr.enabled = true;

	container.appendChild(renderer.domElement);

	const sessionInit = {
		requiredFeatures: ['hand-tracking'],
	};

	document.body.appendChild(VRButton.createButton(renderer, sessionInit));

	// controllers

	controller1 = renderer.xr.getController(0);
	scene.add(controller1);

	controller2 = renderer.xr.getController(1);
	scene.add(controller2);

	const controllerModelFactory = new XRControllerModelFactory();
	const handModelFactory = new XRHandModelFactory();

	// Hand 1
	controllerGrip1 = renderer.xr.getControllerGrip(0);
	controllerGrip1.add(
		controllerModelFactory.createControllerModel(controllerGrip1),
	);
	scene.add(controllerGrip1);

	hand1 = renderer.xr.getHand(0);
	hand1.add(handModelFactory.createHandModel(hand1));

	scene.add(hand1);

	// Hand 2
	controllerGrip2 = renderer.xr.getControllerGrip(1);
	controllerGrip2.add(
		controllerModelFactory.createControllerModel(controllerGrip2),
	);
	scene.add(controllerGrip2);

	hand2 = renderer.xr.getHand(1);
	hand2.add(handModelFactory.createHandModel(hand2));
	scene.add(hand2);

	// cubes
	const cubeGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
	const cubeMaterial = new THREE.MeshMatcapMaterial({
		color: 'red',
	});
	const cube1 = new THREE.Mesh(cubeGeometry, cubeMaterial);
	cube1.position.set(0, 1.5, -0.4);
	scene.add(cube1);

	const cube2 = new THREE.Mesh(cubeGeometry, cubeMaterial);
	cube2.position.set(-0.4, 1.5, -0.4);
	scene.add(cube2);

	const cube3 = new THREE.Mesh(cubeGeometry, cubeMaterial);
	cube3.position.set(0.4, 1.5, -0.4);
	scene.add(cube3);

	window.addEventListener('resize', onWindowResize);

	renderer.xr.addEventListener('sessionstart', () => {
		const refSpace = renderer.xr.getReferenceSpace();
		const session = renderer.xr.getSession();

		if (xrdevice) {
			window.player = xrdevice.createActionPlayer(refSpace, capture);
			gui.domElement.style.display = 'block';
		} else {
			recorder = new ActionRecorder(session, refSpace);
			session.onselect = (event) => {
				if (
					event.inputSource.handedness === 'right' &&
					!event.inputSource.hand
				) {
					recording = !recording;
					if (!recording) {
						recorder.log();
						recorder = new ActionRecorder(session, refSpace);
					}
				}
			};
		}
	});

	renderer.xr.addEventListener('sessionend', () => {
		if (xrdevice) {
			gui.domElement.style.display = 'none';
		}
	});
}

function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
	renderer.setAnimationLoop(render);
}

function render() {
	renderer.render(scene, camera);
	if (recorder && recording) {
		recorder.recordFrame(renderer.xr.getFrame());
	}
}
