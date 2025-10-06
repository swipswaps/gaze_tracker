
import React from 'react';
import { ClickState } from '../types';

interface GazeCursorProps {
  position: { x: number; y: number };
  clickState: ClickState;
}

const GazeCursor: React.FC<GazeCursorProps> = ({ position, clickState }) => {
  const baseClasses = 'absolute w-8 h-8 rounded-full border-2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-all duration-150';

  const getCursorStyle = () => {
    switch (clickState) {
      case 'left':
        return 'bg-cyan-400/50 border-cyan-300 scale-125';
      case 'right':
        return 'bg-lime-400/50 border-lime-300 scale-125';
      default:
        return 'bg-transparent border-white scale-100';
    }
  };
  
  return (
    <div
      className={`${baseClasses} ${getCursorStyle()}`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-white rounded-full"></div>
    </div>
  );
};

export default GazeCursor;
