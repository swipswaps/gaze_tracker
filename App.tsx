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
const MIN_CORRECTION_POINTS_FOR_MODEL = 6; // Need at least 6 points to solve for the 6 coefficients in the model
const CAMERA_STORAGE_KEY = 'gazeTrack-selectedCameraId';

// --- Linear Algebra Helper for Polynomial Regression ---
// Solves Ax = B for x, where A is a matrix
const solve = (A: number[][], B: number[]): number[] | null => {
    const n = A.length;
    for (let i = 0; i < n; i++) {
        let maxEl = Math.abs(A[i][i]);
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(A[k][i]) > maxEl) {
                maxEl = Math.abs(A[k][i]);
                maxRow = k;
            }
        }

        for (let k = i; k < n; k++) {
            [A[maxRow][k], A[i][k]] = [A[i][k], A[maxRow][k]];
        }
        [B[maxRow], B[i]] = [B[i], B[maxRow]];

        for (let k = i + 1; k < n; k++) {
            const c = -A[k][i] / A[i][i];
            for (let j = i; j < n; j++) {
                if (i === j) {
                    A[k][j] = 0;
                } else {
                    A[k][j] += c * A[i][j];
                }
            }
            B[k] += c * B[i];
        }
    }

    const x = new Array(n).fill(0);
    for (let i = n - 1; i > -1; i--) {
        if (Math.abs(A[i][i]) < 1e-9) return null; // No unique solution
        x[i] = B[i] / A[i][i];
        for (let k = i - 1; k > -1; k--) {
            B[k] -= A[k][i] * x[i];
        }
    }
    return x;
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
  const modelCoefficientsRef = useRef<{ x: number[], y: number[] } | null>(null);
  const correctionDataRef = useRef<CalibrationPointData[]>([]);
  const smoothedCursorPosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  
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
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        setCameras(videoDevices);
        
        if (videoDevices.length > 0) {
            const storedCameraId = localStorage.getItem(CAMERA_STORAGE_KEY);
            const storedCameraExists = videoDevices.some(d => d.deviceId === storedCameraId);

            if (storedCameraExists) {
                setSelectedCameraId(storedCameraId!);
            } else {
                setSelectedCameraId(videoDevices[0].deviceId);
            }
        }
      } catch (err) {
        console.error("Error initializing cameras:", err);
        setCvError("Could not access camera. Please grant permission and ensure a camera is connected.");
      }
    };
    initCameras();
  }, []);

  const triggerClick = useCallback((side: 'left' | 'right') => {
    setClickState(side);
    setTimeout(() => setClickState('none'), 200); // Visual feedback duration
  }, []);

  // Train the polynomial regression model whenever correction data changes
  useEffect(() => {
    if (correctionData.length < MIN_CORRECTION_POINTS_FOR_MODEL) {
        modelCoefficientsRef.current = null;
        return;
    }

    const n = correctionData.length;
    // We are fitting screen_x = c0 + c1*eye_x + c2*eye_y + c3*eye_x*eye_y + c4*eye_x^2 + c5*eye_y^2
    const designMatrix = correctionData.map(p => [1, p.eye.x, p.eye.y, p.eye.x * p.eye.y, p.eye.x * p.eye.x, p.eye.y * p.eye.y]);
    
    // Transpose of the design matrix
    const designMatrixT = designMatrix[0].map((_, colIndex) => designMatrix.map(row => row[colIndex]));

    // (X^T * X)
    const XtX = designMatrixT.map(row => designMatrix[0].map((_, colIndex) => row.reduce((sum, val, rowIndex) => sum + val * designMatrix[rowIndex][colIndex], 0)));

    // (X^T * y)
    const screenX_values = correctionData.map(p => p.screen.x);
    const screenY_values = correctionData.map(p => p.screen.y);
    const XtY_x = designMatrixT.map(row => row.reduce((sum, val, i) => sum + val * screenX_values[i], 0));
    const XtY_y = designMatrixT.map(row => row.reduce((sum, val, i) => sum + val * screenY_values[i], 0));
    
    // Solve (X^T * X) * b = (X^T * y) for b
    const coeffsX = solve(XtX.map(row => [...row]), [...XtY_x]);
    const coeffsY = solve(XtX.map(row => [...row]), [...XtY_y]);

    if (coeffsX && coeffsY) {
        modelCoefficientsRef.current = { x: coeffsX, y: coeffsY };
    } else {
        modelCoefficientsRef.current = null;
    }

  }, [correctionData]);

  // Load OpenCV and classifiers
  useEffect(() => {
    const loadCv = async () => {
      if (window.cv && window.cv.CascadeClassifier) {
          // Already loaded
      } else {
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
    if (isCvLoading || cvError || !selectedCameraId) return;

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
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y },
            { x: rect.x, y: rect.y + rect.height },
            { x: rect.x + rect.width, y: rect.y + rect.height },
            { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        ];
        points.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, 2 * Math.PI);
            ctx.fill();
        });
    };
    
    const findPupilCenter = (eyeROI: any) => {
        const binary = new window.cv.Mat();
        const contours = new window.cv.MatVector();
        const hierarchy = new window.cv.Mat();
        let pupilCenter = { x: eyeROI.cols / 2, y: eyeROI.rows / 2 };

        try {
            // Adaptive threshold to get a binary image. This is robust to lighting changes.
            window.cv.adaptiveThreshold(eyeROI, binary, 255, window.cv.ADAPTIVE_THRESH_GAUSSIAN_C, window.cv.THRESH_BINARY_INV, 11, 2);

            // Morphological operations to remove noise (like eyelashes and reflections)
            const kernel = window.cv.getStructuringElement(window.cv.MORPH_ELLIPSE, new window.cv.Size(3, 3));
            window.cv.erode(binary, binary, kernel, new window.cv.Point(-1, -1), 1);
            window.cv.dilate(binary, binary, kernel, new window.cv.Point(-1, -1), 2);

            // Find contours
            window.cv.findContours(binary, contours, hierarchy, window.cv.RETR_EXTERNAL, window.cv.CHAIN_APPROX_SIMPLE);

            let bestCandidate = null;
            let maxCircularity = 0;

            for (let i = 0; i < contours.size(); ++i) {
                const contour = contours.get(i);
                const area = window.cv.contourArea(contour);
                const perimeter = window.cv.arcLength(contour, true);
                
                // Filter by area to avoid tiny noise or the whole eye
                if (area < 50 || area > eyeROI.cols * eyeROI.rows * 0.5) continue;

                // Calculate circularity
                const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
                if (circularity > 0.6 && circularity > maxCircularity) { // Pupils are mostly circular
                    bestCandidate = contour;
                    maxCircularity = circularity;
                }
            }

            if (bestCandidate) {
                const M = window.cv.moments(bestCandidate);
                if (M.m00 !== 0) {
                    pupilCenter = {
                        x: M.m10 / M.m00,
                        y: M.m01 / M.m00,
                    };
                }
                bestCandidate.delete();
            }
        } catch(e) {
            console.error("Error in findPupilCenter:", e);
        } finally {
            binary.delete();
            contours.delete();
            hierarchy.delete();
        }
        
        return pupilCenter;
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
          
          const normalizedLeftPupil = { x: leftPupilRel.x / leftEyeRect.width, y: leftPupilRel.y / leftEyeRect.height };
          const normalizedRightPupil = { x: rightPupilRel.x / rightEyeRect.width, y: rightPupilRel.y / rightEyeRect.height };

          const avgNormalizedX = (normalizedLeftPupil.x + normalizedRightPupil.x) / 2;
          const avgNormalizedY = (normalizedLeftPupil.y + normalizedRightPupil.y) / 2;
          
          eyePositionRef.current = { x: avgNormalizedX, y: avgNormalizedY };
          
          // Use the trained model to predict screen position
          const model = modelCoefficientsRef.current;
          if (model) {
              const { x: ex, y: ey } = eyePositionRef.current;
              const [c0x, c1x, c2x, c3x, c4x, c5x] = model.x;
              const [c0y, c1y, c2y, c3y, c4y, c5y] = model.y;

              const screenX = c0x + c1x*ex + c2x*ey + c3x*ex*ey + c4x*ex*ex + c5x*ey*ey;
              const screenY = c0y + c1y*ex + c2y*ey + c3y*ex*ey + c4y*ex*ex + c5y*ey*ey;

              smoothedCursorPosRef.current = {
                  x: screenX * window.innerWidth,
                  y: screenY * window.innerHeight
              };
          }
          // If no model, cursor doesn't move based on gaze until trained.

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

  }, [isCvLoading, cvError, triggerClick, selectedCameraId]);
  
  // Handlers
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

    const actualClickPos = { x: event.clientX, y: event.clientY };

    const newCorrectionPoint: CalibrationPointData = {
        screen: {
            x: actualClickPos.x / window.innerWidth,
            y: actualClickPos.y / window.innerHeight,
        },
        eye: { ...eyePositionRef.current },
    };
    
    setCorrectionData(prev => [...prev, newCorrectionPoint]);
    
    // Instantly move the cursor to the corrected position and track from there
    smoothedCursorPosRef.current = actualClickPos;
    setCursorPosition(actualClickPos);

    setCorrectionFeedback(true);
    setTimeout(() => {
        setCorrectionFeedback(false);
    }, 200);

  }, [isCorrectionMode]);

  // Smooth cursor movement loop
  useEffect(() => {
    if (isCvLoading || cvError) return;
    let animationFrameId: number;
    const updateCursor = () => {
        setCursorPosition(prev => {
            const target = smoothedCursorPosRef.current;
            // Lerp for smoothing
            const newX = prev.x + (target.x - prev.x) * 0.2;
            const newY = prev.y + (target.y - prev.y) * 0.2;
            return { x: newX, y: newY };
        });
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

      <main className="flex flex-col md:flex-row items-center justify-center gap-8 w-full">
        <WebcamView videoRef={videoRef} isEnabled={isWebcamEnabled && !!selectedCameraId} selectedCameraId={selectedCameraId} canvasRef={displayCanvasRef} />
        <StatusDisplay isCvLoading={isCvLoading} onClearCorrections={handleClearCorrections} cameras={cameras} selectedCameraId={selectedCameraId} onCameraChange={handleCameraChange} />
      </main>
      
      {!isCvLoading && !cvError && <GazeCursor position={cursorPosition} clickState={clickState} isCorrectionMode={isCorrectionMode} correctionFeedback={correctionFeedback} />}
    </div>
  );
};

export default App;
