import React from 'react';
import { Mode } from '../types';
import Icon from './Icon';

interface StatusDisplayProps {
  mode: Mode;
  onRecalibrate: () => void;
  cameras: MediaDeviceInfo[];
  selectedCameraId: string;
  onCameraChange: (deviceId: string) => void;
}

const StatusDisplay: React.FC<StatusDisplayProps> = ({ mode, onRecalibrate, cameras, selectedCameraId, onCameraChange }) => {
  const getStatusText = () => {
    switch (mode) {
      case Mode.Gaze:
        return 'Gaze Tracking Active';
      case Mode.Click:
        return 'Blink Click Active';
      default:
        return 'Idle';
    }
  };

  const getStatusColor = () => {
    switch (mode) {
      case Mode.Gaze:
        return 'text-cyan-400';
      case Mode.Click:
        return 'text-lime-400';
      default:
        return 'text-gray-400';
    }
  };

  const instructionBaseClasses = "flex items-start space-x-4 p-4 rounded-lg transition-all duration-300 border";
  const instructionActiveClasses = {
    [Mode.Gaze]: "bg-cyan-500/20 border-cyan-400",
    [Mode.Click]: "bg-lime-500/20 border-lime-400",
    [Mode.None]: "bg-gray-800/50 border-gray-700",
  }

  return (
    <div className="w-full max-w-sm p-6 bg-gray-800 border border-gray-700 rounded-xl shadow-lg flex flex-col">
      <h2 className="text-2xl font-bold text-center mb-2">Controls</h2>
      <div className="text-center mb-6">
        <p className={`text-lg font-semibold ${getStatusColor()}`}>{getStatusText()}</p>
      </div>

      <div className="space-y-4">
        <div className={`${instructionBaseClasses} ${mode === Mode.Gaze ? instructionActiveClasses[Mode.Gaze] : instructionActiveClasses[Mode.None]}`}>
          <Icon name="eye" className="w-8 h-8 text-cyan-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-bold">Gaze Control</h3>
            <p className="text-sm text-gray-400">Press and hold <kbd className="px-2 py-1 text-sm font-semibold text-cyan-300 bg-gray-900 border border-cyan-700 rounded-md">G</kbd> to move the cursor with your gaze.</p>
          </div>
        </div>
        
        <div className={`${instructionBaseClasses} ${mode === Mode.Click ? instructionActiveClasses[Mode.Click] : instructionActiveClasses[Mode.None]}`}>
          <Icon name="click" className="w-8 h-8 text-lime-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-bold">Blink Click</h3>
            <p className="text-sm text-gray-400">Hold <kbd className="px-2 py-1 text-sm font-semibold text-lime-300 bg-gray-900 border border-lime-700 rounded-md">C</kbd> and blink your left or right eye to trigger a corresponding click.</p>
          </div>
        </div>
      </div>
      
      <div className="mt-6 pt-4 border-t border-gray-700 space-y-4">
        {cameras.length > 1 && (
          <div className="space-y-2">
            <label htmlFor="camera-select" className="flex items-center text-sm font-medium text-gray-300">
              <Icon name="switch" className="w-5 h-5 mr-2" />
              Switch Camera
            </label>
            <select
              id="camera-select"
              value={selectedCameraId}
              onChange={(e) => onCameraChange(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 text-white transition"
            >
              {cameras.map((camera) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                  {camera.label || `Camera ${camera.deviceId.substring(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={onRecalibrate}
          className="w-full flex items-center justify-center px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white font-semibold transition-colors shadow-md"
        >
          <Icon name="target" className="w-5 h-5 mr-2" />
          Recalibrate
        </button>
      </div>
    </div>
  );
};

export default StatusDisplay;