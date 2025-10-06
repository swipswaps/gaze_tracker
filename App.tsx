import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';
import CalibrationScreen from './components/CalibrationScreen';
import { Mode, ClickState, CalibrationState, CalibrationPointData, CalibrationMap } from './types';

// --- OneEuroFilter Implementation ---

function smoothingFactor(t_e: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * t_e;
  return r / (r + 1);
}

function exponentialSmoothing(a: number, x: number, x_prev: number): number {
  return a * x + (1 - a) * x_prev;
}

class OneEuroFilter {
  freq: number;
  min_cutoff: number;
  beta: number;
  d_cutoff: number;
  
  x_prev: number;
  dx_prev: number;
  t_prev: number;
  
  firstTime: boolean;

  constructor(freq: number, min_cutoff = 1.0, beta = 0.0, d_cutoff = 1.0) {
    this.freq = freq;
    this.min_cutoff = min_cutoff;
    this.beta = beta;
    this.d_cutoff = d_cutoff;
    
    this.x_prev = 0;
    this.dx_prev = 0;
    this.t_prev = 0;
    
    this.firstTime = true;
  }

  filter(x: number, timestamp?: number): number {
    const t = timestamp || performance.now();

    if (this.firstTime) {
      this.firstTime = false;
      this.t_prev = t;
      this.x_prev = x;
      return x;
    }

    const t_e = (t - this.t_prev) / 1000; // time elapsed in seconds
    if (t_e <= 0) {
        return this.x_prev;
    }
    
    // The filtered derivative of the signal.
    const dx = (x - this.x_prev) / t_e;
    const a_d = smoothingFactor(t_e, this.d_cutoff);
    const dx_hat = exponentialSmoothing(a_d, dx, this.dx_prev);
    this.dx_prev = dx_hat;

    // The filtered signal.
    const cutoff = this.min_cutoff + this.beta * Math.abs(dx_hat);
    const a = smoothingFactor(t_e, cutoff);
    const x_hat = exponentialSmoothing(a, x, this.x_prev);
    this.x_prev = x_hat;
    
    this.t_prev = t; // update t_prev at the end
    
    return x_hat;
  }
}


// --- Constants ---
const CALIBRATION_POINTS = [
  { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 },
  { x: 0.1, y: 0.9 }, { x: 0.5, y: 0.9 }, { x: 0.9, y: 0.9 },
];
const TOTAL_CALIBRATION_POINTS = CALIBRATION_POINTS.length;

const App: React.FC = () => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorPositionRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const eyePositionRef = useRef({ x: 0.5, y: 0.5 }); // Normalized 0-1, represents gaze on video feed
  const calibrationMapRef = useRef<CalibrationMap | null>(null);
  const animationFrameIdRef = useRef<number>(0);
  const filterXRef = useRef(new OneEuroFilter(60, 1.5, 0.5, 1.0));
  const filterYRef = useRef(new OneEuroFilter(60, 1.5, 0.5, 1.0));


  // State
  const [isWebcamEnabled, setIsWebcamEnabled] = useState(true);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [mode, setMode] = useState<Mode>(Mode.None);
  const [clickState, setClickState] = useState<ClickState>('none');
  const [cursorPosition, setCursorPosition] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [calibrationState, setCalibrationState] = useState<CalibrationState>('notStarted');
  const [calibrationPointIndex, setCalibrationPointIndex] = useState(0);
  const [calibrationData, setCalibrationData] = useState<CalibrationPointData[]>([]);

  // MOCK: Simulate eye tracking using mouse position over the webcam view.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = videoEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      // Flip X because webcam view is mirrored for a natural feel
      eyePositionRef.current = { x: 1 - x, y: y };
    };

    videoEl.addEventListener('mousemove', handleMouseMove);
    return () => {
      if (videoEl) {
        videoEl.removeEventListener('mousemove', handleMouseMove);
      }
    };
  }, [isWebcamEnabled]);

  const handleStreamAcquired = useCallback(async (stream: MediaStream) => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      setCameras(videoDevices);
      if (videoDevices.length > 0) {
        const currentTrack = stream.getVideoTracks()[0];
        const currentDeviceId = currentTrack.getSettings().deviceId;
        if (currentDeviceId && videoDevices.some(d => d.deviceId === currentDeviceId)) {
             setSelectedCameraId(currentDeviceId);
        } else {
             setSelectedCameraId(videoDevices[0].deviceId);
        }
      }
    } catch (err) {
      console.error("Error enumerating devices:", err);
    }
  }, []);

  const handleCameraChange = (deviceId: string) => {
    if (deviceId !== selectedCameraId) {
      setSelectedCameraId(deviceId);
    }
  };

  const startCalibration = useCallback(() => {
    setCalibrationState('inProgress');
    setCalibrationPointIndex(0);
    setCalibrationData([]);
  }, []);

  // Handle calibration process
  useEffect(() => {
    if (calibrationState !== 'inProgress') return;

    if (calibrationPointIndex < TOTAL_CALIBRATION_POINTS) {
      const timer = setTimeout(() => {
        setCalibrationData(prev => [
          ...prev,
          {
            screen: CALIBRATION_POINTS[calibrationPointIndex],
            eye: { ...eyePositionRef.current },
          },
        ]);
        setCalibrationPointIndex(prev => prev + 1);
      }, 2500); // Wait for user to focus, then capture
      return () => clearTimeout(timer);
    } else {
      if (calibrationData.length === TOTAL_CALIBRATION_POINTS) {
        // Calculate the mapping from eye-space to screen-space
        let eyeMinX = Infinity, eyeMaxX = -Infinity, eyeMinY = Infinity, eyeMaxY = -Infinity;
        calibrationData.forEach(d => {
          eyeMinX = Math.min(eyeMinX, d.eye.x);
          eyeMaxX = Math.max(eyeMaxX, d.eye.x);
          eyeMinY = Math.min(eyeMinY, d.eye.y);
          eyeMaxY = Math.max(eyeMaxY, d.eye.y);
        });
        
        const paddingX = (eyeMaxX - eyeMinX) * 0.1;
        const paddingY = (eyeMaxY - eyeMinY) * 0.1;

        calibrationMapRef.current = {
          eyeMinX: eyeMinX - paddingX,
          eyeMaxX: eyeMaxX + paddingX,
          eyeMinY: eyeMinY - paddingY,
          eyeMaxY: eyeMaxY + paddingY,
        };
        setCalibrationState('finished');
      }
    }
  }, [calibrationState, calibrationPointIndex, calibrationData]);

  // Main gaze tracking loop
  useEffect(() => {
    const updateCursor = () => {
      if (mode === Mode.Gaze && calibrationMapRef.current) {
        const map = calibrationMapRef.current;
        const { x: rawEyeX, y: rawEyeY } = eyePositionRef.current;

        // Clamp and normalize eye coordinates based on calibration map
        const normX = Math.max(0, Math.min(1, (rawEyeX - map.eyeMinX) / (map.eyeMaxX - map.eyeMinX)));
        const normY = Math.max(0, Math.min(1, (rawEyeY - map.eyeMinY) / (map.eyeMaxY - map.eyeMinY)));

        const targetX = normX * window.innerWidth;
        const targetY = normY * window.innerHeight;

        // Use OneEuroFilter for advanced smoothing
        const smoothedX = filterXRef.current.filter(targetX);
        const smoothedY = filterYRef.current.filter(targetY);

        cursorPositionRef.current = {
          x: smoothedX,
          y: smoothedY,
        };
        setCursorPosition(cursorPositionRef.current);
      }
      animationFrameIdRef.current = requestAnimationFrame(updateCursor);
    };

    if (calibrationState === 'finished' && mode === Mode.Gaze) {
      animationFrameIdRef.current = requestAnimationFrame(updateCursor);
    }

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [mode, calibrationState]);

  // Keyboard event handlers for mode switching and simulated clicks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || calibrationState !== 'finished') return;
      
      switch (e.key.toLowerCase()) {
        case 'g':
          setMode(Mode.Gaze);
          break;
        case 'c':
          setMode(Mode.Click);
          break;
        // Simulate blink-to-click with 'l' and 'r' keys while 'c' is held
        case 'l':
          if (mode === Mode.Click) setClickState('left');
          break;
        case 'r':
          if (mode === Mode.Click) setClickState('right');
          break;
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
       switch (e.key.toLowerCase()) {
        case 'g':
          if (mode === Mode.Gaze) setMode(Mode.None);
          break;
        case 'c':
          if (mode === Mode.Click) setMode(Mode.None);
          break;
        case 'l':
        case 'r':
          if (clickState !== 'none') {
            setTimeout(() => setClickState('none'), 150); // Reset visual feedback
          }
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [mode, clickState, calibrationState]);

  // Automatically start calibration once the webcam is ready
  useEffect(() => {
    if (isWebcamEnabled && videoRef.current) {
      const videoEl = videoRef.current;
      const onCanPlay = () => {
        setTimeout(() => startCalibration(), 1000); // Delay to ensure stream is stable
      };
      videoEl.addEventListener('canplay', onCanPlay);
      return () => {
        if (videoEl) {
          videoEl.removeEventListener('canplay', onCanPlay);
        }
      }
    }
  }, [isWebcamEnabled, startCalibration]);

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden">
      <header className="absolute top-0 left-0 p-4 z-10">
        <h1 className="text-2xl font-bold tracking-wider">GazeTrack AI</h1>
        <p className="text-sm text-gray-400">Move your mouse over the webcam view to simulate eye movement.</p>
      </header>

      <main className="flex flex-col md:flex-row items-center justify-center gap-8 w-full">
        <WebcamView 
          videoRef={videoRef} 
          isEnabled={isWebcamEnabled}
          selectedCameraId={selectedCameraId}
          onStreamAcquired={handleStreamAcquired}
        />
        <StatusDisplay 
          mode={mode}
          onRecalibrate={startCalibration}
          cameras={cameras}
          selectedCameraId={selectedCameraId}
          onCameraChange={handleCameraChange}
        />
      </main>
      
      {calibrationState !== 'finished' && (
        <CalibrationScreen 
          state={calibrationState}
          totalPoints={TOTAL_CALIBRATION_POINTS}
          currentPointIndex={calibrationPointIndex}
          pointPosition={CALIBRATION_POINTS[calibrationPointIndex]}
        />
      )}
      
      {calibrationState === 'finished' && (mode === Mode.Gaze || mode === Mode.Click) && (
        <GazeCursor position={cursorPosition} clickState={clickState} />
      )}
    </div>
  );
};

export default App;