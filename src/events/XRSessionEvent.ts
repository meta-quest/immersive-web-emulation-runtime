/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRSession } from '../session/XRSession.js';

interface XRSessionEventInit extends EventInit {
	session: XRSession;
}

export class XRSessionEvent extends Event {
	public readonly session: XRSession;

	constructor(type: string, eventInitDict: XRSessionEventInit) {
		super(type, eventInitDict);
		if (!eventInitDict.session) {
			throw new Error('XRSessionEventInit.session is required');
		}
		this.session = eventInitDict.session;
	}
}

export interface XRSessionEventHandler {
	(evt: XRSessionEvent): any;
}
