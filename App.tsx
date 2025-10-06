
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mode, ClickState } from './types';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';

const App: React.FC = () => {
  const [mode, setMode] = useState<Mode>(Mode.None);
  const [isWebcamEnabled, setIsWebcamEnabled] = useState<boolean>(false);
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });
  const [clickState, setClickState] = useState<ClickState>('none');
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const targetPosition = useRef({ x: 0, y: 0 });
  const animationFrameId = useRef<number | null>(null);

  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      targetPosition.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    }
  }, []);

  const smoothMove = useCallback(() => {
    setCursorPosition(prevPos => {
      const dx = targetPosition.current.x - prevPos.x;
      const dy = targetPosition.current.y - prevPos.y;
      // Linear interpolation for smooth movement
      const newX = prevPos.x + dx * 0.1;
      const newY = prevPos.y + dy * 0.1;
      return { x: newX, y: newY };
    });
    animationFrameId.current = requestAnimationFrame(smoothMove);
  }, []);

  useEffect(() => {
    if (mode === Mode.Gaze) {
      if (!animationFrameId.current) {
        animationFrameId.current = requestAnimationFrame(smoothMove);
      }
    } else {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
    }
    return () => {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [mode, smoothMove]);
  
  const handleKeyAction = useCallback((key: string, isKeyDown: boolean) => {
    if (isKeyDown) {
        if (mode === Mode.Click) {
            if (key.toLowerCase() === 'l') {
                setClickState('left');
                setTimeout(() => setClickState('none'), 200);
            } else if (key.toLowerCase() === 'r') {
                setClickState('right');
                setTimeout(() => setClickState('none'), 200);
            }
        }
    }
  }, [mode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'g') setMode(Mode.Gaze);
      else if (key === 'c') setMode(Mode.Click);
      else handleKeyAction(event.key, true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'g' && mode === Mode.Gaze) setMode(Mode.None);
      else if (key === 'c' && mode === Mode.Click) setMode(Mode.None);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleMouseMove, mode, handleKeyAction]);

  const handleEnableWebcam = () => {
    setIsWebcamEnabled(true);
  };
  
  return (
    <div ref={containerRef} className="relative w-screen h-screen bg-gray-900 text-gray-200 flex flex-col md:flex-row items-center justify-center overflow-hidden p-4 md:p-8">
      {!isWebcamEnabled && (
         <div className="absolute inset-0 bg-black bg-opacity-70 flex flex-col items-center justify-center z-20">
            <h1 className="text-4xl font-bold mb-4">Webcam Gaze Tracker</h1>
            <p className="text-lg mb-8 max-w-lg text-center">This application simulates eye tracking to control an on-screen cursor. Enable your webcam to begin.</p>
            <button
              onClick={handleEnableWebcam}
              className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-semibold transition-colors shadow-lg"
            >
              Enable Webcam
            </button>
         </div>
      )}
      
      <div className="w-full h-1/2 md:h-full md:w-2/3 flex items-center justify-center p-4">
        <WebcamView videoRef={videoRef} isEnabled={isWebcamEnabled} />
      </div>
      <div className="w-full h-1/2 md:h-full md:w-1/3 p-4 flex items-center justify-center">
        <StatusDisplay mode={mode} />
      </div>

      {isWebcamEnabled && <GazeCursor position={cursorPosition} clickState={clickState} />}
    </div>
  );
};

export default App;
