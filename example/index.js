/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as THREE from 'three';

import { ActionRecorder, XRDevice, metaQuest3 } from 'iwer';

import { DevUI } from '@iwer/devui';
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

const prepare = async () => {
	const nativeVRSupport = navigator.xr
		? await navigator.xr.isSessionSupported('immersive-vr')
		: false;
	if (!nativeVRSupport) {
		xrdevice = new XRDevice(metaQuest3);
		xrdevice.ipd = 0;
		xrdevice.installRuntime({polyfillLayers: false});
		xrdevice.installDevUI(DevUI)
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
	container = document.getElementById('scene-container');
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
