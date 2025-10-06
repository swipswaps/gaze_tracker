import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mode, ClickState } from './types';
import WebcamView from './components/WebcamView';
import StatusDisplay from './components/StatusDisplay';
import GazeCursor from './components/GazeCursor';

// Declare cv on window
declare global {
  interface Window {
    cv: any;
  }
}

const App: React.FC = () => {
  const [mode, setMode] = useState<Mode>(Mode.None);
  const [isWebcamEnabled, setIsWebcamEnabled] = useState<boolean>(false);
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });
  const [clickState, setClickState] = useState<ClickState>('none');

  // OpenCV and processing state
  const [isCvReady, setIsCvReady] = useState(false);
  const [classifiersLoaded, setClassifiersLoaded] = useState(false);
  const [cvError, setCvError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetPosition = useRef({ x: 0, y: 0 });
  const animationFrameId = useRef<number | null>(null);

  // OpenCV object refs
  const faceCascade = useRef<any>(null);
  const eyeCascade = useRef<any>(null);
  const cap = useRef<any>(null);
  const frame = useRef<any>(null);
  const gray = useRef<any>(null);
  const faces = useRef<any>(null);
  const eyes = useRef<any>(null);
  
  // Blink detection refs
  const leftEyeBlinked = useRef(false);
  const rightEyeBlinked = useRef(false);
  const leftEyeOpen = useRef(true);
  const rightEyeOpen = useRef(true);
  // FIX: Changed NodeJS.Timeout to ReturnType<typeof setTimeout> for browser compatibility.
  const blinkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Smooth cursor movement animation
  const smoothMove = useCallback(() => {
    setCursorPosition(prevPos => {
      const dx = targetPosition.current.x - prevPos.x;
      const dy = targetPosition.current.y - prevPos.y;
      const newX = prevPos.x + dx * 0.15; // Increased smoothing factor
      const newY = prevPos.y + dy * 0.15;
      return { x: newX, y: newY };
    });
  }, []);

  // Effect to load OpenCV.js script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
    script.async = true;
    script.onload = () => {
      const checkCv = () => {
        if (window.cv && window.cv.CascadeClassifier) {
          setIsCvReady(true);
        } else {
          setTimeout(checkCv, 50);
        }
      };
      checkCv();
    };
    script.onerror = () => {
      setCvError("Failed to load OpenCV.js. Please check your internet connection.");
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Effect to load Haar Cascade classifiers
  useEffect(() => {
    if (!isCvReady) return;
    const loadClassifiers = async () => {
      try {
        const createFileFromUrl = async (path: string, url: string) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
          const data = await response.text();
          window.cv.FS_createDataFile('/', path, data, true, false, false);
        };
        await createFileFromUrl('face.xml', 'https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml');
        await createFileFromUrl('eye.xml', 'https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_eye.xml');

        faceCascade.current = new window.cv.CascadeClassifier();
        if (!faceCascade.current.load('face.xml')) throw new Error("Failed to load face cascade.");
        
        eyeCascade.current = new window.cv.CascadeClassifier();
        if (!eyeCascade.current.load('eye.xml')) throw new Error("Failed to load eye cascade.");
        
        setClassifiersLoaded(true);
      } catch (error: any) {
        console.error("Error loading classifiers:", error);
        setCvError(`Error loading AI models: ${error.message}. Please check your connection.`);
      }
    };
    loadClassifiers();
  }, [isCvReady]);

  // Core video processing logic for gaze and blink detection
  const processVideo = useCallback(() => {
    if (!videoRef.current || !containerRef.current || videoRef.current.videoWidth === 0) return;

    const video = videoRef.current;
    const { videoWidth, videoHeight } = video;
    const containerRect = containerRef.current.getBoundingClientRect();

    if (!cap.current) cap.current = new window.cv.VideoCapture(video);
    if (!frame.current) frame.current = new window.cv.Mat(videoHeight, videoWidth, window.cv.CV_8UC4);
    if (!gray.current) gray.current = new window.cv.Mat(videoHeight, videoWidth, window.cv.CV_8UC1);
    if (!faces.current) faces.current = new window.cv.RectVector();
    if (!eyes.current) eyes.current = new window.cv.RectVector();

    try {
      cap.current.read(frame.current);
      window.cv.cvtColor(frame.current, gray.current, window.cv.COLOR_RGBA2GRAY);
      window.cv.equalizeHist(gray.current, gray.current);
      
      faceCascade.current.detectMultiScale(gray.current, faces.current);

      if (faces.current.size() > 0) {
        const face = faces.current.get(0);
        const faceRoiGray = gray.current.roi(face);
        eyeCascade.current.detectMultiScale(faceRoiGray, eyes.current, 1.15, 5, 0, new window.cv.Size(25, 25));

        const detectedEyes = Array.from({ length: Math.min(eyes.current.size(), 2) }, (_, i) => {
          const eyeRect = eyes.current.get(i);
          return { x: face.x + eyeRect.x, y: face.y + eyeRect.y, width: eyeRect.width, height: eyeRect.height };
        }).sort((a, b) => a.x - b.x);

        const isLeftEyeDetected = detectedEyes.some(eye => eye.x + eye.width / 2 < face.x + face.width / 2);
        const isRightEyeDetected = detectedEyes.some(eye => eye.x + eye.width / 2 > face.x + face.width / 2);

        if (leftEyeOpen.current && !isLeftEyeDetected) leftEyeBlinked.current = true;
        leftEyeOpen.current = isLeftEyeDetected;

        if (rightEyeOpen.current && !isRightEyeDetected) rightEyeBlinked.current = true;
        rightEyeOpen.current = isRightEyeDetected;

        if (mode === Mode.Click) {
          if (blinkTimeout.current) clearTimeout(blinkTimeout.current);
          if (leftEyeBlinked.current) setClickState('left');
          if (rightEyeBlinked.current) setClickState('right');
          leftEyeBlinked.current = false;
          rightEyeBlinked.current = false;
          blinkTimeout.current = setTimeout(() => setClickState('none'), 150);
        } else {
          leftEyeBlinked.current = false;
          rightEyeBlinked.current = false;
        }

        if (mode === Mode.Gaze && detectedEyes.length > 0) {
          const centerPoint = detectedEyes.reduce((acc, eye) => ({ x: acc.x + eye.x + eye.width / 2, y: acc.y + eye.y + eye.height / 2 }), {x: 0, y: 0});
          const avgEyeX = centerPoint.x / detectedEyes.length;
          const avgEyeY = centerPoint.y / detectedEyes.length;
          
          targetPosition.current = {
            x: containerRect.width * (1 - (avgEyeX / videoWidth)), // Flipped X for mirrored video
            y: containerRect.height * (avgEyeY / videoHeight)
          };
        }
        faceRoiGray.delete();
      } else {
        leftEyeOpen.current = false;
        rightEyeOpen.current = false;
      }
    } catch (err) {
      console.error("OpenCV processing error:", err);
    }
  }, [mode]);

  // Main loop combining video processing and cursor animation
  const mainLoop = useCallback(() => {
    processVideo();
    smoothMove();
    animationFrameId.current = requestAnimationFrame(mainLoop);
  }, [processVideo, smoothMove]);

  useEffect(() => {
    if (isWebcamEnabled && classifiersLoaded) {
      // Set initial cursor to center
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const center = { x: rect.width / 2, y: rect.height / 2 };
        targetPosition.current = center;
        setCursorPosition(center);
      }
      animationFrameId.current = requestAnimationFrame(mainLoop);
    } else {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
        animationFrameId.current = null;
      }
    }
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      frame.current?.delete(); gray.current?.delete(); faces.current?.delete(); eyes.current?.delete();
    };
  }, [isWebcamEnabled, classifiersLoaded, mainLoop]);
  
  // Keyboard event handlers
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'g') setMode(Mode.Gaze);
      else if (key === 'c') setMode(Mode.Click);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'g' && mode === Mode.Gaze) setMode(Mode.None);
      else if (key === 'c' && mode === Mode.Click) {
        setMode(Mode.None);
        if (blinkTimeout.current) clearTimeout(blinkTimeout.current);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [mode]);

  const handleEnableWebcam = () => setIsWebcamEnabled(true);
  
  const renderOverlay = () => {
    if (cvError) return (
      <div className="absolute inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center z-30 p-4">
        <h2 className="text-2xl text-red-500 font-bold mb-4">Error</h2>
        <p className="text-lg max-w-lg text-center text-gray-300">{cvError}</p>
      </div>
    );
    if (!isWebcamEnabled) return (
      <div className="absolute inset-0 bg-black bg-opacity-70 flex flex-col items-center justify-center z-20">
        <h1 className="text-4xl font-bold mb-4">Webcam Gaze Tracker</h1>
        <p className="text-lg mb-8 max-w-lg text-center">This application uses your webcam to control an on-screen cursor with your eyes. Enable your webcam to begin.</p>
        <button onClick={handleEnableWebcam} className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white font-semibold transition-colors shadow-lg">
          Enable Webcam
        </button>
      </div>
    );
    if (!classifiersLoaded) return (
       <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-20">
          <h2 className="text-2xl font-bold mb-4 animate-pulse">Initializing AI Gaze Tracker...</h2>
          <p className="text-gray-300">Loading models, this may take a moment.</p>
       </div>
    );
    return null;
  };

  return (
    <div ref={containerRef} className="relative w-screen h-screen bg-gray-900 text-gray-200 flex flex-col md:flex-row items-center justify-center overflow-hidden p-4 md:p-8">
      {renderOverlay()}
      <div className="w-full h-1/2 md:h-full md:w-2/3 flex items-center justify-center p-4">
        <WebcamView videoRef={videoRef} isEnabled={isWebcamEnabled} />
      </div>
      <div className="w-full h-1/2 md:h-full md:w-1/3 p-4 flex items-center justify-center">
        <StatusDisplay mode={mode} />
      </div>
      {isWebcamEnabled && classifiersLoaded && <GazeCursor position={cursorPosition} clickState={clickState} />}
    </div>
  );
};

export default App;