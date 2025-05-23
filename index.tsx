/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() isSessionInitialized = false;

  private client: GoogleGenAI;
  private session: Session;
  // Fix: Cast window to any to access webkitAudioContext for older browser compatibility
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // Fix: Cast window to any to access webkitAudioContext for older browser compatibility
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative; /* Needed for absolute positioning of children */
    }

    .app-header {
      position: absolute;
      top: 5vh;
      left: 0;
      right: 0;
      text-align: center;
      z-index: 10;
      color: white;
      font-family: 'Arial', sans-serif;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white; /* Ensure status text is visible */
      font-family: sans-serif;
      padding: 8px 15px;
      background-color: rgba(0,0,0,0.4);
      border-radius: 8px;
      max-width: 80%;
      margin: 0 auto;
      font-size: 0.9em;
      box-shadow: 0px 2px 5px rgba(0,0,0,0.2);
    }

    #status strong {
      color: #ffcdd2; /* Light red for error emphasis */
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 12vh; /* Adjusted to give more space from status */
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: row; /* Changed to row for horizontal layout */
      gap: 20px; /* Increased gap for better spacing */

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 50%; /* Make buttons circular */
        background: rgba(30, 30, 40, 0.7); /* Darker, slightly transparent background */
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex; /* For centering icon */
        align-items: center; /* For centering icon */
        justify-content: center; /* For centering icon */
        transition: background-color 0.3s ease, transform 0.2s ease, box-shadow 0.3s ease;
        box-shadow: 0px 2px 8px rgba(0,0,0,0.3);


        &:hover {
          background: rgba(50, 50, 60, 0.8);
          transform: scale(1.1); /* Slight zoom on hover */
          box-shadow: 0px 4px 12px rgba(0,0,0,0.4);
        }

        &:active {
          transform: scale(0.95); /* Slight shrink on click */
          background: rgba(70, 70, 80, 0.9);
        }
      }

      button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: scale(1); /* No zoom/shrink when disabled */
        background: rgba(30, 30, 40, 0.5);
        box-shadow: 0px 2px 8px rgba(0,0,0,0.3);
      }

      /* Conditional display based on recording state */
      button#startButton {
        display: var(--gdm-start-button-display, flex);
      }
      button#stopButton {
        display: var(--gdm-stop-button-display, none);
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has('isRecording')) {
      this.style.setProperty('--gdm-start-button-display', this.isRecording ? 'none' : 'flex');
      this.style.setProperty('--gdm-stop-button-display', this.isRecording ? 'flex' : 'none');
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    this.isSessionInitialized = false;
    this.updateStatus('Initializing session...');
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Session Opened. Ready to record.');
            this.isSessionInitialized = true;
            this.error = ''; // Clear previous errors
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(`Session Error: ${e.message}`);
            this.isSessionInitialized = false; // Session might be unusable
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus(`Session Closed: ${e.reason || 'Unknown reason'}`);
            this.isSessionInitialized = false;
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
        },
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('Failed to initialize session:', errorMessage);
      this.updateError(`Failed to initialize session: ${errorMessage}`);
      this.isSessionInitialized = false;
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    // console.log('Status:', msg); // Optional: for debugging
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = ''; // Clear normal status when there's an error
    console.error('Error:', msg);
  }

  private async startRecording() {
    if (this.isRecording || !this.isSessionInitialized) {
      if (!this.isSessionInitialized) {
        this.updateError('Session not ready. Please wait or reset.');
      }
      return;
    }

    try {
      // Attempt to resume contexts first, as they might be in a suspended state.
      if (this.inputAudioContext.state === 'suspended') {
        await this.inputAudioContext.resume();
      }
      if (this.outputAudioContext.state === 'suspended') {
        await this.outputAudioContext.resume();
      }
    } catch (resumeError) {
        console.warn('Could not resume audio contexts:', resumeError);
        // Proceed, as getUserMedia might still work or contexts might not need resuming.
    }


    this.updateStatus('Requesting microphone access...');
    this.error = ''; // Clear previous errors

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000, // Request 16kHz
          channelCount: 1,   // Request mono
        },
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096; // Standard buffer size, ensure it's a power of 2
      // Check if createScriptProcessor is available, otherwise log error
      if (typeof this.inputAudioContext.createScriptProcessor === 'function') {
         this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
          bufferSize,
          1,
          1,
        );
      } else if (typeof (this.inputAudioContext as any).createJavaScriptNode === 'function') { // For older Safari
        this.scriptProcessorNode = (this.inputAudioContext as any).createJavaScriptNode(
          bufferSize,
          1,
          1,
        );
      } else {
        this.updateError('ScriptProcessorNode is not supported in this browser.');
        this.stopRecording(); // Stop if we can't process audio
        return;
      }


      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session || !this.isSessionInitialized) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        try {
          this.session.sendRealtimeInput({media: createBlob(pcmData)});
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error('Error sending realtime input:', errorMessage);
          this.updateError(`Error sending audio: ${errorMessage}`);
          // Optionally stop recording or try to re-initialize session
          // this.stopRecording();
        }
      };

      this.inputNode.connect(this.scriptProcessorNode); // Connect GainNode to ScriptProcessor
      // Do NOT connect scriptProcessorNode to destination if you only want to process, not playback input.
      // If input monitoring is desired, then connect it. For now, assuming no direct playback of input.
      this.scriptProcessorNode.connect(this.inputAudioContext.destination); // Often needed for it to process on some browsers


      this.isRecording = true;
      this.updateStatus('🔴 Recording... Say something!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Error starting recording:', errorMessage);
      if (errorMessage.toLowerCase().includes('permission denied') || errorMessage.toLowerCase().includes('not allowed')) {
        this.updateError('Microphone permission denied. Please allow access in your browser settings.');
      } else {
        this.updateError(`Error starting recording: ${errorMessage}`);
      }
      this.stopRecording(); // Clean up if start failed
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
      // No need to update status if nothing was really active
      if (this.isRecording) this.updateStatus('Stopping recording...'); // Should not happen if !isRecording
    } else {
       this.updateStatus('Stopping recording...');
    }


    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null; // Remove handler
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    
    // Only update status if it wasn't an error state that led here
    if (!this.error) {
        this.updateStatus('Recording stopped. Ready to start again.');
    }
  }

  private async reset() {
    this.stopRecording(); // Ensure recording is stopped first
    this.isSessionInitialized = false; // Mark session as not initialized
    this.updateStatus('Resetting session...');
    this.error = ''; // Clear errors

    if (this.session) {
      try {
        await this.session.close();
      } catch (e) {
        console.warn('Error closing existing session during reset:', e);
      }
      this.session = null;
    }
    // Clear any queued audio playback
    for(const source of this.sources.values()) {
        try {
            source.stop();
        } catch (e) {
            // console.warn('Error stopping audio source during reset:', e);
        }
        this.sources.delete(source);
    }
    this.nextStartTime = this.outputAudioContext.currentTime;


    // Re-initialize session
    this.initSession();
  }

  render() {
    return html`
      <div>
        <header class="app-header">K-audioGPT</header>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
        <div class="controls">
          <button
            id="resetButton"
            title="Reset Session"
            aria-label="Reset Session"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="30px" 
              viewBox="0 -960 960 960"
              width="30px"
              fill="currentColor">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            title="Start Recording"
            aria-label="Start Recording"
            @click=${this.startRecording}
            ?disabled=${this.isRecording || !this.isSessionInitialized}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#E53935" /* Brighter Red */
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="48" /> 
            </svg>
          </button>
          <button
            id="stopButton"
            title="Stop Recording"
            aria-label="Stop Recording"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="26px" 
              height="26px"
              fill="#BDBDBD" /* Lighter Gray for stop */
              xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="10" width="80" height="80" rx="12" />
            </svg>
          </button>
        </div>

        <div id="status" role="status" aria-live="polite">
         ${this.error ? html`<strong>Error:</strong> ${this.error}` : this.status}
        </div>
      </div>
    `;
  }
}
/* Ensure LitElement is available if not globally defined by other imports */
declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio': GdmLiveAudio;
  }
}