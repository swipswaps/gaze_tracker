import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';
import { ClickState, CalibrationPointData, BlinkStateMachine } from './types';
import Icon from './components/Icon';

// Extend the Window interface to include the 'cv' property
declare global {
  interface Window {
    cv: any;
  }
}

// --- Constants ---
const FACE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_frontalface_default.xml';
const EYE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_eye.xml';
const EAR_THRESHOLD = 0.25;
const BLINK_CLOSING_FRAMES = 1;
const BLINK_CLOSED_FRAMES = 2;
const K_NEAREST_NEIGHBORS = 4;
const INVERSE_DISTANCE_POWER = 4; // Increased power for more impactful corrections
const CORRECTION_SNAP_THRESHOLD = 0.1; 
const CAMERA_STORAGE_KEY = 'gazeTrack-selectedCameraId';

// --- Helper Functions ---
const mapEyeToScreen = (currentEyePos: { x: number, y: number }, correctionPoints: CalibrationPointData[]) => {
    if (correctionPoints.length < K_NEAREST_NEIGHBORS) {
        if (correctionPoints.length > 0) {
            // Fallback to the last available point if not enough for KNN
            const lastPoint = correctionPoints[correctionPoints.length - 1];
            const xOffset = currentEyePos.x - lastPoint.eye.x;
            const yOffset = currentEyePos.y - lastPoint.eye.y;
            return {
                x: (lastPoint.screen.x + xOffset) * window.innerWidth,
                y: (lastPoint.screen.y + yOffset) * window.innerHeight,
            };
        }
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }

    // Check for a close correction point to "snap" to
    for (const point of correctionPoints) {
        const dist = Math.sqrt(Math.pow(point.eye.x - currentEyePos.x, 2) + Math.pow(point.eye.y - currentEyePos.y, 2));
        if (dist < CORRECTION_SNAP_THRESHOLD) {
            return {
                x: point.screen.x * window.innerWidth,
                y: point.screen.y * window.innerHeight,
            };
        }
    }

    const distances = correctionPoints.map(point => ({
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
  const correctionDataRef = useRef<CalibrationPointData[]>([]);

  // State
  const [isWebcamEnabled, setIsWebcamEnabled] = useState(true);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>(() => localStorage.getItem(CAMERA_STORAGE_KEY) || '');
  const [correctionData, setCorrectionData] = useState<CalibrationPointData[]>([]);
  const [isCvLoading, setIsCvLoading] = useState(true);
  const [cvError, setCvError] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [clickState, setClickState] = useState<ClickState>('none');
  const [isCorrectionMode, setIsCorrectionMode] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState(false);
  const [correctionClickPos, setCorrectionClickPos] = useState<{x: number; y: number} | null>(null);


  // Sync state to refs for use in RAF loop
  useEffect(() => {
    correctionDataRef.current = correctionData;
  }, [correctionData]);

  // Save selected camera to local storage
  useEffect(() => {
    if (selectedCameraId) {
      localStorage.setItem(CAMERA_STORAGE_KEY, selectedCameraId);
    }
  }, [selectedCameraId]);

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
        let center = { x: eyeROI.cols / 2, y: eyeROI.rows / 2 }; // Default to center

        try {
            // Use a heavy blur to smooth out details and find the general dark area
            // Kernel size must be odd
            window.cv.GaussianBlur(eyeROI, blurred, new window.cv.Size(15, 15), 0);
            
            // Find the location of the minimum pixel value (the darkest spot)
            const result = window.cv.minMaxLoc(blurred);
            center = result.minLoc;
        } catch(e) {
            console.error("Error in findPupilCenter:", e);
        } finally {
            blurred.delete();
        }
        
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
          
          const newTarget = mapEyeToScreen(eyePositionRef.current, correctionDataRef.current);
          targetPositionRef.current = newTarget;

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
        const storedCameraId = localStorage.getItem(CAMERA_STORAGE_KEY);
        const storedCameraExists = videoDevices.some(d => d.deviceId === storedCameraId);

        if (!storedCameraExists && selectedCameraId) {
            // The previously selected camera is gone, switch to the first available one
            setSelectedCameraId(videoDevices[0].deviceId);
        } else if (!selectedCameraId) {
             // This is the first run, or storage was empty
             setSelectedCameraId(videoDevices[0].deviceId);
        }
      }
    } catch (err) { console.error("Error enumerating devices:", err); }
  }, [selectedCameraId]);

  const handleCameraChange = (deviceId: string) => {
    if (deviceId !== selectedCameraId) { 
      setSelectedCameraId(deviceId);
      setCorrectionData([]); // Clear corrections when camera changes
    }
  };

  const handleClearCorrections = useCallback(() => {
    setCorrectionData([]);
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
    if (!isCorrectionMode) return;

    const newScreenPoint = {
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    };
    const newEyePoint = { ...eyePositionRef.current };
    
    setCorrectionData(prev => [...prev, { screen: newScreenPoint, eye: newEyePoint }]);
    
    setCorrectionClickPos({ x: event.clientX, y: event.clientY });
    setCorrectionFeedback(true);
    setTimeout(() => {
        setCorrectionFeedback(false);
        setCorrectionClickPos(null);
    }, 200);

  }, [isCorrectionMode]);

  // Smooth cursor movement loop
  useEffect(() => {
    if (isCvLoading || cvError) return;

    let animationFrameId: number;
    const smoothedCursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    const updateCursor = () => {
        const target = targetPositionRef.current;

        // Simple linear interpolation (lerp) for smoothing
        smoothedCursorPos.x += (target.x - smoothedCursorPos.x) * 0.15;
        smoothedCursorPos.y += (target.y - smoothedCursorPos.y) * 0.15;
        
        setCursorPosition({ x: smoothedCursorPos.x, y: smoothedCursorPos.y });
        
        animationFrameId = requestAnimationFrame(updateCursor);
    };

    animationFrameId = requestAnimationFrame(updateCursor);

    return () => cancelAnimationFrame(animationFrameId);
  }, [isCvLoading, cvError]);

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
        <StatusDisplay isCvLoading={isCvLoading} onClearCorrections={handleClearCorrections} cameras={cameras} selectedCameraId={selectedCameraId} onCameraChange={handleCameraChange} />
      </main>
      
      {!isCvLoading && !cvError && <GazeCursor position={cursorPosition} clickState={clickState} isCorrectionMode={isCorrectionMode} correctionFeedback={correctionFeedback} correctionClickPos={correctionClickPos}/>}
    </div>
  );
};

export default App;