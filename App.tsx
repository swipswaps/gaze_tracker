import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';
import CalibrationScreen from './components/CalibrationScreen';
import { Mode, ClickState, CalibrationState, CalibrationPointData, CalibrationMap } from './types';

// Declare cv on the window object for dynamic script loading from CDN
declare global {
  interface Window {
    cv: any;
  }
}

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
    
    const dx = (x - this.x_prev) / t_e;
    const a_d = smoothingFactor(t_e, this.d_cutoff);
    const dx_hat = exponentialSmoothing(a_d, dx, this.dx_prev);
    this.dx_prev = dx_hat;

    const cutoff = this.min_cutoff + this.beta * Math.abs(dx_hat);
    const a = smoothingFactor(t_e, cutoff);
    const x_hat = exponentialSmoothing(a, x, this.x_prev);
    this.x_prev = x_hat;
    
    this.t_prev = t;
    
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

// CV constants
const EAR_THRESHOLD = 0.22;
const MIN_BLINK_DURATION_MS = 80;
const MAX_BLINK_DURATION_MS = 500;


const App: React.FC = () => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorPositionRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const eyePositionRef = useRef({ x: 0.5, y: 0.5 });
  const calibrationMapRef = useRef<CalibrationMap | null>(null);
  const animationFrameIdRef = useRef<number>(0);
  const filterXRef = useRef(new OneEuroFilter(60, 1.5, 0.5, 1.0));
  const filterYRef = useRef(new OneEuroFilter(60, 1.5, 0.5, 1.0));
  const modeRef = useRef(Mode.None);

  // CV Refs
  const faceClassifierRef = useRef<any>(null);
  const eyeClassifierRef = useRef<any>(null);
  const leftEyeStateRef = useRef<'OPEN' | 'CLOSED'>('OPEN');
  const rightEyeStateRef = useRef<'OPEN' | 'CLOSED'>('OPEN');
  const leftEyeClosedTimestampRef = useRef(0);
  const rightEyeClosedTimestampRef = useRef(0);

  // State
  const [isWebcamEnabled, setIsWebcamEnabled] = useState(true);
  const [mode, setMode] = useState<Mode>(Mode.None);
  const [clickState, setClickState] = useState<ClickState>('none');
  const [cursorPosition, setCursorPosition] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [calibrationState, setCalibrationState] = useState<CalibrationState>('notStarted');
  const [calibrationPointIndex, setCalibrationPointIndex] = useState(0);
  const [calibrationData, setCalibrationData] = useState<CalibrationPointData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading AI model...');

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const loadOpenCvAndClassifiers = async () => {
      // Load OpenCV script
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://docs.opencv.org/4.x/opencv.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
        document.body.appendChild(script);
      });

      if (!window.cv) {
        setLoadingMessage('Error loading OpenCV. Please try again.');
        return;
      }
      setLoadingMessage('Initializing classifiers...');

      try {
        const createFile = async (url: string) => {
          const response = await fetch(url);
          const buffer = await response.arrayBuffer();
          const data = new Uint8Array(buffer);
          const fileName = url.split('/').pop()!;
          window.cv.FS_createDataFile('/', fileName, data, true, false, false);
          return fileName;
        };

        const faceCascadeFile = await createFile('https://cdn.jsdelivr.net/gh/opencv/opencv@4.x/data/haarcascades/haarcascade_frontalface_default.xml');
        const eyeCascadeFile = await createFile('https://cdn.jsdelivr.net/gh/opencv/opencv@4.x/data/haarcascades/haarcascade_eye.xml');

        faceClassifierRef.current = new window.cv.CascadeClassifier();
        faceClassifierRef.current.load(faceCascadeFile);

        eyeClassifierRef.current = new window.cv.CascadeClassifier();
        eyeClassifierRef.current.load(eyeCascadeFile);

        setIsLoading(false);
        setLoadingMessage('');
      } catch (error) {
        console.error('Error loading classifiers:', error);
        setLoadingMessage('Failed to load AI classifiers. Please refresh.');
      }
    };

    loadOpenCvAndClassifiers();
  }, []);

  const processVideo = useCallback(() => {
    if (!videoRef.current || videoRef.current.paused || videoRef.current.ended || !faceClassifierRef.current || !eyeClassifierRef.current) {
      animationFrameIdRef.current = requestAnimationFrame(processVideo);
      return;
    }

    const video = videoRef.current;
    const src = new window.cv.Mat(video.videoHeight, video.videoWidth, window.cv.CV_8UC4);
    const cap = new window.cv.VideoCapture(video);
    cap.read(src);
    const gray = new window.cv.Mat();
    window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
    window.cv.flip(src, src, 1); // Mirror the frame
    window.cv.flip(gray, gray, 1);

    const faces = new window.cv.RectVector();
    faceClassifierRef.current.detectMultiScale(gray, faces);

    if (faces.size() > 0) {
      const faceRect = faces.get(0);
      const faceROI = gray.roi(faceRect);
      const eyes = new window.cv.RectVector();
      eyeClassifierRef.current.detectMultiScale(faceROI, eyes);

      const detectedEyes = [];
      for (let i = 0; i < eyes.size(); ++i) {
        detectedEyes.push(eyes.get(i));
      }

      if (detectedEyes.length >= 2) {
        detectedEyes.sort((a, b) => a.x - b.x); // Left eye will be first
        const leftEyeRect = detectedEyes[0];
        const rightEyeRect = detectedEyes[1];
        
        const eyeCenterX = faceRect.x + (leftEyeRect.x + rightEyeRect.x + rightEyeRect.width) / 2;
        const eyeCenterY = faceRect.y + (leftEyeRect.y + leftEyeRect.height / 2 + rightEyeRect.y + rightEyeRect.height / 2) / 2;
        
        eyePositionRef.current = {
            x: eyeCenterX / video.videoWidth,
            y: eyeCenterY / video.videoHeight,
        };

        // --- Enhanced Blink Detection ---
        const leftEar = leftEyeRect.height / leftEyeRect.width;
        if (leftEar < EAR_THRESHOLD) {
          if (leftEyeStateRef.current === 'OPEN') {
            leftEyeStateRef.current = 'CLOSED';
            leftEyeClosedTimestampRef.current = performance.now();
          }
        } else {
          if (leftEyeStateRef.current === 'CLOSED') {
            const duration = performance.now() - leftEyeClosedTimestampRef.current;
            if (duration >= MIN_BLINK_DURATION_MS && duration <= MAX_BLINK_DURATION_MS) {
              if (modeRef.current === Mode.Click) setClickState('left');
            }
          }
          leftEyeStateRef.current = 'OPEN';
        }

        const rightEar = rightEyeRect.height / rightEyeRect.width;
        if (rightEar < EAR_THRESHOLD) {
          if (rightEyeStateRef.current === 'OPEN') {
            rightEyeStateRef.current = 'CLOSED';
            rightEyeClosedTimestampRef.current = performance.now();
          }
        } else {
          if (rightEyeStateRef.current === 'CLOSED') {
            const duration = performance.now() - rightEyeClosedTimestampRef.current;
            if (duration >= MIN_BLINK_DURATION_MS && duration <= MAX_BLINK_DURATION_MS) {
              if (modeRef.current === Mode.Click) setClickState('right');
            }
          }
          rightEyeStateRef.current = 'OPEN';
        }
      }
      faceROI.delete();
      eyes.delete();
    }

    src.delete();
    gray.delete();
    faces.delete();

    animationFrameIdRef.current = requestAnimationFrame(processVideo);
  }, []);

  useEffect(() => {
    if (!isLoading && isWebcamEnabled && videoRef.current) {
        const videoEl = videoRef.current;
        const onLoadedData = () => {
            animationFrameIdRef.current = requestAnimationFrame(processVideo);
        }
        videoEl.addEventListener('loadeddata', onLoadedData);
        return () => {
            videoEl.removeEventListener('loadeddata', onLoadedData);
            if(animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
        }
    }
  }, [isLoading, isWebcamEnabled, processVideo]);

  const startCalibration = useCallback(() => {
    if (calibrationState !== 'notStarted') return;
    setCalibrationState('inProgress');
    setCalibrationPointIndex(0);
    setCalibrationData([]);
  }, [calibrationState]);
  
  useEffect(() => {
    if (calibrationState !== 'inProgress') return;

    if (calibrationPointIndex < TOTAL_CALIBRATION_POINTS) {
      const timer = setTimeout(() => {
        setCalibrationData(prev => [...prev, { screen: CALIBRATION_POINTS[calibrationPointIndex], eye: { ...eyePositionRef.current } }]);
        setCalibrationPointIndex(prev => prev + 1);
      }, 2500);
      return () => clearTimeout(timer);
    } else {
      if (calibrationData.length === TOTAL_CALIBRATION_POINTS) {
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
          eyeMinX: eyeMinX - paddingX, eyeMaxX: eyeMaxX + paddingX,
          eyeMinY: eyeMinY - paddingY, eyeMaxY: eyeMaxY + paddingY,
        };
        setCalibrationState('finished');
      }
    }
  }, [calibrationState, calibrationPointIndex, calibrationData]);

  useEffect(() => {
    const updateCursor = () => {
      if (mode === Mode.Gaze && calibrationMapRef.current) {
        const map = calibrationMapRef.current;
        const { x: rawEyeX, y: rawEyeY } = eyePositionRef.current;

        const normX = Math.max(0, Math.min(1, (rawEyeX - map.eyeMinX) / (map.eyeMaxX - map.eyeMinX)));
        const normY = Math.max(0, Math.min(1, (rawEyeY - map.eyeMinY) / (map.eyeMaxY - map.eyeMinY)));

        const targetX = normX * window.innerWidth;
        const targetY = normY * window.innerHeight;

        const smoothedX = filterXRef.current.filter(targetX);
        const smoothedY = filterYRef.current.filter(targetY);

        cursorPositionRef.current = { x: smoothedX, y: smoothedY };
        setCursorPosition(cursorPositionRef.current);
      }
      animationFrameIdRef.current = requestAnimationFrame(updateCursor);
    };

    if (calibrationState === 'finished' && mode === Mode.Gaze) {
      animationFrameIdRef.current = requestAnimationFrame(updateCursor);
    }

    return () => {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [mode, calibrationState]);

  useEffect(() => {
    if (clickState !== 'none') {
      const timer = setTimeout(() => setClickState('none'), 200);
      return () => clearTimeout(timer);
    }
  }, [clickState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || calibrationState !== 'finished') return;
      switch (e.key.toLowerCase()) {
        case 'g': setMode(Mode.Gaze); break;
        case 'c': setMode(Mode.Click); break;
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
       switch (e.key.toLowerCase()) {
        case 'g': if (mode === Mode.Gaze) setMode(Mode.None); break;
        case 'c': if (mode === Mode.Click) setMode(Mode.None); break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [mode, clickState, calibrationState]);

  useEffect(() => {
    if (isWebcamEnabled && !isLoading && videoRef.current) {
      const videoEl = videoRef.current;
      const onCanPlay = () => {
        if (calibrationState === 'notStarted') {
          setTimeout(startCalibration, 1000);
        }
      };
      videoEl.addEventListener('canplay', onCanPlay);
      return () => videoEl.removeEventListener('canplay', onCanPlay);
    }
  }, [isWebcamEnabled, isLoading, startCalibration, calibrationState]);

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden">
      {isLoading && (
         <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-30">
            <h2 className="text-2xl font-bold mb-4 animate-pulse">{loadingMessage}</h2>
            <p className="text-gray-300">This may take a moment...</p>
         </div>
      )}
      <header className="absolute top-0 left-0 p-4 z-10">
        <h1 className="text-2xl font-bold tracking-wider">GazeTrack AI</h1>
        <p className="text-sm text-gray-400">Real-time gaze and blink detection enabled.</p>
      </header>

      <main className="flex flex-col md:flex-row items-center justify-center gap-8 w-full">
        <WebcamView videoRef={videoRef} isEnabled={isWebcamEnabled} />
        <StatusDisplay 
          mode={mode}
          onRecalibrate={startCalibration}
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
