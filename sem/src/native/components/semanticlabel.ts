import {
	SemanticLabelMETA,
	semanticLabelMETAToJSON,
} from '../../generated/protos/openxr_scene.js';
import {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './component.js';

import { Mesh } from 'three';

function convertToReadableString(str: string): string {
	return str.toLowerCase().replace(/_/g, ' ').trim();
}

export class SemanticLabelComponent extends SpatialEntityComponent {
	type = SpatialEntityComponentType.SemanticLabel;

	constructor(
		spatialEntity: Mesh,
		private _semanticLabel: SemanticLabelMETA,
	) {
		super(spatialEntity);
		this._spatialEntity.name = convertToReadableString(
			semanticLabelMETAToJSON(_semanticLabel),
		);
	}

	get semanticLabel(): SemanticLabelMETA {
		return this._semanticLabel;
	}

	set semanticLabel(value: SemanticLabelMETA) {
		if (Object.values(SemanticLabelMETA).includes(value)) {
			this._semanticLabel = value;
		} else {
			this._semanticLabel = SemanticLabelMETA.UNRECOGNIZED;
		}
		this._spatialEntity.name = convertToReadableString(
			semanticLabelMETAToJSON(this._semanticLabel),
		);
	}

	get initData() {
		return this._semanticLabel;
	}

	get pbData() {
		return this._semanticLabel;
	}
}
