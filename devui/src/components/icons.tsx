/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Colors, ControlButtonStyles, FAControlIcon } from './styled.js';
import {
	faHandLizard,
	faHandScissors,
} from '@fortawesome/free-solid-svg-icons';

import React from 'react';

const IconSize = ControlButtonStyles.height;

export const ButtonX: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M7 13.125a7 7 0 1 0 14 0v1.75a7 7 0 0 1-14 0v-1.75Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.55}
			d="M14 19.863a6.738 6.738 0 1 0 0-13.476 6.738 6.738 0 0 0 0 13.476Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M16.529 16.1h-.893l-1.653-2.713-1.68 2.713h-.832l2.074-3.255-1.942-2.992h.875l1.531 2.45 1.54-2.45h.831l-1.933 2.975 2.082 3.272Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ButtonY: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M7 13.125a7 7 0 1 0 14 0v1.75a7 7 0 0 1-14 0v-1.75Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.55}
			d="M14 19.863a6.738 6.738 0 1 0 0-13.476 6.738 6.738 0 0 0 0 13.476Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="m14.086 12.924 1.627-3.071h.849l-2.083 3.823V16.1h-.787v-2.389L11.61 9.853h.857l1.619 3.07Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ButtonA: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M7 13.125a7 7 0 1 0 14 0v1.75a7 7 0 0 1-14 0v-1.75Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.55}
			d="M14 19.863a6.738 6.738 0 1 0 0-13.476 6.738 6.738 0 0 0 0 13.476Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="m15.975 16.1-.753-1.934h-2.476l-.744 1.934h-.796l2.441-6.274h.709l2.432 6.274h-.813Zm-1.69-4.524a29.052 29.052 0 0 1-.21-.63 5.175 5.175 0 0 0-.087-.306c-.029.117-.06.236-.096.359-.03.116-.061.224-.096.323-.03.1-.056.184-.079.254l-.709 1.89h1.978l-.7-1.89Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ButtonB: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M7 13.125a7 7 0 1 0 14 0v1.75a7 7 0 0 1-14 0v-1.75Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.55}
			d="M14 19.863a6.738 6.738 0 1 0 0-13.476 6.738 6.738 0 0 0 0 13.476Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.876 9.853c.519 0 .954.05 1.304.148.355.1.62.263.796.49.18.228.271.531.271.91 0 .245-.047.464-.14.656a1.198 1.198 0 0 1-.402.473 1.62 1.62 0 0 1-.648.254v.043c.262.041.499.117.709.228.216.11.385.268.507.473.123.204.184.47.184.796 0 .379-.088.703-.262.971a1.663 1.663 0 0 1-.753.604c-.32.134-.706.201-1.155.201h-2.196V9.853h1.785Zm.157 2.66c.537 0 .905-.085 1.103-.254.198-.175.297-.432.297-.77 0-.344-.122-.59-.367-.735-.24-.152-.624-.228-1.155-.228h-1.033v1.986h1.155Zm-1.155.656v2.266h1.26c.555 0 .94-.108 1.155-.324.216-.216.324-.498.324-.849 0-.221-.05-.414-.149-.577-.093-.163-.254-.289-.481-.376-.222-.093-.525-.14-.91-.14h-1.199Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickL: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={0.5}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M12.642 17.325v-6.247h.787v5.547h2.73v.7h-3.517ZM14.479 6.389a.525.525 0 0 1-.782 0l-2.235-2.495a.525.525 0 0 1 .39-.875h4.47c.454 0 .694.537.391.875L14.478 6.39Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="m13.045 6.711-1.093-1.22a8.75 8.75 0 1 0 4.24.036L15.11 6.733A7.352 7.352 0 0 1 14 21.35a7.35 7.35 0 0 1-.955-14.639Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickR: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={0.7}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.938 11.077c.52 0 .945.068 1.278.202.338.128.59.323.752.586.164.262.245.592.245.989 0 .332-.06.61-.183.83-.123.223-.28.4-.473.535a2.61 2.61 0 0 1-.595.306l1.715 2.8h-.919l-1.513-2.581h-1.243v2.58h-.787v-6.247h1.723Zm-.043.683h-.893v2.319h.936c.339 0 .616-.044.832-.132a.956.956 0 0 0 .472-.402c.105-.175.158-.394.158-.656 0-.274-.056-.493-.167-.657a.905.905 0 0 0-.49-.358c-.221-.076-.504-.114-.848-.114ZM14.479 6.389a.525.525 0 0 1-.782 0l-2.235-2.495a.525.525 0 0 1 .39-.875h4.47c.454 0 .694.537.391.875L14.478 6.39Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="m13.045 6.711-1.093-1.22a8.75 8.75 0 1 0 4.24.036L15.11 6.733A7.352 7.352 0 0 1 14 21.35a7.35 7.35 0 0 1-.955-14.639Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickLUp: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M12.642 17.325v-6.248h.787v5.548h2.73v.7h-3.517ZM13.697.611a.525.525 0 0 1 .782 0l2.234 2.495a.525.525 0 0 1-.39.875h-4.47a.525.525 0 0 1-.391-.875L13.697.61Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickLDown: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M12.642 17.325v-6.248h.787v5.548h2.73v.7h-3.517ZM14.479 27.389a.525.525 0 0 1-.782 0l-2.235-2.495a.525.525 0 0 1 .39-.875h4.47c.454 0 .694.537.391.875l-2.235 2.495Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickLLeft: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M12.642 17.325v-6.248h.787v5.548h2.73v.7h-3.517ZM.611 14.303a.525.525 0 0 1 0-.782l2.495-2.234a.525.525 0 0 1 .875.39v4.47a.525.525 0 0 1-.875.391L.61 14.303Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickLRight: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M12.642 17.325v-6.248h.787v5.548h2.73v.7h-3.517ZM27.389 13.521a.525.525 0 0 1 0 .782l-2.495 2.235a.525.525 0 0 1-.875-.39v-4.47c0-.454.537-.694.875-.391l2.495 2.234Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickRUp: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.938 11.077c.52 0 .945.068 1.278.202.338.128.59.323.752.586.164.262.245.592.245.989 0 .332-.06.61-.183.83-.123.223-.28.4-.473.535a2.61 2.61 0 0 1-.595.306l1.715 2.8h-.919l-1.513-2.581h-1.243v2.58h-.787v-6.247h1.723Zm-.043.683h-.893v2.319h.936c.339 0 .616-.044.832-.132a.956.956 0 0 0 .472-.402c.105-.175.158-.394.158-.656 0-.274-.056-.493-.167-.657a.905.905 0 0 0-.49-.358c-.221-.076-.504-.114-.848-.114ZM13.697.611a.525.525 0 0 1 .782 0l2.234 2.495a.525.525 0 0 1-.39.875h-4.47a.525.525 0 0 1-.391-.875L13.697.61Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickRDown: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.938 11.077c.52 0 .945.068 1.278.202.338.128.59.323.752.586.164.262.245.592.245.989 0 .332-.06.61-.183.83-.123.223-.28.4-.473.535a2.61 2.61 0 0 1-.595.306l1.715 2.8h-.919l-1.513-2.581h-1.243v2.58h-.787v-6.247h1.723Zm-.043.683h-.893v2.319h.936c.339 0 .616-.044.832-.132a.956.956 0 0 0 .472-.402c.105-.175.158-.394.158-.656 0-.274-.056-.493-.167-.657a.905.905 0 0 0-.49-.358c-.221-.076-.504-.114-.848-.114ZM14.479 27.389a.525.525 0 0 1-.782 0l-2.235-2.495a.525.525 0 0 1 .39-.875h4.47c.454 0 .694.537.391.875l-2.235 2.495Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickRLeft: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.938 11.077c.52 0 .945.068 1.278.202.338.128.59.323.752.586.164.262.245.592.245.989 0 .332-.06.61-.183.83-.123.223-.28.4-.473.535a2.61 2.61 0 0 1-.595.306l1.715 2.8h-.919l-1.513-2.581h-1.243v2.58h-.787v-6.247h1.723Zm-.043.683h-.893v2.319h.936c.339 0 .616-.044.832-.132a.956.956 0 0 0 .472-.402c.105-.175.158-.394.158-.656 0-.274-.056-.493-.167-.657a.905.905 0 0 0-.49-.358c-.221-.076-.504-.114-.848-.114ZM.611 14.303a.525.525 0 0 1 0-.782l2.495-2.234a.525.525 0 0 1 .875.39v4.47a.525.525 0 0 1-.875.391L.61 14.303Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbstickRRight: React.FC = ({
	scale = 1.2,
}: {
	scale?: number;
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={1.5}
			d="M14 22.05a8.05 8.05 0 1 0 0-16.1 8.05 8.05 0 0 0 0 16.1Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.75}
			d="M14 19.95a5.95 5.95 0 1 0 0-11.9 5.95 5.95 0 0 0 0 11.9Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M13.938 11.077c.52 0 .945.068 1.278.202.338.128.59.323.752.586.164.262.245.592.245.989 0 .332-.06.61-.183.83-.123.223-.28.4-.473.535a2.61 2.61 0 0 1-.595.306l1.715 2.8h-.919l-1.513-2.581h-1.243v2.58h-.787v-6.247h1.723Zm-.043.683h-.893v2.319h.936c.339 0 .616-.044.832-.132a.956.956 0 0 0 .472-.402c.105-.175.158-.394.158-.656 0-.274-.056-.493-.167-.657a.905.905 0 0 0-.49-.358c-.221-.076-.504-.114-.848-.114ZM27.389 13.521a.525.525 0 0 1 0 .782l-2.495 2.235a.525.525 0 0 1-.875-.39v-4.47c0-.454.537-.694.875-.391l2.495 2.234Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const GripL: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M7.525 7.875c-2.283 1.22-3.82 3.507-3.82 6.125s1.537 4.904 3.82 6.125C4.405 19.425 2.1 16.948 2.1 14s2.306-5.425 5.425-6.125Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.7}
			d="M24.702 10.954a2.187 2.187 0 0 0-2.095-2.817H11.025a5.863 5.863 0 0 0 0 11.726h9.377c.966 0 1.818-.634 2.095-1.56l2.205-7.35Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M10.594 17.15v-6.248h.788v5.548h2.73v.7h-3.518Zm7.13-3.299h2.162v3.063c-.338.11-.68.192-1.024.245a7.837 7.837 0 0 1-1.172.078c-.648 0-1.193-.128-1.637-.385a2.567 2.567 0 0 1-1.015-1.11c-.227-.485-.34-1.057-.34-1.716 0-.653.127-1.219.384-1.697a2.699 2.699 0 0 1 1.103-1.112c.484-.268 1.067-.402 1.75-.402.35 0 .68.032.988.096.315.064.607.155.875.271l-.297.683a4.55 4.55 0 0 0-.753-.254 3.453 3.453 0 0 0-.857-.105c-.496 0-.922.102-1.278.306a2.004 2.004 0 0 0-.813.875c-.187.374-.28.82-.28 1.34 0 .495.078.935.236 1.32.163.38.417.677.761.893.344.21.796.315 1.356.315.187 0 .35-.006.49-.018.146-.017.277-.037.394-.06.123-.024.236-.047.341-.07V14.55h-1.373v-.7Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const GripR: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M20.441 7.875c2.283 1.22 3.82 3.507 3.82 6.125s-1.537 4.904-3.82 6.125c3.12-.7 5.425-3.177 5.425-6.125s-2.305-5.425-5.425-6.125Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			stroke="#fff"
			strokeWidth={0.7}
			d="M3.264 10.954a2.187 2.187 0 0 1 2.095-2.817h11.582a5.862 5.862 0 0 1 0 11.726H7.564a2.188 2.188 0 0 1-2.095-1.56l-2.205-7.35Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M9.497 10.902c.519 0 .945.068 1.277.202.339.128.59.323.753.586.163.262.245.592.245.989 0 .332-.062.61-.184.83-.122.223-.28.4-.472.535-.187.128-.386.23-.595.306l1.714 2.8h-.918l-1.514-2.581H8.56v2.58h-.787v-6.247h1.724Zm-.044.683H8.56v2.319h.937c.338 0 .615-.044.831-.132a.956.956 0 0 0 .473-.402c.104-.175.157-.394.157-.656 0-.274-.055-.493-.166-.657a.905.905 0 0 0-.49-.358c-.222-.076-.505-.114-.849-.114Zm6.476 2.266h2.16v3.063c-.337.11-.679.192-1.023.245a7.837 7.837 0 0 1-1.172.078c-.648 0-1.193-.128-1.637-.385a2.568 2.568 0 0 1-1.015-1.11c-.227-.485-.34-1.057-.34-1.716 0-.653.127-1.219.384-1.697a2.699 2.699 0 0 1 1.103-1.112c.484-.268 1.067-.402 1.75-.402.35 0 .68.032.988.096.315.064.607.155.875.271l-.297.683a4.551 4.551 0 0 0-.753-.254 3.453 3.453 0 0 0-.857-.105c-.496 0-.922.102-1.278.306a2.004 2.004 0 0 0-.813.875c-.187.374-.28.82-.28 1.34 0 .495.078.935.236 1.32.163.38.417.677.761.893.344.21.796.315 1.356.315.187 0 .35-.006.49-.018a5.17 5.17 0 0 0 .394-.06c.123-.024.236-.047.341-.07V14.55H15.93v-.7Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const TriggerL: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={0.7}
			d="M14 20.212a7.612 7.612 0 1 0 0-15.224 7.612 7.612 0 0 0 0 15.224Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M10.209 15.662V9.415h.787v5.548h2.73v.7H10.21Zm6.395 0h-.787v-5.556h-1.952v-.691h4.682v.691h-1.943v5.556Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M21.235 17.5a8.31 8.31 0 0 1-7.205 4.165A8.31 8.31 0 0 1 6.825 17.5c.823 3.4 3.737 5.915 7.205 5.915 3.469 0 6.382-2.514 7.205-5.915Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const TriggerR: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			strokeWidth={0.7}
			d="M14 20.212a7.612 7.612 0 1 0 0-15.224 7.612 7.612 0 0 0 0 15.224Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			d="M11.42 9.415c.52 0 .945.067 1.277.201.339.129.59.324.753.587.163.262.245.592.245.988 0 .333-.061.61-.184.832-.122.221-.28.4-.472.533-.187.129-.385.23-.595.307l1.715 2.8h-.92l-1.513-2.582h-1.242v2.582h-.788V9.415h1.724Zm-.044.683h-.892v2.318h.936c.338 0 .615-.043.831-.131a.956.956 0 0 0 .473-.402c.105-.175.157-.394.157-.657 0-.274-.055-.493-.166-.656a.905.905 0 0 0-.49-.359c-.222-.075-.505-.114-.849-.114Zm5.74 5.564h-.787v-5.556h-1.951v-.691h4.681v.691h-1.942v5.556Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M21.235 17.5a8.31 8.31 0 0 1-7.205 4.165A8.31 8.31 0 0 1 6.825 17.5c.823 3.4 3.737 5.915 7.205 5.915 3.469 0 6.382-2.514 7.205-5.915Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbrestL: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			d="m20.01 15.768-4.242 4.242a5.5 5.5 0 1 1-7.778-7.778l4.242-4.242a5.5 5.5 0 1 1 7.778 7.778Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M11.172 16.828a1 1 0 0 0 1.414 0L15.414 14l.707.707-2.828 2.828a2 2 0 1 1-2.829-2.828l.708.707a1 1 0 0 0 0 1.414ZM12.586 14l2.828-2.829a1 1 0 1 1 1.414 1.415l.708.707a2 2 0 0 0-2.829-2.829l-2.828 2.829.707.707Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M15.414 16.828 18.243 14a3 3 0 0 0-2.289-5.117l-.869-.869a4 4 0 0 1 3.864 6.693l-2.828 2.828-.707-.707Zm-.707 2.122a4 4 0 1 1-5.657-5.657l4.243-4.243.707.707L9.757 14A3 3 0 1 0 14 18.242l.707.708Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const ThumbrestR: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={IconSize}
		height={IconSize}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<path
			stroke="#fff"
			d="m15.768 7.99 4.242 4.242a5.5 5.5 0 1 1-7.778 7.778L7.99 15.768a5.5 5.5 0 1 1 7.778-7.778Z"
			style={{
				stroke: '#fff',
				strokeOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M16.828 16.828a1 1 0 0 0 0-1.414L14 12.586l.707-.707 2.828 2.828a2 2 0 1 1-2.828 2.828l.707-.707a1 1 0 0 0 1.414 0ZM14 15.414l-2.828-2.828a1 1 0 0 1 1.414-1.414l.707-.708a2 2 0 0 0-2.829 2.829l2.829 2.828.707-.707Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<path
			fill="#fff"
			fillRule="evenodd"
			d="M16.828 12.586 14 9.757a3 3 0 0 0-5.117 2.289l-.869.869a4 4 0 0 1 6.693-3.864l2.828 2.828-.707.707Zm2.122.707a4 4 0 1 1-5.657 5.657L9.05 14.707 9.757 14 14 18.243A3 3 0 1 0 18.243 14l.707-.707Z"
			clipRule="evenodd"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
	</svg>
);

export const PoseL: React.FC = () => (
	<FAControlIcon icon={faHandScissors} $reverse={true} />
);

export const PoseR: React.FC = () => (
	<FAControlIcon icon={faHandScissors} $reverse={false} />
);

export const PinchL: React.FC = () => (
	<FAControlIcon icon={faHandLizard} $reverse={true} />
);

export const PinchR: React.FC = () => (
	<FAControlIcon icon={faHandLizard} $reverse={false} />
);

type ButtonID =
	| 'x-button-left'
	| 'y-button-left'
	| 'a-button-right'
	| 'b-button-right'
	| 'thumbstick-left'
	| 'thumbstick-up-left'
	| 'thumbstick-down-left'
	| 'thumbstick-right-left'
	| 'thumbstick-left-left'
	| 'pose-left'
	| 'pinch-left'
	| 'thumbstick-right'
	| 'thumbstick-up-right'
	| 'thumbstick-down-right'
	| 'thumbstick-right-right'
	| 'thumbstick-left-right'
	| 'trigger-left'
	| 'trigger-right'
	| 'squeeze-left'
	| 'squeeze-right'
	| 'thumbrest-left'
	| 'thumbrest-right'
	| 'pose-right'
	| 'pinch-right';

// Create a mapping of buttonId to icon component
const buttonIdToIcon: { [key in ButtonID]: React.FC } = {
	'x-button-left': ButtonX,
	'y-button-left': ButtonY,
	'a-button-right': ButtonA,
	'b-button-right': ButtonB,
	'thumbstick-left': ThumbstickL,
	'thumbstick-up-left': ThumbstickLUp,
	'thumbstick-down-left': ThumbstickLDown,
	'thumbstick-right-left': ThumbstickLRight,
	'thumbstick-left-left': ThumbstickLLeft,
	'pose-left': PoseL,
	'pinch-left': PinchL,
	'thumbstick-right': ThumbstickR,
	'thumbstick-up-right': ThumbstickRUp,
	'thumbstick-down-right': ThumbstickRDown,
	'thumbstick-right-right': ThumbstickRRight,
	'thumbstick-left-right': ThumbstickRLeft,
	'trigger-left': TriggerL,
	'trigger-right': TriggerR,
	'squeeze-left': GripL,
	'squeeze-right': GripR,
	'thumbrest-left': ThumbrestL,
	'thumbrest-right': ThumbrestR,
	'pose-right': PoseR,
	'pinch-right': PinchR,
};

// Define the GamepadIcon component
interface GamepadIconProps {
	buttonName: string;
	handedness: XRHandedness;
}

export const GamepadIcon: React.FC<GamepadIconProps> = ({
	buttonName,
	handedness,
}) => {
	const buttonId = `${buttonName}-${handedness}` as ButtonID;
	const IconComponent = buttonIdToIcon[buttonId];
	return IconComponent ? (
		<IconComponent />
	) : (
		<div
			style={{
				width: ControlButtonStyles.height,
				height: ControlButtonStyles.height,
			}}
		></div>
	);
};

export const MouseLeft: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={16}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<g clipPath="url(#a)">
			<path
				stroke="#fff"
				d="M.5 6.5H6m-5.5 0V5C.5 2.237 2.237.5 5 .5h1m-5.5 6V11c0 2.762 1.737 4.5 4.5 4.5h2c2.762 0 4.5-1.738 4.5-4.5V6.5M6 6.5v-6m0 6h5.5M6 .5h1c2.762 0 4.5 1.737 4.5 4.5v1.5"
				style={{
					stroke: '#fff',
					strokeOpacity: 1,
				}}
			/>
		</g>
		<path
			fill="#fff"
			d="M.5 6.5H6v-6H5C2.237.5.5 2.237.5 5v1.5Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<defs>
			<clipPath id="a">
				<path
					fill="#fff"
					d="M0 0h12v16H0z"
					style={{
						fill: '#fff',
						fillOpacity: 1,
					}}
				/>
			</clipPath>
		</defs>
	</svg>
);

export const MouseRight: React.FC = ({ scale = 1.2 }: { scale?: number }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={12}
		height={16}
		fill="none"
		transform={`scale(${scale}, ${scale})`}
	>
		<g clipPath="url(#a)">
			<path
				stroke="#fff"
				d="M.5 6.5H6m-5.5 0V5C.5 2.237 2.237.5 5 .5h1m-5.5 6V11c0 2.762 1.737 4.5 4.5 4.5h2c2.762 0 4.5-1.738 4.5-4.5V6.5M6 6.5v-6m0 6h5.5M6 .5h1c2.762 0 4.5 1.737 4.5 4.5v1.5"
				style={{
					stroke: '#fff',
					strokeOpacity: 1,
				}}
			/>
		</g>
		<path
			fill="#fff"
			d="M11.5 6.5H6v-6h1c2.762 0 4.5 1.737 4.5 4.5v1.5Z"
			style={{
				fill: '#fff',
				fillOpacity: 1,
			}}
		/>
		<defs>
			<clipPath id="a">
				<path
					fill="#fff"
					d="M0 0h12v16H0z"
					style={{
						fill: '#fff',
						fillOpacity: 1,
					}}
				/>
			</clipPath>
		</defs>
	</svg>
);

interface IconProps {
	size?: number;
	color?: string;
}

export const BoxIcon: React.FC<IconProps> = ({
	size = 14,
	color = Colors.textWhite,
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 14 14"
		fill="none"
	>
		<path
			stroke={color}
			strokeWidth={1.5}
			d="M7 13.037V5.512m-.324.289 6.3-2.275m-11.952 0 6.3 2.275m.23 6.937 4.233-1.528a1.627 1.627 0 0 0 1.076-1.53V4.396c0-.685-.43-1.297-1.076-1.53L7.553 1.339a1.63 1.63 0 0 0-1.106 0L2.213 2.867a1.627 1.627 0 0 0-1.075 1.53V9.68c0 .686.43 1.298 1.075 1.53l4.234 1.529a1.63 1.63 0 0 0 1.106 0Z"
			style={{
				stroke: color,
				strokeOpacity: 1,
			}}
		/>
	</svg>
);

export const MeshIcon: React.FC<IconProps> = ({
	size = 14,
	color = Colors.textWhite,
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 14 14"
		fill="none"
	>
		<path
			stroke={color}
			strokeWidth={1.2}
			d="M7 13.037V5.512M3.937 11.9V4.375m6.126 7.525V4.375M6.675 5.8l6.3-2.275m-9.275.962 6.3-2.275M1.024 3.526l6.3 2.275M6.85 9.388l6.3-2.275m-12.302 0 6.3 2.276m-3.15-7.176 6.3 2.276m-2.746 8.248 4.234-1.527a1.627 1.627 0 0 0 1.075-1.53V4.396c0-.685-.43-1.297-1.075-1.53L7.553 1.339a1.63 1.63 0 0 0-1.106 0L2.213 2.867a1.627 1.627 0 0 0-1.076 1.53V9.68c0 .686.43 1.298 1.076 1.53l4.234 1.529a1.63 1.63 0 0 0 1.106 0Z"
			style={{
				stroke: color,
				strokeOpacity: 1,
			}}
		/>
	</svg>
);

export const PlaneIcon: React.FC<IconProps> = ({
	size = 14,
	color = Colors.textWhite,
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 14 14"
		fill="none"
	>
		<path
			stroke={color}
			strokeWidth={1.2}
			d="M1.225 8.225h11.55M2.1 5.075h9.8m-7 7L5.6 2.1m3.5 9.975L8.4 2.1m-5.708 9.712h8.617a1.75 1.75 0 0 0 1.696-2.183l-1.567-6.125a1.75 1.75 0 0 0-1.695-1.317H4.258c-.8 0-1.498.542-1.696 1.317L.996 9.629a1.75 1.75 0 0 0 1.696 2.183Z"
			style={{
				stroke: color,
				strokeOpacity: 1,
			}}
		/>
	</svg>
);

export const IWERIcon: React.FC<IconProps> = ({
	size = 14,
	color = Colors.textWhite,
}) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 14 14"
		fill="none"
	>
		<path
			fill={color}
			d="M10.5 8.367a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z"
			style={{
				fill: color,
				fillOpacity: 1,
			}}
		/>
		<path
			fill={color}
			fillRule="evenodd"
			d="M0 5.8A2.8 2.8 0 0 1 2.8 3h8.4A2.8 2.8 0 0 1 14 5.8v2.8a2.8 2.8 0 0 1-2.8 2.8H9.526c-.619 0-1.184-.35-1.46-.903l-.108-.214a.933.933 0 0 0-.835-.516h-.246c-.354 0-.677.2-.835.516l-.107.214a1.633 1.633 0 0 1-1.461.903H2.8A2.8 2.8 0 0 1 0 8.6V5.8Zm4.9 1.167a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0Zm8.367-.768a.268.268 0 0 0 .076-.292 2.942 2.942 0 0 0-.187-.407l-.055-.096a3.012 3.012 0 0 0-.262-.37.27.27 0 0 0-.29-.08l-.66.21a2.279 2.279 0 0 0-.522-.302l-.148-.676a.268.268 0 0 0-.215-.211 3.062 3.062 0 0 0-1.008.001.268.268 0 0 0-.215.21l-.148.677a2.28 2.28 0 0 0-.522.301l-.66-.21a.268.268 0 0 0-.29.081c-.096.116-.184.24-.262.37l-.056.096c-.072.13-.135.265-.187.406a.268.268 0 0 0 .076.292l.513.467a2.293 2.293 0 0 0 0 .603l-.513.467a.268.268 0 0 0-.076.291c.052.141.115.276.187.407l.056.096c.078.13.166.253.262.37a.27.27 0 0 0 .29.08l.66-.211c.158.122.333.224.52.3l.149.677a.268.268 0 0 0 .215.211 3.06 3.06 0 0 0 1.007 0 .268.268 0 0 0 .216-.21l.148-.677a2.28 2.28 0 0 0 .521-.301l.66.21c.105.033.22.004.29-.08.097-.117.184-.24.263-.37l.055-.097c.073-.13.135-.265.188-.406a.268.268 0 0 0-.076-.292l-.513-.466a2.299 2.299 0 0 0 0-.602l.513-.467Z"
			clipRule="evenodd"
			style={{
				fill: color,
				fillOpacity: 1,
			}}
		/>
	</svg>
);
