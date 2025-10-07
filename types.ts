
// FIX: Removed circular import `import { Mode } from './types';` which conflicts with the enum declaration below.
export enum Mode {
  None,
  Gaze,
  Click,
}

export type ClickState = 'none' | 'left' | 'right';

export interface CalibrationPointData {
  screen: { x: number; y: number }; // Screen coordinates (0-1) - where the user clicked
  eye: { x: number; y: number };    // Avg eye coordinates from video frame
}

export interface BlinkStateMachine {
  state: 'open' | 'closing' | 'closed' | 'cooldown';
  frames: number;
}

export type DetectionStatus = 'searching' | 'face_detected' | 'tracking';
