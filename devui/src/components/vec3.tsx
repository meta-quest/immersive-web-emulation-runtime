/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { FAIcon, InputSuffix, ValueInput, ValuesContainer } from './styled.js';
import { useEffect, useRef, useState } from 'react';

import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { styled } from 'styled-components';

export function round(number: number, decimalPlaces: number) {
	const factor = Math.pow(10, decimalPlaces);
	return Math.round(number * factor) / factor;
}

type Axis = 'x' | 'y' | 'z';

type Vector3Like = {
	x: number;
	y: number;
	z: number;
};

interface Vector3InputProps {
	vector: Vector3Like;
	label?: string;
	icon?: IconDefinition;
	multiplier?: number;
	precision?: number;
	onValidInput?: () => void;
	marginBottom?: string;
}

const Vector3Container = styled.div`
	width: 100%;
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	align-items: center;
	margin: 0;
	font-size: 12px;
`;

export const Vector3Input = ({
	vector,
	label = '',
	icon,
	multiplier = 1,
	precision = 2,
	onValidInput = () => {},
	marginBottom = '0',
}: Vector3InputProps) => {
	const [displayValues, setDisplayValues] = useState({
		x: (vector.x / multiplier).toFixed(precision),
		y: (vector.y / multiplier).toFixed(precision),
		z: (vector.z / multiplier).toFixed(precision),
	});

	const actualValuesRef = useRef({
		x: round(vector.x / multiplier, precision),
		y: round(vector.y / multiplier, precision),
		z: round(vector.z / multiplier, precision),
	});

	const animationFrameId = useRef<number | null>(null);

	// Sync display values with actual values (optimized)
	const syncValues = () => {
		const currentActualValues = {
			x: round(vector.x / multiplier, precision),
			y: round(vector.y / multiplier, precision),
			z: round(vector.z / multiplier, precision),
		};

		const { x, y, z } = actualValuesRef.current;

		// Only update state if actual values have changed
		if (
			currentActualValues.x !== x ||
			currentActualValues.y !== y ||
			currentActualValues.z !== z
		) {
			actualValuesRef.current = currentActualValues;
			setDisplayValues({
				x: currentActualValues.x.toFixed(precision),
				y: currentActualValues.y.toFixed(precision),
				z: currentActualValues.z.toFixed(precision),
			});
		}

		// Schedule the next frame
		animationFrameId.current = requestAnimationFrame(syncValues);
	};

	useEffect(() => {
		// Start the synchronization loop
		animationFrameId.current = requestAnimationFrame(syncValues);

		return () => {
			// Cleanup the animation frame on unmount
			if (animationFrameId.current) {
				cancelAnimationFrame(animationFrameId.current);
			}
		};
	}, [vector, multiplier, precision]);

	// Handle user input changes
	const handleInputChange =
		(axis: Axis) => (event: React.ChangeEvent<HTMLInputElement>) => {
			const newValue = event.target.value;
			const parsedValue = parseFloat(newValue);

			// Update display values immediately
			setDisplayValues((prev) => ({ ...prev, [axis]: newValue }));

			// If valid, update the actual values and the vector
			if (!isNaN(parsedValue)) {
				actualValuesRef.current[axis] = parsedValue;
				vector[axis] = parsedValue * multiplier;
				onValidInput();
			}
		};

	return (
		<Vector3Container style={{ marginBottom }}>
			{icon ? (
				<FAIcon icon={icon} style={{ marginRight: '5px' }} />
			) : (
				<span style={{ marginRight: '5px' }}>{label}</span>
			)}
			<ValuesContainer>
				{['x', 'y', 'z'].map((axis) => (
					<div
						key={`${label}-${axis}`}
						style={{
							position: 'relative',
							display: 'inline-block',
							height: '25px',
						}}
					>
						<ValueInput
							value={displayValues[axis as Axis]}
							onChange={handleInputChange(axis as Axis)}
							className={
								parseFloat(displayValues[axis as Axis]) !==
								actualValuesRef.current[axis as Axis]
									? 'invalid'
									: undefined
							}
						/>
						<InputSuffix>{axis.toUpperCase()}</InputSuffix>
					</div>
				))}
			</ValuesContainer>
		</Vector3Container>
	);
};
