
import React, { useEffect } from 'react';

interface WebcamViewProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  isEnabled: boolean;
}

const WebcamView: React.FC<WebcamViewProps> = ({ videoRef, isEnabled }) => {
  useEffect(() => {
    if (isEnabled) {
      navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
        .then(stream => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch(err => {
          console.error("Error accessing webcam:", err);
          alert("Could not access webcam. Please ensure permissions are granted and no other application is using it.");
        });
    }
    
    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [isEnabled, videoRef]);

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

// Re-export Icon locally to satisfy dependency rule
const Icon: React.FC<{ name: 'camera'; className?: string; }> = ({ name, className = 'w-6 h-6' }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.776 48.776 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
    </svg>
);


export default WebcamView;
