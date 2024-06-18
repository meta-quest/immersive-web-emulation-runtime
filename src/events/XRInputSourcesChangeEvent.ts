/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRInputSource } from '../input/XRInputSource.js';
import { XRSession } from '../session/XRSession.js';

interface XRInputSourcesChangeEventInit extends EventInit {
	session: XRSession;
	added: XRInputSource[];
	removed: XRInputSource[];
}

export class XRInputSourcesChangeEvent extends Event {
	public readonly session: XRSession;
	public readonly added: XRInputSource[];
	public readonly removed: XRInputSource[];

	constructor(type: string, eventInitDict: XRInputSourcesChangeEventInit) {
		super(type, eventInitDict);
		if (!eventInitDict.session) {
			throw new Error('XRInputSourcesChangeEventInit.session is required');
		}
		if (!eventInitDict.added) {
			throw new Error('XRInputSourcesChangeEventInit.added is required');
		}
		if (!eventInitDict.removed) {
			throw new Error('XRInputSourcesChangeEventInit.removed is required');
		}
		this.session = eventInitDict.session;
		this.added = eventInitDict.added;
		this.removed = eventInitDict.removed;
	}
}

export interface XRInputSourcesChangeEventHandler {
	(evt: XRInputSourcesChangeEvent): any;
}
