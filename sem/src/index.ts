/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export { SpatialEntity, SpatialEntityType } from './native/entity.js';
export { Bounded2DComponent } from './native/components/bounded2d.js';
export { Bounded3DComponent } from './native/components/bounded3d.js';
export {
	SpatialEntityComponent,
	SpatialEntityComponentType,
} from './native/components/component.js';
export { LocatableComponent } from './native/components/locatable.js';
export { SemanticLabelComponent } from './native/components/semanticlabel.js';
export { TriangleMeshComponent } from './native/components/trianglemesh.js';
export { SyntheticEnvironmentModule } from './sem.js';
export { VERSION } from './version.js';
