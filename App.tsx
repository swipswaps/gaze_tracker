import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';
import CalibrationScreen from './components/CalibrationScreen';
import { Mode, ClickState, CalibrationState, CalibrationPointData, CalibrationMap, BlinkStateMachine } from './types';
import Icon from './components/Icon';

// Extend the Window interface to include the 'cv' property
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
  freq: number; min_cutoff: number; beta: number; d_cutoff: number;
  x_prev: number; dx_prev: number; t_prev: number; firstTime: boolean;

  constructor(freq: number, min_cutoff = 1.0, beta = 0.0, d_cutoff = 1.0) {
    this.freq = freq; this.min_cutoff = min_cutoff; this.beta = beta; this.d_cutoff = d_cutoff;
    this.x_prev = 0; this.dx_prev = 0; this.t_prev = 0; this.firstTime = true;
  }

  filter(x: number, timestamp?: number): number {
    const t = timestamp || performance.now();
    if (this.firstTime) {
      this.firstTime = false; this.t_prev = t; this.x_prev = x; return x;
    }
    const t_e = (t - this.t_prev) / 1000;
    if (t_e <= 0) { return this.x_prev; }
    const dx = (x - this.x_prev) / t_e;
    const a_d = smoothingFactor(t_e, this.d_cutoff);
    const dx_hat = exponentialSmoothing(a_d, dx, this.dx_prev);
    this.dx_prev = dx_hat;
    const cutoff = this.min_cutoff + this.beta * Math.abs(dx_hat);
    const a = smoothingFactor(t_e, cutoff);
    const x_hat = exponentialSmoothing(a, x, this.x_prev);
    this.x_prev = x_hat; this.t_prev = t; return x_hat;
  }
}

// --- Constants ---
const CALIBRATION_POINTS = [
  { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 },
  { x: 0.1, y: 0.9 }, { x: 0.5, y: 0.9 }, { x: 0.9, y: 0.9 },
];
const TOTAL_CALIBRATION_POINTS = CALIBRATION_POINTS.length;
const FACE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_frontalface_default.xml';
const EYE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_eye.xml';
const EAR_THRESHOLD = 0.25;
const BLINK_CLOSING_FRAMES = 1;
const BLINK_CLOSED_FRAMES = 2;


const App: React.FC = () => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorPositionRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const eyePositionRef = useRef({ x: 0.5, y: 0.5 });
  const calibrationMapRef = useRef<CalibrationMap | null>(null);
  const cursorUpdateFrameIdRef = useRef<number>(0);
  const processVideoFrameIdRef = useRef<number>(0);
  const filterXRef = useRef(new OneEuroFilter(60, 0.7, 0.3, 1.0));
  const filterYRef = useRef(new OneEuroFilter(60, 0.7, 0.3, 1.0));
  const faceCascadeRef = useRef<any>(null);
  const eyeCascadeRef = useRef<any>(null);
  const leftEyeStateRef = useRef<BlinkStateMachine>({ state: 'idle', frames: 0 });
  const rightEyeStateRef = useRef<BlinkStateMachine>({ state: 'idle', frames: 0 });
  const modeRef = useRef<Mode>(Mode.None);

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
  const [isCvLoading, setIsCvLoading] = useState(true);
  const [cvError, setCvError] = useState<string | null>(null);

  // Keep a ref to the current mode to avoid stale closures in the animation frame loop
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Load OpenCV and classifiers
  useEffect(() => {
    const loadCv = async () => {
      // Poll for OpenCV to be ready
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (window.cv && window.cv.CascadeClassifier) {
            clearInterval(interval);
            resolve();
          }
        }, 100);
      });

      const createFileFromUrl = async (path: string, url: string) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        }
        const data = await response.arrayBuffer();
        const dataArr = new Uint8Array(data);
        window.cv.FS_createDataFile('/', path, dataArr, true, false, false);
      };

      await createFileFromUrl('haarcascade_frontalface_default.xml', FACE_CASCADE_URL);
      await createFileFromUrl('haarcascade_eye.xml', EYE_CASCADE_URL);

      faceCascadeRef.current = new window.cv.CascadeClassifier();
      faceCascadeRef.current.load('haarcascade_frontalface_default.xml');

      eyeCascadeRef.current = new window.cv.CascadeClassifier();
      eyeCascadeRef.current.load('haarcascade_eye.xml');

      setIsCvLoading(false);
    };

    loadCv().catch(err => {
      console.error("OpenCV loading failed:", err);
      setCvError("Failed to load AI models. Please check your network connection and try again.");
      setIsCvLoading(false);
    });
  }, []);

  // Real-time CV Processing Loop
  useEffect(() => {
    if (isCvLoading || cvError) return;

    const calculateEAR = (rect: any) => rect.height / rect.width;
    
    const updateBlinkState = (eyeStateRef: React.MutableRefObject<BlinkStateMachine>, ear: number, eyeSide: 'left' | 'right') => {
      const currentState = eyeStateRef.current.state;
      const { frames } = eyeStateRef.current;

      if (currentState === 'idle' && ear < EAR_THRESHOLD) {
        eyeStateRef.current = { state: 'closing', frames: 1 };
      } else if (currentState === 'closing') {
        if (ear < EAR_THRESHOLD) {
          if (frames >= BLINK_CLOSING_FRAMES) {
            eyeStateRef.current = { state: 'closed', frames: 1 };
          } else {
            eyeStateRef.current.frames++;
          }
        } else {
          eyeStateRef.current = { state: 'idle', frames: 0 };
        }
      } else if (currentState === 'closed') {
        if (ear >= EAR_THRESHOLD) {
          if (frames > 0 && frames <= BLINK_CLOSED_FRAMES + 3) {
            if (modeRef.current === Mode.Click) {
              setClickState(eyeSide);
              setTimeout(() => setClickState('none'), 200);
            }
          }
          eyeStateRef.current = { state: 'idle', frames: 0 };
        } else if (frames > BLINK_CLOSED_FRAMES * 5) {
          eyeStateRef.current = { state: 'idle', frames: 0 }; // Timeout if squinting
        } else {
          eyeStateRef.current.frames++;
        }
      }
    };
    
    const processVideo = () => {
      if (!videoRef.current || !processingCanvasRef.current || videoRef.current.paused || videoRef.current.ended) {
        processVideoFrameIdRef.current = requestAnimationFrame(processVideo); return;
      }
      const video = videoRef.current;
      const processingCanvas = processingCanvasRef.current;
      
      const displayCanvas = displayCanvasRef.current;
      const displayCtx = displayCanvas ? displayCanvas.getContext('2d') : null;
      if (displayCanvas && (displayCanvas.width !== video.videoWidth || displayCanvas.height !== video.videoHeight)) {
          displayCanvas.width = video.videoWidth;
          displayCanvas.height = video.videoHeight;
      }
      if (displayCtx) {
          displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
      }
      
      processingCanvas.width = video.videoWidth; processingCanvas.height = video.videoHeight;
      const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
      if (!processingCtx) { processVideoFrameIdRef.current = requestAnimationFrame(processVideo); return; }
      
      processingCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
      const src = window.cv.imread(processingCanvas);
      const gray = new window.cv.Mat();
      window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);

      const faces = new window.cv.RectVector();
      const minFaceSize = new window.cv.Size(video.videoWidth / 6, video.videoHeight / 6);
      faceCascadeRef.current.detectMultiScale(gray, faces, 1.1, 3, 0, minFaceSize);

      if (faces.size() > 0) {
        const face = faces.get(0);

        if (displayCtx) {
            displayCtx.strokeStyle = 'rgba(0, 255, 255, 0.8)'; // Cyan for face
            displayCtx.lineWidth = 4;
            displayCtx.strokeRect(face.x, face.y, face.width, face.height);
        }

        const faceROI = gray.roi(face);
        const eyes = new window.cv.RectVector();
        const minEyeSize = new window.cv.Size(face.width / 9, face.height / 9);
        eyeCascadeRef.current.detectMultiScale(faceROI, eyes, 1.1, 3, 0, minEyeSize);

        if (eyes.size() >= 2) {
          let eyeRects = [eyes.get(0), eyes.get(1)];
          eyeRects.sort((a, b) => a.x - b.x);
          
          if (displayCtx) {
              displayCtx.strokeStyle = 'rgba(0, 255, 0, 0.8)'; // Green for eyes
              displayCtx.lineWidth = 2;
              eyeRects.forEach(eye => {
                  displayCtx.strokeRect(face.x + eye.x, face.y + eye.y, eye.width, eye.height);
              });
          }

          const [leftEyeRect, rightEyeRect] = eyeRects;

          const findPupilCenter = (eyeRect: any) => {
              const eyeROI = faceROI.roi(eyeRect);
              
              // New pupil detection logic
              let pupilCenter;
              const blurred = new window.cv.Mat();
              window.cv.GaussianBlur(eyeROI, blurred, new window.cv.Size(5, 5), 0);
              
              const meanScalar = window.cv.mean(blurred);
              const thresholdValue = meanScalar[0] * 0.7; // Dynamic threshold
              
              const thresholded = new window.cv.Mat();
              window.cv.threshold(blurred, thresholded, thresholdValue, 255, window.cv.THRESH_BINARY_INV);
              
              const contours = new window.cv.MatVector();
              const hierarchy = new window.cv.Mat();
              window.cv.findContours(thresholded, contours, hierarchy, window.cv.RETR_EXTERNAL, window.cv.CHAIN_APPROX_SIMPLE);

              let bestPupil = null;
              let maxArea = 0;

              for (let i = 0; i < contours.size(); ++i) {
                  const contour = contours.get(i);
                  const area = window.cv.contourArea(contour);
                  if (area > 10 && area > maxArea) {
                      if (bestPupil) bestPupil.delete();
                      maxArea = area;
                      bestPupil = contour;
                  } else {
                      contour.delete();
                  }
              }

              if (bestPupil) {
                  const M = window.cv.moments(bestPupil);
                  if (M.m00 !== 0) {
                      pupilCenter = {
                          x: face.x + eyeRect.x + M.m10 / M.m00,
                          y: face.y + eyeRect.y + M.m01 / M.m00
                      };
                  }
                  bestPupil.delete();
              }
              
              if (!pupilCenter) {
                  // Fallback to center of eye rectangle
                  pupilCenter = {
                      x: face.x + eyeRect.x + eyeRect.width / 2,
                      y: face.y + eyeRect.y + eyeRect.height / 2
                  };
              }
              
              if (displayCtx) {
                  displayCtx.fillStyle = 'rgba(255, 0, 0, 0.8)'; // Red dot for pupil
                  displayCtx.beginPath();
                  displayCtx.arc(pupilCenter.x, pupilCenter.y, 3, 0, 2 * Math.PI, false);
                  displayCtx.fill();
              }
              
              // Cleanup
              eyeROI.delete();
              blurred.delete();
              thresholded.delete();
              contours.delete();
              hierarchy.delete();
              return pupilCenter;
          };

          const leftPupil = findPupilCenter(leftEyeRect);
          const rightPupil = findPupilCenter(rightEyeRect);

          const avgPupilX = (leftPupil.x + rightPupil.x) / 2;
          const avgPupilY = (leftPupil.y + rightPupil.y) / 2;

          const normalizedX = (avgPupilX - face.x) / face.width;
          const normalizedY = (avgPupilY - face.y) / face.height;
          
          eyePositionRef.current = { x: 1 - normalizedX, y: normalizedY };

          const leftEAR = calculateEAR(leftEyeRect);
          const rightEAR = calculateEAR(rightEyeRect);
          updateBlinkState(leftEyeStateRef, leftEAR, 'left');
          updateBlinkState(rightEyeStateRef, rightEAR, 'right');
        }
        faceROI.delete();
        eyes.delete();
      }
      src.delete();
      gray.delete();
      faces.delete();

      processVideoFrameIdRef.current = requestAnimationFrame(processVideo);
    };
    
    processVideoFrameIdRef.current = requestAnimationFrame(processVideo);
    return () => {
      cancelAnimationFrame(processVideoFrameIdRef.current);
    };

  }, [isCvLoading, cvError]);
  
  // Handlers
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
    } catch (err) { console.error("Error enumerating devices:", err); }
  }, []);

  const handleCameraChange = (deviceId: string) => {
    if (deviceId !== selectedCameraId) { setSelectedCameraId(deviceId); startCalibration(); }
  };

  const startCalibration = useCallback(() => {
    setCalibrationState('inProgress'); setCalibrationPointIndex(0); setCalibrationData([]);
  }, []);

  // Calibration Logic
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
          eyeMinX = Math.min(eyeMinX, d.eye.x); eyeMaxX = Math.max(eyeMaxX, d.eye.x);
          eyeMinY = Math.min(eyeMinY, d.eye.y); eyeMaxY = Math.max(eyeMaxY, d.eye.y);
        });
        const paddingX = (eyeMaxX - eyeMinX) * 0.1; const paddingY = (eyeMaxY - eyeMinY) * 0.1;
        calibrationMapRef.current = { eyeMinX: eyeMinX - paddingX, eyeMaxX: eyeMaxX + paddingX, eyeMinY: eyeMinY - paddingY, eyeMaxY: eyeMaxY + paddingY };
        setCalibrationState('finished');
      }
    }
  }, [calibrationState, calibrationPointIndex, calibrationData]);

  // Cursor Update Loop
  useEffect(() => {
    if (calibrationState !== 'finished') return;

    const updateCursor = () => {
      if (modeRef.current === Mode.Gaze && calibrationMapRef.current) {
        const map = calibrationMapRef.current;
        // Ensure map has a valid range to prevent division by zero
        if (map.eyeMaxX - map.eyeMinX !== 0 && map.eyeMaxY - map.eyeMinY !== 0) {
            const { x: rawEyeX, y: rawEyeY } = eyePositionRef.current;
            const normX = Math.max(0, Math.min(1, (rawEyeX - map.eyeMinX) / (map.eyeMaxX - map.eyeMinX)));
            const normY = Math.max(0, Math.min(1, (rawEyeY - map.eyeMinY) / (map.eyeMaxY - map.eyeMinY)));
            const targetX = normX * window.innerWidth;
            const targetY = normY * window.innerHeight;
            cursorPositionRef.current = { x: filterXRef.current.filter(targetX), y: filterYRef.current.filter(targetY) };
            setCursorPosition(cursorPositionRef.current);
        }
      }
      cursorUpdateFrameIdRef.current = requestAnimationFrame(updateCursor);
    };
    
    cursorUpdateFrameIdRef.current = requestAnimationFrame(updateCursor);
    
    return () => { 
        if (cursorUpdateFrameIdRef.current) { 
            cancelAnimationFrame(cursorUpdateFrameIdRef.current); 
        } 
    };
  }, [calibrationState]);

  // Keyboard controls
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
    window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [mode, calibrationState]);

  // Auto-start calibration
  useEffect(() => {
    if (isWebcamEnabled && videoRef.current && !isCvLoading && !cvError) {
      const videoEl = videoRef.current;
      const onCanPlay = () => setTimeout(() => startCalibration(), 1000);
      videoEl.addEventListener('canplay', onCanPlay);
      return () => { if (videoEl) videoEl.removeEventListener('canplay', onCanPlay); };
    }
  }, [isWebcamEnabled, startCalibration, isCvLoading, cvError]);

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden">
      <canvas ref={processingCanvasRef} style={{ display: 'none' }} />
      <header className="absolute top-0 left-0 p-4 z-10">
        <h1 className="text-2xl font-bold tracking-wider">GazeTrack AI</h1>
        <p className="text-sm text-gray-400">Real-time gaze and blink detection.</p>
      </header>
      
      {(isCvLoading || cvError) && (
         <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-30">
            {isCvLoading ? (
                <>
                    <Icon name="eye" className="w-16 h-16 mb-4 text-cyan-400 animate-pulse" />
                    <h2 className="text-2xl font-bold mb-2">Loading AI Models...</h2>
                    <p className="text-gray-300">Please wait, this may take a moment.</p>
                </>
            ) : (
                 <div className="text-center text-red-400">
                    <Icon name="camera" className="w-16 h-16 mb-4 opacity-50" />
                    <p className="text-lg font-bold mb-2">Error Loading Models</p>
                    <p className="max-w-md">{cvError}</p>
                 </div>
            )}
         </div>
      )}

      <main className="flex flex-col md:flex-row items-center justify-center gap-8 w-full">
        <WebcamView videoRef={videoRef} isEnabled={isWebcamEnabled} selectedCameraId={selectedCameraId} onStreamAcquired={handleStreamAcquired} canvasRef={displayCanvasRef} />
        <StatusDisplay mode={mode} onRecalibrate={startCalibration} cameras={cameras} selectedCameraId={selectedCameraId} onCameraChange={handleCameraChange} />
      </main>
      
      {calibrationState !== 'finished' && <CalibrationScreen state={calibrationState} totalPoints={TOTAL_CALIBRATION_POINTS} currentPointIndex={calibrationPointIndex} pointPosition={CALIBRATION_POINTS[calibrationPointIndex]} />}
      {calibrationState === 'finished' && (mode === Mode.Gaze || mode === Mode.Click) && <GazeCursor position={cursorPosition} clickState={clickState} />}
    </div>
  );
};

export default App;