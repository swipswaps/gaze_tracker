
import React from 'react';
import { ClickState } from '../types';

interface GazeCursorProps {
  position: { x: number; y: number };
  clickState: ClickState;
  isCorrectionMode: boolean;
  correctionFeedback: boolean;
}

const GazeCursor: React.FC<GazeCursorProps> = ({ position, clickState, isCorrectionMode, correctionFeedback }) => {
  const baseClasses = 'absolute w-8 h-8 rounded-full border-2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-all duration-150';

  const getCursorStyle = () => {
    if (correctionFeedback) {
      return 'bg-yellow-300/70 border-yellow-200 scale-150';
    }
    if (isCorrectionMode) {
      return 'bg-yellow-400/50 border-yellow-300 rounded-md'; // Change shape for correction mode
    }

    switch (clickState) {
      case 'left':
        return 'bg-cyan-400/50 border-cyan-300 scale-125';
      case 'right':
        return 'bg-lime-400/50 border-lime-300 scale-125';
      default:
        return 'bg-transparent border-white scale-100';
    }
  };
  
  const currentPos = position;

  return (
    <div
      className={`${baseClasses} ${getCursorStyle()}`}
      style={{ left: `${currentPos.x}px`, top: `${currentPos.y}px` }}
    >
      <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full ${isCorrectionMode ? 'bg-yellow-200' : 'bg-white'}`}></div>
    </div>
  );
};

export default GazeCursor;