import React, { useState } from 'react';
import { CalibrationPointData } from '../types';
import Icon from './Icon';

interface CalibrationScreenProps {
  onCalibrationComplete: (data: CalibrationPointData[]) => void;
  getEyePosition: () => { x: number; y: number };
}

// Define the points for calibration (normalized screen coordinates)
const CALIBRATION_POINTS = [
  { x: 0.1, y: 0.1 },
  { x: 0.5, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.9, y: 0.5 },
  { x: 0.1, y: 0.9 },
  { x: 0.5, y: 0.9 },
  { x: 0.9, y: 0.9 },
];
const TOTAL_POINTS = CALIBRATION_POINTS.length;

const CalibrationScreen: React.FC<CalibrationScreenProps> = ({ onCalibrationComplete, getEyePosition }) => {
  const [currentPointIndex, setCurrentPointIndex] = useState(0);
  const [collectedData, setCollectedData] = useState<CalibrationPointData[]>([]);
  const [showFeedback, setShowFeedback] = useState(false);

  const handleTargetClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    // Prevent clicks outside the target from registering
    event.stopPropagation();

    setShowFeedback(true);

    const screenPoint = CALIBRATION_POINTS[currentPointIndex];
    const newCalibrationPoint: CalibrationPointData = {
      screen: { 
        x: screenPoint.x * window.innerWidth, 
        y: screenPoint.y * window.innerHeight 
      },
      eye: getEyePosition(),
    };

    const updatedData = [...collectedData, newCalibrationPoint];
    setCollectedData(updatedData);
    
    setTimeout(() => {
      setShowFeedback(false);
      if (currentPointIndex + 1 >= TOTAL_POINTS) {
        onCalibrationComplete(updatedData);
      } else {
        setCurrentPointIndex(currentPointIndex + 1);
      }
    }, 300); // Short delay for visual feedback
  };

  const currentPoint = CALIBRATION_POINTS[currentPointIndex];

  return (
    <div className="absolute inset-0 bg-gray-900 bg-opacity-95 flex flex-col items-center justify-center z-20">
      <div className="text-center mb-16 max-w-2xl">
        <Icon name="target" className="w-16 h-16 mx-auto mb-4 text-cyan-400" />
        <h1 className="text-4xl font-bold mb-2">Calibration Required</h1>
        <p className="text-lg text-gray-300">
          To begin, please click the glowing targets as they appear on the screen.
          This helps the AI understand how your head movements map to the cursor position.
        </p>
        <p className="mt-4 text-2xl font-semibold text-white">
          Click Target: <span className="text-cyan-400">{currentPointIndex + 1}</span> / {TOTAL_POINTS}
        </p>
      </div>

      <div
        className="absolute w-16 h-16 -translate-x-1/2 -translate-y-1/2 cursor-pointer group"
        style={{
          left: `${currentPoint.x * 100}%`,
          top: `${currentPoint.y * 100}%`,
        }}
        onClick={handleTargetClick}
        aria-label={`Calibration target ${currentPointIndex + 1} of ${TOTAL_POINTS}`}
        role="button"
      >
        <div
          className={`absolute inset-0 rounded-full border-2 transition-all duration-300 ${
            showFeedback ? 'bg-cyan-400 scale-125 border-cyan-200' : 'bg-transparent border-white group-hover:bg-white/20'
          }`}
        ></div>
        <div className="absolute inset-2.5 rounded-full bg-gray-900"></div>
         <div
          className={`absolute inset-0 rounded-full animate-ping-slow bg-white/50 transition-opacity duration-300 ${
            showFeedback ? 'opacity-0' : 'opacity-100'
          }`}
        ></div>
      </div>
    </div>
  );
};

export default CalibrationScreen;