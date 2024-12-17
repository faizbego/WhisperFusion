import { NextResponse } from 'next/server'

export function GET() {
  // This route will be used for WebSocket connections
  // The actual WebSocket handling will be done by the server
  return new NextResponse('WebSocket endpoint', { status: 426 })
}

