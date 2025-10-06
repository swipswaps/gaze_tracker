import React, { useEffect, useRef } from 'react';
import Icon from './Icon';

interface WebcamViewProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  isEnabled: boolean;
  selectedCameraId: string;
  onStreamAcquired: (stream: MediaStream) => void;
}

const WebcamView: React.FC<WebcamViewProps> = ({ videoRef, isEnabled, selectedCameraId, onStreamAcquired }) => {
  const streamAcquiredFiredRef = useRef(false);

  useEffect(() => {
    if (isEnabled) {
      const constraints = {
        video: {
          deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined,
          width: 1280,
          height: 720,
        },
      };
      
      let active = true;

      navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
          if (active && videoRef.current) {
            videoRef.current.srcObject = stream;
            if (!streamAcquiredFiredRef.current) {
              onStreamAcquired(stream);
              streamAcquiredFiredRef.current = true;
            }
          } else {
            // cleanup if component unmounted before stream was attached
             stream.getTracks().forEach(track => track.stop());
          }
        })
        .catch(err => {
          console.error("Error accessing webcam:", err);
          alert("Could not access webcam. Please ensure permissions are granted and no other application is using it.");
        });

      return () => {
        active = false;
        if (videoRef.current && videoRef.current.srcObject) {
          (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
          videoRef.current.srcObject = null;
        }
      };
    } else {
      // Cleanup if isEnabled becomes false
      if (videoRef.current && videoRef.current.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
    }
  }, [isEnabled, selectedCameraId, videoRef, onStreamAcquired]);

  return (
    <div className="relative w-full max-w-4xl aspect-video bg-black rounded-xl shadow-2xl overflow-hidden border-2 border-gray-700">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover transform -scale-x-100"
      />
      {isEnabled && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {/* Fake tracking indicators to enhance the simulation */}
          <div className="relative w-48 h-24">
            <div className="absolute top-1/2 left-0 -translate-y-1/2 w-8 h-8 border-2 border-cyan-400 rounded-full animate-pulse opacity-80"></div>
            <div className="absolute top-1/2 right-0 -translate-y-1/2 w-8 h-8 border-2 border-cyan-400 rounded-full animate-pulse opacity-80"></div>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-red-500 rounded-full shadow-lg shadow-red-500/50"></div>
          </div>
        </div>
      )}
       {!isEnabled && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-800 text-gray-400">
           <Icon name="camera" className="w-16 h-16 mb-4" />
           <p className="text-lg">Webcam is disabled</p>
        </div>
      )}
    </div>
  );
};

export default WebcamView;