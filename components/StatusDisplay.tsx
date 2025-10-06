import React from 'react';
import { CalibrationState } from '../types';
import Icon from './Icon';

interface StatusDisplayProps {
  calibrationState: CalibrationState;
  cameras: MediaDeviceInfo[];
  selectedCameraId: string;
  onCameraChange: (deviceId: string) => void;
  onRecalibrate: () => void;
}

const StatusDisplay: React.FC<StatusDisplayProps> = ({ calibrationState, cameras, selectedCameraId, onCameraChange, onRecalibrate }) => {
  const getStatusText = () => {
    switch (calibrationState) {
      case 'inProgress':
        return 'Calibrating...';
      case 'finished':
        return 'Tracking Active';
      default:
        return 'Initializing...';
    }
  };

  const getStatusColor = () => {
    switch (calibrationState) {
      case 'inProgress':
        return 'text-yellow-400';
      case 'finished':
        return 'text-cyan-400';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <div className="w-full max-w-sm p-6 bg-gray-800 border border-gray-700 rounded-xl shadow-lg flex flex-col">
      <h2 className="text-2xl font-bold text-center mb-2">Controls</h2>
      <div className="text-center mb-6">
        <p className={`text-lg font-semibold ${getStatusColor()}`}>{getStatusText()}</p>
        {calibrationState === 'finished' && (
          <button onClick={onRecalibrate} className="mt-2 text-sm underline text-cyan-400 hover:text-cyan-300 transition-colors">
            Recalibrate
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-start space-x-4 p-4 rounded-lg bg-gray-800/50 border border-gray-700">
          <Icon name="eye" className="w-8 h-8 text-cyan-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-bold">Gaze Tracking</h3>
            <p className="text-sm text-gray-400">The cursor will follow your gaze after calibration is complete.</p>
          </div>
        </div>
        
        <div className="flex items-start space-x-4 p-4 rounded-lg bg-gray-800/50 border border-gray-700">
          <Icon name="click" className="w-8 h-8 text-lime-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-bold">Blink Click</h3>
            <p className="text-sm text-gray-400">Blink your left or right eye to trigger a click.</p>
          </div>
        </div>

        <div className="flex items-start space-x-4 p-4 rounded-lg bg-gray-800/50 border border-gray-700">
          <Icon name="plus" className="w-8 h-8 text-yellow-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-bold">Live Correction</h3>
            <p className="text-sm text-gray-400">Hold <kbd className="px-2 py-1 text-xs font-semibold text-gray-800 bg-gray-200 border border-gray-300 rounded-md">Shift</kbd> and click anywhere to refine tracking accuracy.</p>
          </div>
        </div>
      </div>
      
      <div className="mt-6 pt-4 border-t border-gray-700">
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
      </div>
    </div>
  );
};

export default StatusDisplay;