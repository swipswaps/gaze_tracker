export enum Mode {
  None,
  Gaze,
  Click,
}

export type ClickState = 'none' | 'left' | 'right';

export type CalibrationState = 'notStarted' | 'inProgress' | 'finished';

export interface CalibrationPointData {
  screen: { x: number; y: number }; // Screen coordinates (0-1)
  eye: { x: number; y: number };    // Avg eye coordinates from video frame
}

export interface CalibrationMap {
  eyeMinX: number;
  eyeMaxX: number;
  eyeMinY: number;
  eyeMaxY: number;
}

export interface BlinkStateMachine {
  state: 'idle' | 'closing' | 'closed';
  frames: number;
}
