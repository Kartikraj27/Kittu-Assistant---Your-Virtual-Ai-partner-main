import { GoogleGenAI } from "@google/genai";
import { processCommand } from "./commandService";

const systemInstruction = `Your name is Kittu. You are an AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, Kartik, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;

export class LiveSessionManager {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Audio playback state
  private playbackContext: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private isPlaying: boolean = false;
  public isMuted: boolean = false;
  
  // Text accumulation for UI chat logs
  private currentKittuResponseText: string = "";
  
  public onStateChange: (state: "idle" | "listening" | "processing" | "speaking") => void = () => {};
  public onMessage: (sender: "user" | "kittu", text: string) => void = () => {};
  public onCommand: (url: string) => void = () => {};

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async start() {
    this.onStateChange("processing");
    
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000 });
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      this.nextPlayTime = this.playbackContext.currentTime;

      // WebSocket session start using proper modern SDK settings
      const session = await this.ai.models.startWebSocketSession({
        model: "gemini-2.5-flash-preview-tts",
        config: {
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Kore" }
              }
            }
          },
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          }
        }
      });

      this.sessionPromise = Promise.resolve(session);
      this.listenToBackend(session);

      // Microphone buffer streaming to backend
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.processor.onaudioprocess = (e) => {
        if (this.isPlaying) return; // Don't record while Kittu is speaking
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = this.floatTo16BitPCM(inputData);
        if (pcmData) {
          session.send({
            realtimeInput: {
              mediaChunks: [{
                mimeType: "audio/pcm;rate=16000",
                data: btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)))
              }]
            }
          });
        }
      };

      this.onStateChange("listening");
    } catch (error) {
      console.error("Live Session failed to initialize:", error);
      this.stop();
      throw error;
    }
  }

  private async listenToBackend(session: any) {
    try {
      for await (const message of session.receive()) {
        // 1. Handle incoming text or audio from model
        if (message.serverContent?.modelTurn?.parts) {
          for (const part of message.serverContent.modelTurn.parts) {
            if (part.text) {
              if (this.currentKittuResponseText === "") {
                this.onStateChange("speaking");
              }
              this.currentKittuResponseText += part.text;
            }
            
            if (part.inlineData && !this.isMuted) {
              this.playAudioChunk(part.inlineData.data);
            }
          }
        }

        // 2. Handle real-time User transcription log updates
        if (message.serverContent?.userTurn?.parts) {
          for (const part of message.serverContent.userTurn.parts) {
            if (part.text) {
              this.onMessage("user", part.text);
              this.onStateChange("processing");
            }
          }
        }

        // 3. Handle Turn Complete event to flush final responses to UI
        if (message.serverContent?.turnComplete) {
          if (this.currentKittuResponseText.trim() !== "") {
            this.onMessage("kittu", this.currentKittuResponseText);
            
            const commandResult = processCommand(this.currentKittuResponseText);
            if (commandResult.isBrowserAction && commandResult.url) {
              this.onCommand(commandResult.url);
            }
            
            this.currentKittuResponseText = "";
          }
          
          if (!this.isPlaying) {
            this.onStateChange("listening");
          }
        }
      }
    } catch (e) {
      console.error("Error reading data from WebSocket stream:", e);
    }
  }

  private playAudioChunk(base64Data: string) {
    if (!this.playbackContext) return;
    
    try {
      this.isPlaying = true;
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const buffer = new Int16Array(bytes.buffer);
      const audioBuffer = this.playbackContext.createBuffer(1, buffer.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0;
      }

      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);

      const currentTime = this.playbackContext.currentTime;
      if (this.nextPlayTime < currentTime) {
        this.nextPlayTime = currentTime;
      }
      
      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;

      source.onended = () => {
        if (this.playbackContext && this.playbackContext.currentTime >= this.nextPlayTime - 0.1) {
          this.isPlaying = false;
          this.onStateChange("listening");
        }
      };
    } catch (e) {
      console.error("Error playing real-time audio chunk", e);
    }
  }

  sendText(text: string) {
    this.sessionPromise?.then(session => {
      session.send({
        clientContent: {
          turns: [{
            role: "user",
            parts: [{ text: text }]
          }],
          turnComplete: true
        }
      });
    }).catch(err => console.error("Failed to send manual text over socket:", err));
  }

  private floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  }

  private stopPlayback() {
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
      this.isPlaying = false;
    }
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.stopPlayback();
    
    if (this.sessionPromise) {
      this.sessionPromise.then(session => session.close()).catch(() => {});
      this.sessionPromise = null;
    }
    
    this.onStateChange("idle");
  }
}
