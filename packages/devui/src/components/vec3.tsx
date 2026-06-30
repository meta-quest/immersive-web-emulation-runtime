/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { InputSuffix, RowLabel, ValueInput, ValuesContainer } from './styled.js';
import { useEffect, useRef, useState } from 'react';

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
  multiplier?: number;
  precision?: number;
  onValidInput?: () => void;
  marginBottom?: string;
}

const Row = styled.div<{ $mb?: string }>`
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-bottom: ${({ $mb }) => $mb ?? '0'};
`;

const Field = styled.div`
  position: relative;
  display: inline-block;
  height: 26px;
`;

export const Vector3Input = ({
  vector,
  label = '',
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
  const scratchValues = useRef({ x: 0, y: 0, z: 0 });

  const syncValues = () => {
    const cur = scratchValues.current;
    cur.x = round(vector.x / multiplier, precision);
    cur.y = round(vector.y / multiplier, precision);
    cur.z = round(vector.z / multiplier, precision);
    const { x, y, z } = actualValuesRef.current;
    if (cur.x !== x || cur.y !== y || cur.z !== z) {
      actualValuesRef.current = { x: cur.x, y: cur.y, z: cur.z };
      setDisplayValues({
        x: cur.x.toFixed(precision),
        y: cur.y.toFixed(precision),
        z: cur.z.toFixed(precision),
      });
    }
    animationFrameId.current = requestAnimationFrame(syncValues);
  };

  useEffect(() => {
    animationFrameId.current = requestAnimationFrame(syncValues);
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vector, multiplier, precision]);

  const handleInputChange =
    (axis: Axis) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = event.target.value;
      const parsedValue = parseFloat(newValue);
      setDisplayValues((prev) => ({ ...prev, [axis]: newValue }));
      if (!isNaN(parsedValue)) {
        actualValuesRef.current[axis] = parsedValue;
        vector[axis] = parsedValue * multiplier;
        onValidInput();
      }
    };

  return (
    <Row $mb={marginBottom}>
      <RowLabel>{label}</RowLabel>
      <ValuesContainer>
        {(['x', 'y', 'z'] as Axis[]).map((axis) => (
          <Field key={`${label}-${axis}`}>
            <ValueInput
              value={displayValues[axis]}
              onChange={handleInputChange(axis)}
              className={
                parseFloat(displayValues[axis]) !== actualValuesRef.current[axis]
                  ? 'invalid'
                  : undefined
              }
            />
            <InputSuffix>{axis.toUpperCase()}</InputSuffix>
          </Field>
        ))}
      </ValuesContainer>
    </Row>
  );
};
