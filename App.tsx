import React, { useState, useRef, useEffect, useCallback } from 'react';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';
import { ClickState, CalibrationPointData, BlinkStateMachine, DetectionStatus } from './types';
import Icon from './components/Icon';
import CalibrationScreen from './components/CalibrationScreen';

// Extend the Window interface to include the 'cv' property
declare global {
  interface Window {
    cv: any;
  }
}

// --- Constants ---
const FACE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_frontalface_default.xml';
const EYE_CASCADE_URL = 'https://raw.githubusercontent.com/opencv/opencv/4.x/data/haarcascades/haarcascade_eye.xml';

const CAMERA_STORAGE_KEY = 'gazeTrack-selectedCameraId';
const CALIBRATION_STORAGE_KEY = 'gazeTrack-calibrationData';

// --- Procedural Mesh Templates (Normalized Coordinates) ---
const FACE_MESH_TEMPLATE: {x: number, y: number}[] = [];
// Create an elliptical mesh for the face
const FACE_ELLIPSE_POINTS = 60;
for (let i = 0; i < FACE_ELLIPSE_POINTS; i++) {
    const angle = (i / FACE_ELLIPSE_POINTS) * 2 * Math.PI;
    FACE_MESH_TEMPLATE.push({
        x: 0.5 + 0.45 * Math.cos(angle),
        y: 0.5 + 0.5 * Math.sin(angle),
    });
}
// Add some internal feature approximations
FACE_MESH_TEMPLATE.push(
    // Eyebrows
    {x: 0.3, y: 0.35}, {x: 0.4, y: 0.32}, {x: 0.5, y: 0.35}, {x: 0.6, y: 0.32}, {x: 0.7, y: 0.35},
    // Nose
    {x: 0.5, y: 0.45}, {x: 0.5, y: 0.55}, {x: 0.45, y: 0.65}, {x: 0.55, y: 0.65},
    // Mouth
    {x: 0.35, y: 0.8}, {x: 0.5, y: 0.82}, {x: 0.65, y: 0.8}, {x: 0.5, y: 0.88}, {x:0.35, y: 0.8}
);

const App: React.FC = () => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const eyePositionRef = useRef({ x: 0.5, y: 0.5 });
  const processVideoFrameIdRef = useRef<number>(0);
  const faceCascadeRef = useRef<any>(null);
  const eyeCascadeRef = useRef<any>(null);
  const correctionDataRef = useRef<CalibrationPointData[]>([]);
  const smoothedCursorPosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const leftBlinkDetectorRef = useRef<BlinkStateMachine>({ state: 'open', frames: 0 });
  const rightBlinkDetectorRef = useRef<BlinkStateMachine>({ state: 'open', frames: 0 });
  
  // State
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>(() => localStorage.getItem(CAMERA_STORAGE_KEY) || '');
  const [correctionData, setCorrectionData] = useState<CalibrationPointData[]>([]);
  const [isCvLoading, setIsCvLoading] = useState(true);
  const [cvError, setCvError] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [clickState, setClickState] = useState<ClickState>('none');
  const [isCorrectionMode, setIsCorrectionMode] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState(false);
  const [detectionStatus, setDetectionStatus] = useState<DetectionStatus>('searching');
  const [eyeBlinkState, setEyeBlinkState] = useState({ left: false, right: false });
  const [isCalibrated, setIsCalibrated] = useState(false);

  // Load calibration data on mount
  useEffect(() => {
    const savedData = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (savedData) {
        try {
            const parsedData = JSON.parse(savedData);
            if (Array.isArray(parsedData) && parsedData.length > 0) {
                setCorrectionData(parsedData);
                setIsCalibrated(true);
            }
        } catch (e) {
            console.error("Failed to parse calibration data from localStorage", e);
            localStorage.removeItem(CALIBRATION_STORAGE_KEY);
        }
    }
  }, []);

  // Sync state to ref for use in RAF loop
  useEffect(() => {
    correctionDataRef.current = correctionData;
  }, [correctionData]);

  // Save selected camera to local storage
  useEffect(() => {
    if (selectedCameraId) {
      localStorage.setItem(CAMERA_STORAGE_KEY, selectedCameraId);
    }
  }, [selectedCameraId]);

  // Enumerate cameras and validate stored selection
  useEffect(() => {
    const initCameras = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        setCameras(videoDevices);
        
        if (videoDevices.length > 0) {
            const storedCameraId = localStorage.getItem(CAMERA_STORAGE_KEY);
            const storedCameraExists = videoDevices.some(d => d.deviceId === storedCameraId);

            if (storedCameraId && storedCameraExists) {
                setSelectedCameraId(storedCameraId);
            } else {
                setSelectedCameraId(videoDevices[0].deviceId);
            }
        }
      } catch (err) {
        console.error("Error initializing cameras:", err);
        setCvError("Could not access camera. Please grant permission.");
      }
    };
    initCameras();
  }, []);

  const triggerClick = useCallback((side: 'left' | 'right') => {
    setClickState(side);
    setTimeout(() => setClickState('none'), 200);
  }, []);

  // Load OpenCV and classifiers
  useEffect(() => {
    const loadCv = async () => {
      if (!window.cv || !window.cv.CascadeClassifier) {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("OpenCV script loading timed out.")), 10000);
            const interval = setInterval(() => {
              if (window.cv && window.cv.CascadeClassifier) {
                clearInterval(interval);
                clearTimeout(timeout);
                resolve();
              }
            }, 100);
        });
      }

      const createFileFromUrl = async (path: string, url: string) => {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
            const data = await response.arrayBuffer();
            window.cv.FS_createDataFile('/', path, new Uint8Array(data), true, false, false);
        } catch (error) {
            throw new Error(`Could not download model from ${url}. ${error}`);
        }
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
      setCvError(`Failed to load AI models. Please check your network connection. Error: ${err.message}`);
      setIsCvLoading(false);
    });
  }, []);
  
  const processBlinks = useCallback((leftEyeDetected: boolean, rightEyeDetected: boolean) => {
    const BLINK_FRAMES_TO_CLOSE = 2;
    const BLINK_COOLDOWN_FRAMES = 15;
    
    const updateDetector = (detector: BlinkStateMachine, isDetected: boolean) => {
        let blinkTriggered = false;
        switch (detector.state) {
            case 'open':
                if (!isDetected) {
                    detector.state = 'closing';
                    detector.frames = 1;
                }
                break;
            case 'closing':
                if (!isDetected) {
                    detector.frames++;
                    if (detector.frames >= BLINK_FRAMES_TO_CLOSE) {
                        detector.state = 'closed';
                        blinkTriggered = true;
                    }
                } else {
                    detector.state = 'open';
                    detector.frames = 0;
                }
                break;
            case 'closed':
                detector.state = 'cooldown';
                detector.frames = 1;
                break;
            case 'cooldown':
                detector.frames++;
                if (detector.frames >= BLINK_COOLDOWN_FRAMES) {
                    detector.state = 'open';
                    detector.frames = 0;
                }
                break;
        }
        return blinkTriggered;
    };
    
    const leftBlinked = updateDetector(leftBlinkDetectorRef.current, leftEyeDetected);
    const rightBlinked = updateDetector(rightBlinkDetectorRef.current, rightEyeDetected);

    if (leftBlinked) triggerClick('left');
    if (rightBlinked) triggerClick('right');

    if (leftBlinked || rightBlinked) {
        setEyeBlinkState(prev => ({ left: prev.left || leftBlinked, right: prev.right || rightBlinked }));
        
        setTimeout(() => {
            setEyeBlinkState(prev => ({
                left: leftBlinked ? false : prev.left,
                right: rightBlinked ? false : prev.right,
            }));
        }, 250);
    }
  }, [triggerClick]);


  const drawProceduralMesh = (ctx: CanvasRenderingContext2D, rect: any, template: {x:number, y:number}[], color: string) => {
    ctx.fillStyle = color;
    for (const point of template) {
        const x = rect.x + point.x * rect.width;
        const y = rect.y + point.y * rect.height;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
        ctx.fill();
    }
  };

  const mapEyeToScreen = (eyePos: {x: number, y: number}): {x: number, y: number} => {
    const corrections = correctionDataRef.current;
    if (corrections.length < 1) {
        // Simple passthrough if no corrections exist
        return { 
            x: eyePos.x * window.innerWidth, 
            y: eyePos.y * window.innerHeight 
        };
    }

    let totalWeight = 0;
    let weightedSum = { x: 0, y: 0 };
    const POWER = 2; // How much influence closer points have

    for (const p of corrections) {
        const dist = Math.hypot(eyePos.x - p.eye.x, eyePos.y - p.eye.y);
        if (dist < 0.001) return p.screen; // Exact match

        const weight = 1 / Math.pow(dist, POWER);
        weightedSum.x += p.screen.x * weight;
        weightedSum.y += p.screen.y * weight;
        totalWeight += weight;
    }

    if (totalWeight === 0) return { x: window.innerWidth/2, y: window.innerHeight/2 };

    return { 
        x: weightedSum.x / totalWeight, 
        y: weightedSum.y / totalWeight 
    };
  };

  const processVideo = useCallback(() => {
    try {
        if (!videoRef.current || !processingCanvasRef.current || !displayCanvasRef.current || videoRef.current.paused || videoRef.current.ended || !faceCascadeRef.current || !eyeCascadeRef.current) {
          processVideoFrameIdRef.current = requestAnimationFrame(processVideo); return;
        }
        const video = videoRef.current;
        const processingCanvas = processingCanvasRef.current;
        const displayCanvas = displayCanvasRef.current;
        const displayCtx = displayCanvas.getContext('2d');
        
        if (!displayCtx) { processVideoFrameIdRef.current = requestAnimationFrame(processVideo); return; }
        if (displayCanvas.width !== video.videoWidth || displayCanvas.height !== video.videoHeight) {
            displayCanvas.width = video.videoWidth;
            displayCanvas.height = video.videoHeight;
        }
        displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        
        processingCanvas.width = video.videoWidth; processingCanvas.height = video.videoHeight;
        const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
        if (!processingCtx) { processVideoFrameIdRef.current = requestAnimationFrame(processVideo); return; }
        
        processingCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
        const src = window.cv.imread(processingCanvas);
        const gray = new window.cv.Mat();
        window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
        window.cv.equalizeHist(gray, gray);

        const faces = new window.cv.RectVector();
        const minFaceSize = new window.cv.Size(video.videoWidth / 5, video.videoHeight / 5);
        faceCascadeRef.current.detectMultiScale(gray, faces, 1.1, 5, 0, minFaceSize);

        if (faces.size() > 0) {
          setDetectionStatus('face_detected');
          const faceRect = faces.get(0);
          drawProceduralMesh(displayCtx, faceRect, FACE_MESH_TEMPLATE, 'rgba(0, 255, 150, 0.7)');

          const faceCenterX = faceRect.x + faceRect.width / 2;
          const faceCenterY = faceRect.y + faceRect.height / 2;
          const normalizedX = faceCenterX / video.videoWidth;
          const normalizedY = faceCenterY / video.videoHeight;
          eyePositionRef.current = { x: 1.0 - normalizedX, y: normalizedY };

          const faceROI = gray.roi(faceRect);
          const eyes = new window.cv.RectVector();
          const minEyeSize = new window.cv.Size(faceRect.width / 8, faceRect.height / 8);
          eyeCascadeRef.current.detectMultiScale(faceROI, eyes, 1.15, 7, 0, minEyeSize);
          
          if (eyes.size() > 0) { setDetectionStatus('tracking'); }

          const detectedEyes = [];
          for (let i = 0; i < eyes.size(); i++) {
              detectedEyes.push(eyes.get(i));
          }
          detectedEyes.sort((a, b) => a.x - b.x);

          let rightEyeDetected = false;
          let leftEyeDetected = false;

          // In the mirrored video, the eye on the left is the user's right eye.
          if (detectedEyes.length === 2) {
              rightEyeDetected = true;
              leftEyeDetected = true;
          } else if (detectedEyes.length === 1) {
              const eye = detectedEyes[0];
              const eyeCenterX = eye.x + eye.width / 2;
              if (eyeCenterX < faceRect.width / 2) {
                  rightEyeDetected = true;
              } else {
                  leftEyeDetected = true;
              }
          }

          processBlinks(leftEyeDetected, rightEyeDetected);
          
          faceROI.delete();
          eyes.delete();
        } else {
           setDetectionStatus('searching');
        }
        src.delete();
        gray.delete();
        faces.delete();
    } catch (e) {
      console.error("Error in processVideo:", e);
    }
    processVideoFrameIdRef.current = requestAnimationFrame(processVideo);
  }, [processBlinks]);

  useEffect(() => {
    if (isCvLoading || cvError || !selectedCameraId) return;
    processVideoFrameIdRef.current = requestAnimationFrame(processVideo);
    return () => {
      cancelAnimationFrame(processVideoFrameIdRef.current);
    };
  }, [isCvLoading, cvError, selectedCameraId, processVideo]);

  // Smooth cursor movement loop
  useEffect(() => {
    let animationFrameId: number;
    const updateCursor = () => {
        const targetPos = mapEyeToScreen(eyePositionRef.current);
        smoothedCursorPosRef.current.x += (targetPos.x - smoothedCursorPosRef.current.x) * 0.2;
        smoothedCursorPosRef.current.y += (targetPos.y - smoothedCursorPosRef.current.y) * 0.2;
        setCursorPosition({ ...smoothedCursorPosRef.current });
        animationFrameId = requestAnimationFrame(updateCursor);
    };
    animationFrameId = requestAnimationFrame(updateCursor);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);
  
  const handleCorrectionClick = (e: React.MouseEvent) => {
    if (!isCorrectionMode || !isCalibrated) return;
    
    const newCorrection: CalibrationPointData = {
        screen: { x: e.clientX, y: e.clientY },
        eye: { ...eyePositionRef.current }
    };
    setCorrectionData(prev => [...prev, newCorrection]);
    
    smoothedCursorPosRef.current = { x: e.clientX, y: e.clientY };
    setCursorPosition({ x: e.clientX, y: e.clientY });

    setCorrectionFeedback(true);
    setTimeout(() => setCorrectionFeedback(false), 200);
  };

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

  const handleCalibrationComplete = (data: CalibrationPointData[]) => {
    setCorrectionData(data);
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(data));
    setIsCalibrated(true);
  };

  const handleClearCorrections = () => {
    setCorrectionData([]);
    localStorage.removeItem(CALIBRATION_STORAGE_KEY);
    setIsCalibrated(false);
  };

  const getEyePosition = useCallback(() => eyePositionRef.current, []);


  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center p-4 font-sans relative overflow-hidden" onClick={handleCorrectionClick}>
      <canvas ref={processingCanvasRef} style={{ display: 'none' }} />
      <header className="absolute top-0 left-0 p-4 z-10">
        <h1 className="text-2xl font-bold tracking-wider">HeadTrack AI</h1>
        <p className="text-sm text-gray-400">Facial Feature Detection</p>
      </header>
      
      {(isCvLoading || cvError) && (
         <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-30">
            {isCvLoading && !cvError ? (
                <>
                    <Icon name="eye" className="w-16 h-16 mb-4 text-cyan-400 animate-pulse" />
                    <h2 className="text-2xl font-bold mb-2">Loading AI Models...</h2>
                    <p className="text-gray-300">Please wait, this may take a moment.</p>
                </>
            ) : (
                 <div className="text-center text-red-400">
                    <Icon name="camera" className="w-16 h-16 mb-4 opacity-50" />
                    <p className="text-lg font-bold mb-2">Error</p>
                    <p className="max-w-md">{cvError}</p>
                 </div>
            )}
         </div>
      )}
      
      {!isCvLoading && !cvError && (
          <>
            {isCalibrated ? (
                <>
                  <main className="flex flex-col md:flex-row items-center justify-center gap-8 w-full">
                    <WebcamView 
                      videoRef={videoRef} 
                      isEnabled={!!selectedCameraId} 
                      selectedCameraId={selectedCameraId} 
                      canvasRef={displayCanvasRef} 
                      blinkState={eyeBlinkState}
                    />
                    <StatusDisplay 
                      detectionStatus={detectionStatus} 
                      onClearCorrections={handleClearCorrections} 
                      cameras={cameras} 
                      selectedCameraId={selectedCameraId} 
                      onCameraChange={setSelectedCameraId} 
                    />
                  </main>
                  <GazeCursor position={cursorPosition} clickState={clickState} isCorrectionMode={isCorrectionMode} correctionFeedback={correctionFeedback} />
                </>
            ) : (
                <CalibrationScreen onCalibrationComplete={handleCalibrationComplete} getEyePosition={getEyePosition} />
            )}
          </>
      )}
    </div>
  );
};

export default App;