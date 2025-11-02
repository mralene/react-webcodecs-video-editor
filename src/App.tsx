import { useState, useRef, useEffect } from 'react'
import './App.css'
import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket, Input, FilePathSource, ALL_FORMATS, EncodedPacketSink, BlobSource } from 'mediabunny';

function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [overlayText, setOverlayText] = useState('')
  const [textPosition, setTextPosition] = useState({ x: 50, y: 50 })
  const [textColor, setTextColor] = useState('#ffffff')
  const [fontSize, setFontSize] = useState(48)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [outputBlob, setOutputBlob] = useState<Blob | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const outputVideoRef = useRef<HTMLVideoElement>(null)

  // Check if WebCodecs API is supported
  const isWebCodecsSupported = typeof window !== 'undefined' && 'VideoEncoder' in window

  // Clean up object URLs when component unmounts or when new video is uploaded
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (outputUrl) URL.revokeObjectURL(outputUrl)
    }
  }, [])

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      // Clean up previous URL if exists
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (outputUrl) {
        URL.revokeObjectURL(outputUrl)
        setOutputUrl(null)
      }

      const file = e.target.files[0]
      setVideoFile(file)
      const url = URL.createObjectURL(file)
      setVideoUrl(url)
    }
  }

  // Demux > Decode > Encode > Mux.
  const handleCreateVideo = async () => {
    console.log('in create video function');

    try {
      // ------------------------------------------------------------
      // DEMUX (mediabunny Input)
      // ------------------------------------------------------------
      console.log('DEMUX: Video loaded');

      const response = await fetch(`${window.location.origin}/gopro.MP4`);
      const videoBlob = await response.blob();

      const input = new Input({
        source: new BlobSource(videoBlob),
        formats: ALL_FORMATS,
      });

      const duration = await input.computeDuration(); // maximum end timespamp across all tracks
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error('No video track found');

      console.log('duration', duration);
      console.log('codec', videoTrack.codec);

      const videoSink = new EncodedPacketSink(videoTrack);


      // ------------------------------------------------------------
      // DECODE (webcodecs api)
      // ------------------------------------------------------------
      console.log('Start Decoding');
      //const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      // const ctx = canvas.getContext('2d');
      // if (!ctx) throw new Error('Canvas context not found');
      const frames: VideoFrame[] = [];
      const videoDecoder = new VideoDecoder({
        output: (frame) => {
          //console.log('Got frame at timestamp', frame.timestamp);
          //ctx.drawImage(frame, 0, 0, videoTrack.codedWidth, videoTrack.codedHeight);
          frames.push(frame.clone());
          frame.close();
        },
        error: (e) => console.error(e)
      });

      const videoDecoderConfig = await videoTrack.getDecoderConfig();
      if (!videoDecoderConfig) {
        throw new Error("Failed to get decoder configuration");
      }
      videoDecoder.configure(videoDecoderConfig);

      for await (const packet of videoSink.packets()) {
        const chunk = await packet.toEncodedVideoChunk();
        videoDecoder.decode(chunk);
        //console.log('packet', packet.timestamp, packet.data);
      }
      await videoDecoder.flush();
      console.log(`Decoding finished. Decoded ${frames.length} frames.`);

      // HERE YOU CAN EDIT

      // ------------------------------------------------------------
      // ENCODE (webcodecs api)
      // ------------------------------------------------------------
      console.log('Start Encoding');

      const encodedChunks: EncodedVideoChunk[] = [];
      const encoder = new VideoEncoder({
        output: (chunk) => {
          encodedChunks.push(chunk); // collect encoded chunks
        },
        error: (e) => console.error('Encoder error:', e),
      });

      const fps = (await videoTrack.computePacketStats()).averagePacketRate;
      const bitrate = (await videoTrack.computePacketStats()).averageBitrate;

      console.log('fps', fps);
      console.log('bitrate', bitrate);

      encoder.configure({
        codec: 'vp8', // or 'avc1.42E028', 'avc1.42E01E' for H.264, vp8
        width: videoTrack.codedWidth,
        height: videoTrack.codedHeight,
        framerate: fps,
      });

      for (const frame of frames) {
        encoder.encode(frame);
        frame.close(); // free memory now that we encoded
      }

      await encoder.flush();
      console.log('Encoding finished.');

      // ------------------------------------------------------------
      // MUX (mediabunny Output)
      // ------------------------------------------------------------
      console.log('Start Muxing');

      const output = new Output({
        format: new Mp4OutputFormat(),
        target: new BufferTarget(),
      });

      const videoSource = new EncodedVideoPacketSource('vp8');
      output.addVideoTrack(videoSource);
      await output.start();

      let firstChunk = true;
      for (const chunk of encodedChunks) {
        // Get raw bytes
        const buffer = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buffer);
        const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);

        // Add packet
        if (firstChunk) {
          videoSource.add(encodedPacket, {
            decoderConfig: {
              codec: 'vp8', //'avc1.42001E',
              codedWidth: videoTrack.codedWidth,
              codedHeight: videoTrack.codedHeight,
            }
          });
          firstChunk = false;
        } else {
          //console.log('Added packet', encodedPacket.timestamp);
          //console.log('Encoded packet', encodedPacket.timestamp);
          videoSource.add(encodedPacket);
        }
      }
      await output.finalize();
      console.log('Muxing finished');

      const buffer = output.target.buffer;
      if (!buffer) throw new Error('Buffer not found');
      const blob = new Blob([buffer], { type: 'video/mp4' });

      console.log('Output video created successfully');

      setOutputBlob(blob);
      setOutputUrl(URL.createObjectURL(blob));
      setProcessing(false);
      setProgress(100);


    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return

    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    setTextPosition({ x, y })
  }

  const handleDownload = () => {
    if (!outputBlob) return;

    // Create a temporary link element
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${overlayText.replace(/\s+/g, '-')}-video.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Clean up the temporary URL
    setTimeout(() => URL.revokeObjectURL(url), 100);

    console.log("Download initiated for blob:", outputBlob);
  }

  // Draw preview with text position when video is loaded
  useEffect(() => {
    if (!videoRef.current || !canvasRef.current || !videoUrl) return

    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const updateCanvas = () => {
      if (video.readyState >= 2) {
        // Set canvas dimensions to match video
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight

        // Draw video frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        // Draw text
        ctx.font = `${fontSize}px Arial`
        ctx.fillStyle = textColor
        ctx.strokeStyle = 'black'
        ctx.lineWidth = 2
        ctx.textBaseline = 'top'

        // Draw text stroke
        ctx.strokeText(overlayText, textPosition.x, textPosition.y)
        // Draw text fill
        ctx.fillText(overlayText, textPosition.x, textPosition.y)
      }
    }

    // Update canvas when video can play
    video.addEventListener('canplay', updateCanvas)

    // Update canvas when text or position changes
    updateCanvas()

    return () => {
      video.removeEventListener('canplay', updateCanvas)
    }
  }, [videoUrl, overlayText, textPosition, textColor, fontSize])

  // If WebCodecs API is not supported, show error
  if (!isWebCodecsSupported) {
    return (
      <div className="app-container">
        <h1>Video Text Overlay</h1>
        <div className="error-message">
          <h3>Browser Not Supported</h3>
          <p>Your browser does not support the WebCodecs API required for this application.</p>
          <p>Please try using Chrome 94+, Edge 94+, or another browser with WebCodecs support.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <h1>Video Text Overlay</h1>

      {errorMessage && (
        <div className="error-message">
          <p>{errorMessage}</p>
        </div>
      )}

      <div className="upload-section">
        <label htmlFor="video-upload" className="upload-label">
          Upload Video
        </label>
        <input
          id="video-upload"
          type="file"
          accept="video/*"
          onChange={handleVideoUpload}
          className="file-input"
        />
      </div>

      {videoUrl && (
        <div className="video-preview">
          <h3>Preview</h3>
          <div className="preview-container">
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              width="100%"
              height="auto"
            />
            <canvas
              ref={canvasRef}
              className="text-position-canvas"
              onClick={handleCanvasClick}
              title="Click to position text"
            />
          </div>
          <p className="help-text">Click on the video to position the text</p>
        </div>
      )}
      <canvas id="canvas" width="640" height="360"></canvas>

      <div className="text-input-section">
        <label htmlFor="overlay-text">Text Overlay:</label>
        <input
          id="overlay-text"
          type="text"
          value={overlayText}
          onChange={(e) => setOverlayText(e.target.value)}
          placeholder="Enter text to overlay on video"
          className="text-input"
        />

        <div className="text-options">
          <div className="option-group">
            <label htmlFor="text-color">Text Color:</label>
            <input
              id="text-color"
              type="color"
              value={textColor}
              onChange={(e) => setTextColor(e.target.value)}
              className="color-input"
            />
          </div>

          <div className="option-group">
            <label htmlFor="font-size">Font Size:</label>
            <input
              id="font-size"
              type="range"
              min="12"
              max="120"
              value={fontSize}
              onChange={(e) => setFontSize(parseInt(e.target.value))}
              className="range-input"
            />
            <span>{fontSize}px</span>
          </div>
        </div>
      </div>

      <button
        className="create-button"
        onClick={handleCreateVideo}
      //disabled={!videoFile || processing || !overlayText}
      >
        {processing ? 'Processing...' : 'Create Video'}
      </button>

      {processing && (
        <div className="progress-bar-container">
          <div className="progress-bar" style={{ width: `${progress}%` }}></div>
          <div className="progress-text">{progress}%</div>
        </div>
      )}

      {outputUrl && (
        <div className="output-section">
          <h3>Processed Video with Text Overlay</h3>
          <video
            ref={outputVideoRef}
            src={outputUrl}
            controls
            autoPlay
            width="100%"
            height="auto"
            onLoadedData={() => {
              if (outputVideoRef.current) {
                outputVideoRef.current.play().catch(err =>
                  console.log('Auto-play prevented:', err)
                );
              }
            }}
          />
          <div className="video-controls">
            <button
              className="action-button"
              onClick={() => {
                if (outputVideoRef.current) {
                  outputVideoRef.current.currentTime = 0;
                  outputVideoRef.current.play();
                }
              }}
            >
              Replay Video
            </button>
            <button
              className="download-button"
              onClick={handleDownload}
            >
              Download Video
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App