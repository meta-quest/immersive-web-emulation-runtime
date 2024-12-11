/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_ANCHOR, P_DEVICE, P_SESSION, P_SPACE } from '../private.js';

import { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';
import { mat4 } from 'gl-matrix';

export class XRAnchor {
	[P_ANCHOR]: {
		anchorSpace: XRSpace | null;
		session: XRSession;
		deleted: boolean;
	};

	constructor(anchorSpace: XRSpace, session: XRSession) {
		this[P_ANCHOR] = {
			anchorSpace,
			session,
			deleted: false,
		};
		session[P_SESSION].trackedAnchors.add(this);
	}

	get anchorSpace() {
		if (this[P_ANCHOR].deleted) {
			throw new DOMException(
				'XRAnchor has already been deleted.',
				'InvalidStateError',
			);
		}
		return this[P_ANCHOR].anchorSpace!;
	}

	requestPersistentHandle() {
		return new Promise<string>((resolve, reject) => {
			if (this[P_ANCHOR].deleted) {
				reject(
					new DOMException(
						'XRAnchor has already been deleted.',
						'InvalidStateError',
					),
				);
			} else {
				const persistentAnchors =
					this[P_ANCHOR].session[P_SESSION].persistentAnchors;
				for (const [uuid, anchor] of persistentAnchors.entries()) {
					if (anchor === this) {
						resolve(uuid);
						return;
					}
				}
				const uuid = crypto.randomUUID();
				XRAnchorUtils.createPersistentAnchor(
					this[P_ANCHOR].session,
					this,
					uuid,
				);
				resolve(uuid);
			}
		});
	}

	delete() {
		if (this[P_ANCHOR].deleted) {
			return;
		}
		this[P_ANCHOR].anchorSpace = null;
		this[P_ANCHOR].deleted = true;
		this[P_ANCHOR].session[P_SESSION].trackedAnchors.delete(this);
	}
}

export class XRAnchorSet extends Set<XRAnchor> {}

const PersistentAnchorsStorageKey =
	'@immersive-web-emulation-runtime/persistent-anchors';

export class XRAnchorUtils {
	static recoverPersistentAnchorsFromStorage(session: XRSession) {
		const persistentAnchors = JSON.parse(
			localStorage.getItem(PersistentAnchorsStorageKey) || '{}',
		) as { [uuid: string]: mat4 };
		Object.entries(persistentAnchors).forEach(([uuid, offsetMatrix]) => {
			const globalSpace = session[P_SESSION].device[P_DEVICE].globalSpace;
			const anchorSpace = new XRSpace(globalSpace, offsetMatrix);
			const anchor = new XRAnchor(anchorSpace, session);
			session[P_SESSION].persistentAnchors.set(uuid, anchor);
		});
	}

	static createPersistentAnchor(
		session: XRSession,
		anchor: XRAnchor,
		uuid: string,
	) {
		session[P_SESSION].trackedAnchors.add(anchor);
		session[P_SESSION].persistentAnchors.set(uuid, anchor);
		const persistentAnchors = JSON.parse(
			localStorage.getItem(PersistentAnchorsStorageKey) || '{}',
		) as { [uuid: string]: mat4 };
		persistentAnchors[uuid] = Array.from(
			anchor[P_ANCHOR].anchorSpace![P_SPACE].offsetMatrix,
		) as mat4;
		localStorage.setItem(
			PersistentAnchorsStorageKey,
			JSON.stringify(persistentAnchors),
		);
	}
}
