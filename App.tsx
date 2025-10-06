import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import CalibrationScreen from './components/CalibrationScreen';
import GazeCursor from './components/GazeCursor';
import { ClickState, CalibrationState, CalibrationPointData, BlinkStateMachine } from './types';
import Icon from './components/Icon';

// Extend the Window interface to include the 'cv' property
declare global {
  interface Window {
    cv: any;
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
const K_NEAREST_NEIGHBORS = 4;
const INVERSE_DISTANCE_POWER = 2;
const CORRECTION_SNAP_THRESHOLD = 0.1; // Increased for more aggressive snapping. If eye position is this close to a correction point, snap to it.

// --- Helper Functions ---
const mapEyeToScreen = (currentEyePos: { x: number, y: number }, calibrationPoints: CalibrationPointData[]) => {
    if (calibrationPoints.length < K_NEAREST_NEIGHBORS) {
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }

    // Check for a close correction point to "snap" to
    for (const point of calibrationPoints) {
        const dist = Math.sqrt(Math.pow(point.eye.x - currentEyePos.x, 2) + Math.pow(point.eye.y - currentEyePos.y, 2));
        if (dist < CORRECTION_SNAP_THRESHOLD) {
            return {
                x: point.screen.x * window.innerWidth,
                y: point.screen.y * window.innerHeight,
            };
        }
    }

    const distances = calibrationPoints.map(point => ({
        ...point,
        dist: Math.sqrt(Math.pow(point.eye.x - currentEyePos.x, 2) + Math.pow(point.eye.y - currentEyePos.y, 2))
    }));

    distances.sort((a, b) => a.dist - b.dist);
    const nearestNeighbors = distances.slice(0, K_NEAREST_NEIGHBORS);

    let totalWeight = 0;
    let weightedScreenX = 0;
    let weightedScreenY = 0;
    const epsilon = 1e-9;

    nearestNeighbors.forEach(neighbor => {
        const weight = 1 / (Math.pow(neighbor.dist, INVERSE_DISTANCE_POWER) + epsilon);
        totalWeight += weight;
        weightedScreenX += neighbor.screen.x * weight;
        weightedScreenY += neighbor.screen.y * weight;
    });
    
    if (totalWeight === 0) {
       return { 
           x: nearestNeighbors[0].screen.x * window.innerWidth,
           y: nearestNeighbors[0].screen.y * window.innerHeight
       };
    }

    const finalScreenX = weightedScreenX / totalWeight;
    const finalScreenY = weightedScreenY / totalWeight;
    
    const clampedX = Math.max(0, Math.min(1, finalScreenX));
    const clampedY = Math.max(0, Math.min(1, finalScreenY));

    return {
        x: clampedX * window.innerWidth,
        y: clampedY * window.innerHeight,
    };
};


const App: React.FC = () => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const eyePositionRef = useRef({ x: 0.5, y: 0.5 });
  const processVideoFrameIdRef = useRef<number>(0);
  const faceCascadeRef = useRef<any>(null);
  const eyeCascadeRef = useRef<any>(null);
  const leftEyeStateRef = useRef<BlinkStateMachine>({ state: 'idle', frames: 0 });
  const rightEyeStateRef = useRef<BlinkStateMachine>({ state: 'idle', frames: 0 });
  const targetPositionRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const smoothedCursorPosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const calibrationStateRef = useRef<CalibrationState>('notStarted');
  const calibrationDataRef = useRef<CalibrationPointData[]>([]);

  // State
  const [isWebcamEnabled, setIsWebcamEnabled] = useState(true);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [calibrationState, setCalibrationState] = useState<CalibrationState>('notStarted');
  const [calibrationPointIndex, setCalibrationPointIndex] = useState(0);
  const [calibrationData, setCalibrationData] = useState<CalibrationPointData[]>([]);
  const [isCvLoading, setIsCvLoading] = useState(true);
  const [cvError, setCvError] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [clickState, setClickState] = useState<ClickState>('none');
  const [isCorrectionMode, setIsCorrectionMode] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState(false);

  // Sync state to refs for use in RAF loop
  useEffect(() => {
    calibrationStateRef.current = calibrationState;
  }, [calibrationState]);
  useEffect(() => {
    calibrationDataRef.current = calibrationData;
  }, [calibrationData]);

  const triggerClick = useCallback((side: 'left' | 'right') => {
    setClickState(side);
    setTimeout(() => setClickState('none'), 200); // Visual feedback duration
  }, []);

  // Load OpenCV and classifiers
  useEffect(() => {
    const loadCv = async () => {
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
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        const data = await response.arrayBuffer();
        window.cv.FS_createDataFile('/', path, new Uint8Array(data), true, false, false);
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
            triggerClick(eyeSide);
          }
          eyeStateRef.current = { state: 'idle', frames: 0 };
        } else if (frames > BLINK_CLOSED_FRAMES * 5) {
          eyeStateRef.current = { state: 'idle', frames: 0 }; // Timeout if squinting
        } else {
          eyeStateRef.current.frames++;
        }
      }
    };
    
    const drawDotsForRect = (ctx: CanvasRenderingContext2D, rect: any, color: string, size: number) => {
        ctx.fillStyle = color;
        const points = [
            { x: rect.x, y: rect.y }, // top-left
            { x: rect.x + rect.width, y: rect.y }, // top-right
            { x: rect.x, y: rect.y + rect.height }, // bottom-left
            { x: rect.x + rect.width, y: rect.y + rect.height }, // bottom-right
            { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, // center
        ];
        points.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, 2 * Math.PI);
            ctx.fill();
        });
    };
    
    const findPupilCenter = (eyeROI: any) => {
        let blurred = new window.cv.Mat();
        window.cv.GaussianBlur(eyeROI, blurred, new window.cv.Size(5, 5), 0);

        let gradX = new window.cv.Mat();
        let gradY = new window.cv.Mat();
        window.cv.Sobel(blurred, gradX, window.cv.CV_32F, 1, 0, 3);
        window.cv.Sobel(blurred, gradY, window.cv.CV_32F, 0, 1, 3);

        let maxVal = -1;
        let center = { x: eyeROI.cols / 2, y: eyeROI.rows / 2 };

        const weights = new window.cv.Mat.zeros(eyeROI.rows, eyeROI.cols, window.cv.CV_8U);
        const radius = Math.min(eyeROI.cols, eyeROI.rows) / 2;

        for (let y = 0; y < eyeROI.rows; y++) {
            for (let x = 0; x < eyeROI.cols; x++) {
                const dx = gradX.data32F[y * eyeROI.cols + x];
                const dy = gradY.data32F[y * eyeROI.cols + x];
                const mag = Math.sqrt(dx * dx + dy * dy);
                if (mag > 0) {
                    const normDx = dx / mag;
                    const normDy = dy / mag;
                    
                    for (let r = 0; r < radius; r += 2) {
                        const testX = Math.round(x + r * normDx);
                        const testY = Math.round(y + r * normDy);

                        if (testX >= 0 && testX < eyeROI.cols && testY >= 0 && testY < eyeROI.rows) {
                            weights.data[testY * eyeROI.cols + testX]++;
                            const currentWeight = weights.data[testY * eyeROI.cols + testX];
                            if (currentWeight > maxVal) {
                                maxVal = currentWeight;
                                center = { x: testX, y: testY };
                            }
                        }
                    }
                }
            }
        }
        
        blurred.delete();
        gradX.delete();
        gradY.delete();
        weights.delete();

        return center;
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

        if (displayCtx && displayCanvas) {
            drawDotsForRect(displayCtx, face, 'rgba(0, 255, 255, 0.7)', 4);
        }

        const faceROI = gray.roi(face);
        const eyes = new window.cv.RectVector();
        const minEyeSize = new window.cv.Size(face.width / 9, face.height / 9);
        // Fix: Corrected typo from minEyeZis to minEyeSize
        eyeCascadeRef.current.detectMultiScale(faceROI, eyes, 1.1, 3, 0, minEyeSize);

        if (eyes.size() >= 2) {
          let eyeRects = [eyes.get(0), eyes.get(1)];
          eyeRects.sort((a, b) => a.x - b.x);
          
          if (displayCtx && displayCanvas) {
              eyeRects.forEach(eye => {
                   const absoluteEyeRect = { x: face.x + eye.x, y: face.y + eye.y, width: eye.width, height: eye.height };
                   drawDotsForRect(displayCtx, absoluteEyeRect, 'rgba(0, 255, 0, 0.7)', 3);
              });
          }

          const [leftEyeRect, rightEyeRect] = eyeRects;
          const leftEyeROI = faceROI.roi(leftEyeRect);
          const rightEyeROI = faceROI.roi(rightEyeRect);
          
          const leftPupilRel = findPupilCenter(leftEyeROI);
          const rightPupilRel = findPupilCenter(rightEyeROI);

          const leftPupilAbs = { x: face.x + leftEyeRect.x + leftPupilRel.x, y: face.y + leftEyeRect.y + leftPupilRel.y };
          const rightPupilAbs = { x: face.x + rightEyeRect.x + rightPupilRel.x, y: face.y + rightEyeRect.y + rightPupilRel.y };
          
          if (displayCtx && displayCanvas) {
              [leftPupilAbs, rightPupilAbs].forEach(p => {
                  displayCtx.fillStyle = 'rgba(255, 0, 0, 0.8)';
                  displayCtx.beginPath();
                  displayCtx.arc(p.x, p.y, 4, 0, 2 * Math.PI, false);
                  displayCtx.fill();
              });
          }
          
          const avgPupilX = (leftPupilAbs.x + rightPupilAbs.x) / 2;
          const avgPupilY = (leftPupilAbs.y + rightPupilAbs.y) / 2;

          const normalizedX = (avgPupilX - face.x) / face.width;
          const normalizedY = (avgPupilY - face.y) / face.height;
          
          eyePositionRef.current = { x: 1 - normalizedX, y: normalizedY };
          
          if (calibrationStateRef.current === 'finished') {
            const newTarget = mapEyeToScreen(eyePositionRef.current, calibrationDataRef.current);
            targetPositionRef.current = newTarget;
          }

          const leftEAR = calculateEAR(leftEyeRect);
          const rightEAR = calculateEAR(rightEyeRect);
          updateBlinkState(leftEyeStateRef, leftEAR, 'left');
          updateBlinkState(rightEyeStateRef, rightEAR, 'right');

          leftEyeROI.delete();
          rightEyeROI.delete();
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

  }, [isCvLoading, cvError, triggerClick]);
  
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

  // Correction Mode (Shift key)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsCorrectionMode(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsCorrectionMode(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const handleCorrectionClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isCorrectionMode || calibrationState !== 'finished') return;

    const newScreenPoint = {
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    };
    const newEyePoint = { ...eyePositionRef.current };
    
    setCalibrationData(prev => [...prev, { screen: newScreenPoint, eye: newEyePoint }]);
    
    setCorrectionFeedback(true);
    setTimeout(() => setCorrectionFeedback(false), 200);

  }, [isCorrectionMode, calibrationState]);


  // Initial Calibration Logic
  useEffect(() => {
    if (calibrationState !== 'inProgress') return;
    if (calibrationPointIndex < TOTAL_CALIBRATION_POINTS) {
      const timer = setTimeout(() => {
        setCalibrationData(prev => [...prev, { screen: CALIBRATION_POINTS[calibrationPointIndex], eye: { ...eyePositionRef.current } }]);
        setCalibrationPointIndex(prev => prev + 1);
      }, 2500);
      return () => clearTimeout(timer);
    } else {
        setCalibrationState('finished');
    }
  }, [calibrationState, calibrationPointIndex]);

  // Auto-start calibration
  useEffect(() => {
    if (isWebcamEnabled && videoRef.current && !isCvLoading && !cvError) {
      const videoEl = videoRef.current;
      const onCanPlay = () => setTimeout(() => startCalibration(), 1000);
      videoEl.addEventListener('canplay', onCanPlay);
      return () => { if (videoEl) videoEl.removeEventListener('canplay', onCanPlay); };
    }
  }, [isWebcamEnabled, startCalibration, isCvLoading, cvError]);

  // Smooth cursor movement loop
  useEffect(() => {
    if (calibrationState !== 'finished') return;

    let animationFrameId: number;

    const updateCursor = () => {
        const target = targetPositionRef.current;
        const smoothed = smoothedCursorPosRef.current;

        // Simple linear interpolation (lerp) for smoothing
        smoothed.x += (target.x - smoothed.x) * 0.15;
        smoothed.y += (target.y - smoothed.y) * 0.15;
        
        setCursorPosition({ x: smoothed.x, y: smoothed.y });
        
        animationFrameId = requestAnimationFrame(updateCursor);
    };

    animationFrameId = requestAnimationFrame(updateCursor);

    return () => cancelAnimationFrame(animationFrameId);
  }, [calibrationState]);

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden" onMouseDown={handleCorrectionClick}>
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
        <StatusDisplay calibrationState={calibrationState} onRecalibrate={startCalibration} cameras={cameras} selectedCameraId={selectedCameraId} onCameraChange={handleCameraChange} />
      </main>
      
      {calibrationState !== 'finished' && <CalibrationScreen state={calibrationState} totalPoints={TOTAL_CALIBRATION_POINTS} currentPointIndex={calibrationPointIndex} pointPosition={CALIBRATION_POINTS[calibrationPointIndex]} />}
      
      {calibrationState === 'finished' && <GazeCursor position={cursorPosition} clickState={clickState} isCorrectionMode={isCorrectionMode} correctionFeedback={correctionFeedback} />}
    </div>
  );
};

export default App;