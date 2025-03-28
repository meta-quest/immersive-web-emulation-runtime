/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as THREE from 'three';

import { XRDevice, metaQuest3 } from 'iwer';

import { ARButton } from 'three/addons/webxr/ARButton.js';
import { DevUI } from '@iwer/devui';
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SyntheticEnvironmentModule } from '@iwer/sem';
import { Text } from 'troika-three-text';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export async function init() {
	let nativeWebXRSupport = false;
	if (navigator.xr) {
		nativeWebXRSupport = await navigator.xr.isSessionSupported('immersive-ar');
	}
	if (!nativeWebXRSupport) {
		const xrDevice = new XRDevice(metaQuest3);
		xrDevice.fovy = (75 / 180) * Math.PI;
		xrDevice.ipd = 0;

		xrDevice.installRuntime();
		xrDevice.installDevUI(DevUI);
		xrDevice.installSEM(SyntheticEnvironmentModule);
		xrDevice.sem.loadDefaultEnvironment('office_large');
	}

	const container = document.createElement('div');
	document.body.appendChild(container);

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x3e3e3e);

	const camera = new THREE.PerspectiveCamera(
		50,
		window.innerWidth / window.innerHeight,
		0.1,
		100,
	);
	camera.position.set(0, 1.6, 3);

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.xr.enabled = true;
	container.appendChild(renderer.domElement);

	const environment = new RoomEnvironment();
	const pmremGenerator = new THREE.PMREMGenerator(renderer);
	scene.environment = pmremGenerator.fromScene(environment).texture;

	const player = new THREE.Group();
	scene.add(player);
	player.add(camera);

	const controllerModelFactory = new XRControllerModelFactory();
	const controllers = {
		left: null,
		right: null,
	};
	for (let i = 0; i < 2; i++) {
		const raySpace = renderer.xr.getController(i);
		const gripSpace = renderer.xr.getControllerGrip(i);
		const hand = renderer.xr.getHand(i);
		const mesh = controllerModelFactory.createControllerModel(gripSpace);
		hand.add(new OculusHandModel(hand));
		scene.add(hand);
		gripSpace.add(mesh);
		player.add(raySpace, gripSpace);
		raySpace.visible = false;
		gripSpace.visible = false;
		gripSpace.addEventListener('connected', (e) => {
			raySpace.visible = true;
			gripSpace.visible = true;
			const handedness = e.data.handedness;
			controllers[handedness] = {
				raySpace,
				gripSpace,
				mesh,
			};
		});
		gripSpace.addEventListener('disconnected', (e) => {
			raySpace.visible = false;
			gripSpace.visible = false;
			const handedness = e.data.handedness;
			controllers[handedness] = null;
		});
	}

	function onWindowResize() {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize(window.innerWidth, window.innerHeight);
	}

	window.addEventListener('resize', onWindowResize);

	const xrEntities = new Map();

	function animate() {
		renderer.render(scene, camera);
		if (renderer.xr.isPresenting) {
			const frame = renderer.xr.getFrame();
			const refSpace = renderer.xr.getReferenceSpace();
			const xrplanes = frame.detectedPlanes ?? new Set();
			xrplanes.forEach((xrplane) => {
				if (!xrEntities.get(xrplane)) {
					const semanticLabel = new Text();
					semanticLabel.text = xrplane.semanticLabel;
					semanticLabel.fontSize = 0.2;
					semanticLabel.font =
						'https://cdn.glitch.global/337aada3-509c-468a-8592-445c95cc3d4d/SpaceMono-Bold.ttf?v=1724389737354';
					semanticLabel.position.z = -2;
					semanticLabel.anchorX = 'center';
					semanticLabel.anchorY = 'middle';
					xrEntities.set(xrplane, semanticLabel);
					const planePose = frame.getPose(xrplane.planeSpace, refSpace);
					semanticLabel.position.copy(planePose.transform.position);
					semanticLabel.quaternion.copy(planePose.transform.orientation);
					scene.add(semanticLabel);
					semanticLabel.userData.lookat = true;
					semanticLabel.frustumCulled = false;
				}
			});

			const xrmeshes = frame.detectedMeshes ?? new Set();
			xrmeshes.forEach((xrmesh) => {
				if (!xrEntities.get(xrmesh)) {
					const geometry = new THREE.BufferGeometry();
					geometry.setAttribute(
						'position',
						new THREE.BufferAttribute(xrmesh.vertices, 3),
					);
					geometry.setIndex(new THREE.BufferAttribute(xrmesh.indices, 1));
					const mesh = new THREE.Mesh(
						geometry,
						new THREE.MeshBasicMaterial({ wireframe: true }),
					);
					xrEntities.set(xrmesh, mesh);
					const meshPose = frame.getPose(xrmesh.meshSpace, refSpace);
					mesh.position.copy(meshPose.transform.position);
					mesh.quaternion.copy(meshPose.transform.orientation);
					scene.add(mesh);
				}
			});
			xrEntities.forEach((object, xrEntity) => {
				const exists = xrmeshes.has(xrEntity) || xrplanes.has(xrEntity);
				if (!exists) {
					object.removeFromParent();
					xrmeshes.delete(xrEntity);
					xrplanes.delete(xrEntity);
				} else if (object.userData.lookat) {
					object.lookAt(camera.position);
				}
			});
		}
	}

	renderer.setAnimationLoop(animate);

	document.body.appendChild(
		ARButton.createButton(renderer, {
			requiredFeatures: ['plane-detection', 'mesh-detection', 'hand-tracking'],
		}),
	);
}

init();
