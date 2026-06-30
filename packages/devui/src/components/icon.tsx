/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Single icon surface for the DevUI, backed by lucide-react. Icons are imported
 * by name (tree-shaken) and exposed through a small kebab-case map so call sites
 * stay terse: <Icon name="gamepad-2" size={16} />.
 */

import {
  Armchair,
  ArrowBigUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  Atom,
  Ban,
  Box,
  Bug,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CirclePlay,
  CircleX,
  CornerDownLeft,
  Delete,
  Gamepad2,
  Glasses,
  Hand,
  Keyboard,
  Layers,
  LogOut,
  type LucideIcon,
  Mouse,
  MouseLeft,
  MouseRight,
  Pin,
  Plug,
  RotateCcw,
  Save,
  Settings,
  Shapes,
  Video,
  X,
} from 'lucide-react';

import React from 'react';

const MAP: Record<string, LucideIcon> = {
  'rotate-ccw': RotateCcw,
  'circle-play': CirclePlay,
  'gamepad-2': Gamepad2,
  hand: Hand,
  keyboard: Keyboard,
  armchair: Armchair,
  layers: Layers,
  box: Box,
  shapes: Shapes,
  save: Save,
  'log-out': LogOut,
  atom: Atom,
  bug: Bug,
  x: X,
  settings: Settings,
  'circle-x': CircleX,
  plug: Plug,
  glasses: Glasses,
  video: Video,
  pin: Pin,
  'circle-dot': CircleDot,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  ban: Ban,
  mouse: Mouse,
  'mouse-left': MouseLeft,
  'mouse-right': MouseRight,
  'corner-down-left': CornerDownLeft,
  'arrow-big-up': ArrowBigUp,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-right-to-line': ArrowRightToLine,
  delete: Delete,
};

// The IWER brand mark (eyewear) — this is the tool's own icon, so it stays a
// bespoke SVG rather than a generic lucide glyph.
const IwerLogo: React.FC<{
  size: number;
  color: string;
  style?: React.CSSProperties;
}> = ({ size, color, style }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    style={style}
  >
    <path fill={color} d="M10.5 8.367a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z" />
    <path
      fill={color}
      fillRule="evenodd"
      d="M0 5.8A2.8 2.8 0 0 1 2.8 3h8.4A2.8 2.8 0 0 1 14 5.8v2.8a2.8 2.8 0 0 1-2.8 2.8H9.526c-.619 0-1.184-.35-1.46-.903l-.108-.214a.933.933 0 0 0-.835-.516h-.246c-.354 0-.677.2-.835.516l-.107.214a1.633 1.633 0 0 1-1.461.903H2.8A2.8 2.8 0 0 1 0 8.6V5.8Zm4.9 1.167a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0Zm8.367-.768a.268.268 0 0 0 .076-.292 2.942 2.942 0 0 0-.187-.407l-.055-.096a3.012 3.012 0 0 0-.262-.37.27.27 0 0 0-.29-.08l-.66.21a2.279 2.279 0 0 0-.522-.302l-.148-.676a.268.268 0 0 0-.215-.211 3.062 3.062 0 0 0-1.008.001.268.268 0 0 0-.215.21l-.148.677a2.28 2.28 0 0 0-.522.301l-.66-.21a.268.268 0 0 0-.29.081c-.096.116-.184.24-.262.37l-.056.096c-.072.13-.135.265-.187.406a.268.268 0 0 0 .076.292l.513.467a2.293 2.293 0 0 0 0 .603l-.513.467a.268.268 0 0 0-.076.291c.052.141.115.276.187.407l.056.096c.078.13.166.253.262.37a.27.27 0 0 0 .29.08l.66-.211c.158.122.333.224.52.3l.149.677a.268.268 0 0 0 .215.211 3.06 3.06 0 0 0 1.007 0 .268.268 0 0 0 .216-.21l.148-.677a2.28 2.28 0 0 0 .521-.301l.66.21c.105.033.22.004.29-.08.097-.117.184-.24.263-.37l.055-.097c.073-.13.135-.265.188-.406a.268.268 0 0 0-.076-.292l-.513-.466a2.299 2.299 0 0 0 0-.602l.513-.467Z"
    />
  </svg>
);

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 2,
  style,
}) => {
  if (name === 'iwer') return <IwerLogo size={size} color={color} style={style} />;
  const Cmp = MAP[name];
  if (!Cmp) return null;
  return (
    <Cmp size={size} color={color} strokeWidth={strokeWidth} style={style} />
  );
};
