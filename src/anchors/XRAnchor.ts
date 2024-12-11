/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { PRIVATE as XRSESSION_PRIVATE, XRSession } from '../session/XRSession';
import { PRIVATE as XRSPACE_PRIVATE, XRSpace } from '../spaces/XRSpace';

import { PRIVATE as XRDEVICE_PRIVATE } from '../device/XRDevice';
import { mat4 } from 'gl-matrix';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-anchor');

export class XRAnchor {
	[PRIVATE]: {
		anchorSpace: XRSpace | null;
		session: XRSession;
		deleted: boolean;
	};

	constructor(anchorSpace: XRSpace, session: XRSession) {
		this[PRIVATE] = {
			anchorSpace,
			session,
			deleted: false,
		};
		session[XRSESSION_PRIVATE].trackedAnchors.add(this);
	}

	get anchorSpace() {
		if (this[PRIVATE].deleted) {
			throw new DOMException(
				'XRAnchor has already been deleted.',
				'InvalidStateError',
			);
		}
		return this[PRIVATE].anchorSpace!;
	}

	requestPersistentHandle() {
		return new Promise<string>((resolve, reject) => {
			if (this[PRIVATE].deleted) {
				reject(
					new DOMException(
						'XRAnchor has already been deleted.',
						'InvalidStateError',
					),
				);
			} else {
				const persistentAnchors =
					this[PRIVATE].session[XRSESSION_PRIVATE].persistentAnchors;
				for (const [uuid, anchor] of persistentAnchors.entries()) {
					if (anchor === this) {
						resolve(uuid);
						return;
					}
				}
				const uuid = crypto.randomUUID();
				XRAnchorUtils.createPersistentAnchor(this[PRIVATE].session, this, uuid);
				resolve(uuid);
			}
		});
	}

	delete() {
		if (this[PRIVATE].deleted) {
			return;
		}
		this[PRIVATE].anchorSpace = null;
		this[PRIVATE].deleted = true;
		this[PRIVATE].session[XRSESSION_PRIVATE].trackedAnchors.delete(this);
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
			const globalSpace =
				session[XRSESSION_PRIVATE].device[XRDEVICE_PRIVATE].globalSpace;
			const anchorSpace = new XRSpace(globalSpace, offsetMatrix);
			const anchor = new XRAnchor(anchorSpace, session);
			session[XRSESSION_PRIVATE].persistentAnchors.set(uuid, anchor);
		});
	}

	static createPersistentAnchor(
		session: XRSession,
		anchor: XRAnchor,
		uuid: string,
	) {
		session[XRSESSION_PRIVATE].trackedAnchors.add(anchor);
		session[XRSESSION_PRIVATE].persistentAnchors.set(uuid, anchor);
		const persistentAnchors = JSON.parse(
			localStorage.getItem(PersistentAnchorsStorageKey) || '{}',
		) as { [uuid: string]: mat4 };
		persistentAnchors[uuid] = Array.from(
			anchor[PRIVATE].anchorSpace![XRSPACE_PRIVATE].offsetMatrix,
		) as mat4;
		localStorage.setItem(
			PersistentAnchorsStorageKey,
			JSON.stringify(persistentAnchors),
		);
	}
}
