"use client"

import { useState, useEffect, useRef } from 'react'
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "@/components/ui/use-toast"
import { Badge } from "@/components/ui/badge"

type TranscriptType = 'unrevised' | 'revised' | 'voice'
type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'polling'

interface Transcript {
  type: TranscriptType
  content: string
  timestamp: number
}

export default function TranscriptionSystem() {
  const [inputType, setInputType] = useState<string>('microphone')
  const [isRecording, setIsRecording] = useState(false)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [streamUrl, setStreamUrl] = useState<string>('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null)
  const [isSecure, setIsSecure] = useState(false)

  const audioRef = useRef<HTMLAudioElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const audioSocketRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const maxReconnectAttempts = 5
  const transcriptsEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new transcripts arrive
  useEffect(() => {
    transcriptsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcripts])

  useEffect(() => {
    const protocol = window.location.protocol
    setIsSecure(protocol === 'https:')
    connectWebSocket()

    return () => {
      socketRef.current?.close()
      audioSocketRef.current?.close()
      stopAudioStream()
    }
  }, [])

  const stopAudioStream = () => {
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop())
      setAudioStream(null)
    }
  }

  const connectWebSocket = () => {
    setConnectionStatus('connecting')
    const wsProtocol = isSecure ? 'wss://' : 'ws://'
    const host = window.location.host
    
    // Main WebSocket for transcripts
    const wsUrl = `${wsProtocol}${host}/api/transcription`
    socketRef.current = new WebSocket(wsUrl)

    // Audio WebSocket for TTS
    const audioWsUrl = `${wsProtocol}${host}/api/tts`
    audioSocketRef.current = new WebSocket(audioWsUrl)

    socketRef.current.onopen = () => {
      console.log('WebSocket connection established')
      setConnectionStatus('connected')
      reconnectAttemptsRef.current = 0
      toast({
        title: "Connected",
        description: `Secure ${isSecure ? '(HTTPS)' : '(HTTP)'} connection established`,
      })
    }

    socketRef.current.onmessage = handleTranscriptionMessage
    audioSocketRef.current.onmessage = handleAudioMessage

    socketRef.current.onerror = handleWebSocketError
    audioSocketRef.current.onerror = handleWebSocketError

    socketRef.current.onclose = handleWebSocketClose
    audioSocketRef.current.onclose = handleWebSocketClose
  }

  const handleTranscriptionMessage = async (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data)
      const timestamp = Date.now()
      
      if (data.segments) {
        data.segments.forEach((seg: any) => {
          setTranscripts(prev => [...prev, {
            type: 'unrevised',
            content: seg.text,
            timestamp
          }])
        })
      }
      
      if (data.llm_output) {
        data.llm_output.forEach((out: string) => {
          setTranscripts(prev => [...prev, {
            type: data.eos ? 'voice' : 'revised',
            content: out,
            timestamp
          }])
        })
      }
    } catch (error) {
      console.error('Error parsing transcription message:', error)
    }
  }

  const handleAudioMessage = async (event: MessageEvent) => {
    try {
      if (event.data instanceof Blob) {
        const audioBlob = event.data
        const audioUrl = URL.createObjectURL(audioBlob)
        playAudio(audioUrl)
      }
    } catch (error) {
      console.error('Error handling audio message:', error)
    }
  }

  const handleWebSocketError = (error: Event) => {
    console.error('WebSocket error:', error)
    setConnectionStatus('disconnected')
    toast({
      title: "Connection Error",
      description: "Connection error. Attempting to reconnect...",
      variant: "destructive",
    })
  }

  const handleWebSocketClose = (event: CloseEvent) => {
    console.log('WebSocket connection closed:', event)
    setConnectionStatus('disconnected')
    
    if (reconnectAttemptsRef.current < maxReconnectAttempts) {
      reconnectAttemptsRef.current++
      console.log(`Attempting to reconnect (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`)
      setTimeout(connectWebSocket, 3000)
    } else {
      console.log('Max reconnect attempts reached. Using fallback polling.')
      startPolling()
    }
  }

  const startPolling = () => {
    setConnectionStatus('polling')
    const pollInterval = setInterval(() => {
      if (connectionStatus !== 'connected') {
        fetch('/api/transcripts')
          .then(response => response.json())
          .then(data => {
            const timestamp = Date.now()
            if (data.segments || data.llm_output) {
              handleTranscriptionMessage({ data: JSON.stringify(data) } as MessageEvent)
            }
          })
          .catch(error => {
            console.error('Error polling transcripts:', error)
            toast({
              title: "Polling Error",
              description: "Failed to fetch updates",
              variant: "destructive",
            })
          })
      }
    }, 1000)

    return () => clearInterval(pollInterval)
  }

  const playAudio = async (url: string) => {
    if (audioRef.current) {
      const audio = audioRef.current
      audio.src = url
      try {
        await audio.play()
      } catch (error) {
        console.error('Error playing audio:', error)
        toast({
          title: "Audio Error",
          description: "Failed to play audio output",
          variant: "destructive",
        })
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  }

  const sendMessage = async (message: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(message)
    } else {
      try {
        const response = await fetch('/api/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        })
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
        
        const data = await response.json()
        console.log('Message sent successfully:', data)
      } catch (error) {
        console.error('Error sending message:', error)
        toast({
          title: "Error",
          description: "Failed to send message",
          variant: "destructive",
        })
      }
    }
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setAudioStream(stream)
      setIsRecording(true)
      sendMessage('START_RECORDING')
      
      // Send audio data to server
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(event.data)
        }
      }
      mediaRecorder.start(100) // Send chunks every 100ms
    } catch (error) {
      console.error('Error accessing microphone:', error)
      toast({
        title: "Microphone Error",
        description: "Failed to access microphone",
        variant: "destructive",
      })
    }
  }

  const stopRecording = () => {
    stopAudioStream()
    setIsRecording(false)
    sendMessage('STOP_RECORDING')
  }

  const handleStreamUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStreamUrl(e.target.value)
  }

  const handleStartStreaming = () => {
    if (!streamUrl) {
      toast({
        title: "Error",
        description: "Please enter a stream URL",
        variant: "destructive",
      })
      return
    }
    sendMessage(`START_STREAMING:${streamUrl}`)
  }

  const getConnectionStatusBadge = () => {
    const variants = {
      connected: "success",
      connecting: "warning",
      disconnected: "destructive",
      polling: "secondary"
    }
    return (
      <Badge variant={variants[connectionStatus] as any}>
        {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
        {isSecure && " (HTTPS)"}
      </Badge>
    )
  }

  const getTranscriptColor = (type: TranscriptType) => {
    switch (type) {
      case 'unrevised': return 'bg-yellow-100 dark:bg-yellow-900'
      case 'revised': return 'bg-green-100 dark:bg-green-900'
      case 'voice': return 'bg-blue-100 dark:bg-blue-900'
      default: return 'bg-gray-100 dark:bg-gray-900'
    }
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Transcription System</h1>
      
      <div className="grid gap-4 mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Connection Status</span>
              {getConnectionStatusBadge()}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audio Input</CardTitle>
          </CardHeader>
          <CardContent>
            <Select onValueChange={setInputType} defaultValue={inputType}>
              <SelectTrigger className="w-full mb-4">
                <SelectValue placeholder="Select input type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="microphone">Microphone</SelectItem>
                <SelectItem value="rtsp">RTSP Stream</SelectItem>
                <SelectItem value="hls">HLS Stream</SelectItem>
              </SelectContent>
            </Select>

            {inputType === 'microphone' && (
              <Button 
                onClick={isRecording ? stopRecording : startRecording}
                variant={isRecording ? "destructive" : "default"}
                className="w-full"
              >
                {isRecording ? 'Stop Recording' : 'Start Recording'}
              </Button>
            )}

            {(inputType === 'rtsp' || inputType === 'hls') && (
              <div className="space-y-4">
                <input
                  type="text"
                  placeholder={`Enter ${inputType.toUpperCase()} stream URL`}
                  value={streamUrl}
                  onChange={handleStreamUrlChange}
                  className="w-full p-2 border rounded"
                />
                <Button onClick={handleStartStreaming} className="w-full">
                  Start Streaming
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Transcripts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {transcripts.map((transcript, index) => (
                <div
                  key={`${index}-${transcript.timestamp}`}
                  className={`p-2 rounded ${getTranscriptColor(transcript.type)}`}
                >
                  <div className="text-xs text-gray-500 mb-1">
                    {new Date(transcript.timestamp).toLocaleTimeString()} - {transcript.type}
                  </div>
                  <div>{transcript.content}</div>
                </div>
              ))}
              <div ref={transcriptsEndRef} />
            </div>
          </CardContent>
        </Card>
      </div>

      <audio ref={audioRef} className="hidden" controls />
    </div>
  )
}

