import React, { useState, useEffect } from 'react';
import { CalibrationState } from '../types';

interface CalibrationScreenProps {
  state: CalibrationState;
  totalPoints: number;
  currentPointIndex: number;
  pointPosition?: { x: number; y: number };
}

const CalibrationScreen: React.FC<CalibrationScreenProps> = ({
  state,
  totalPoints,
  currentPointIndex,
  pointPosition,
}) => {
  const [message, setMessage] = useState('Get ready to calibrate...');
  const [showPoint, setShowPoint] = useState(false);

  useEffect(() => {
    if (state === 'inProgress') {
      setShowPoint(false);
      setMessage(`Look at the dot... (${currentPointIndex + 1}/${totalPoints})`);
      const timer = setTimeout(() => {
        setShowPoint(true);
      }, 1800); // Delay before showing point
      return () => clearTimeout(timer);
    }
  }, [currentPointIndex, state, totalPoints]);

  if (state === 'notStarted') {
    return null;
  }

  if (state === 'inProgress' && currentPointIndex >= totalPoints) {
    return (
        <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-20">
            <h2 className="text-2xl font-bold mb-4 animate-pulse">Calculating...</h2>
            <p className="text-gray-300">Finalizing calibration data.</p>
        </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-20 pointer-events-none">
        <h2 className="text-2xl font-bold mb-4 transition-opacity duration-500" style={{opacity: showPoint ? 0 : 1}}>{message}</h2>
        {showPoint && pointPosition && (
            <div
                className="absolute w-8 h-8 rounded-full bg-cyan-400 border-2 border-white shadow-lg transition-all duration-300 animate-pulse"
                style={{
                    left: `calc(${pointPosition.x * 100}% - 16px)`,
                    top: `calc(${pointPosition.y * 100}% - 16px)`,
                }}
            >
                <div className="w-full h-full rounded-full bg-white animate-ping opacity-75"></div>
            </div>
        )}
    </div>
  );
};

export default CalibrationScreen;